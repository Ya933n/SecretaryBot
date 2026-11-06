import { api, db } from 'sdk';
import { eq, sql } from 'sdk/db';
import { replies, users_topics, msg_map, app_settings, inbox_notifications, thread_cooldowns } from '../schema.js';
import { sendRichMessage, mirrorMessage, getForwardOriginText } from '../lib/utils.js';

import { OWNER_ID } from '../lib/config.js';

async function acquireLock(lockKey, ttlMs = 15000) {
    const now = Date.now();
    const existing = await db.select().from(app_settings).where(eq(app_settings.key, lockKey)).get();
    if (existing && (now - Number(existing.value)) > ttlMs) {
        await db.delete(app_settings).where(eq(app_settings.key, lockKey)).run();
    }
    const res = await db.run(sql`INSERT OR IGNORE INTO app_settings ("key", value) VALUES (${lockKey}, ${String(now)})`);
    return res.rowsAffected > 0;
}

async function getOrCreateTopic(adminGroupId, userId, topicName, connectionId, forceRecreate = false, brokenThreadId = null) {
    const lockKey = `tlock_${userId}`;
    const gotLock = await acquireLock(lockKey, 15000);

    if (gotLock) {
        try {
            let record = await db.select().from(users_topics).where(eq(users_topics.userId, userId)).get();

            if (forceRecreate && record && record.threadId === brokenThreadId) {
                await db.delete(users_topics).where(eq(users_topics.userId, userId)).run();
                record = null;
            }

            if (record && record.threadId) {
                await db.update(users_topics).set({ connectionId }).where(eq(users_topics.userId, userId)).run();
                return record.threadId;
            }

            const topic = await api.createForumTopic({ chat_id: adminGroupId, name: topicName });
            const newThreadId = topic.message_thread_id;
            const now = Date.now();

            await db.insert(users_topics)
                .values({ userId, threadId: newThreadId, connectionId, lastUpdate: now })
                .onConflictDoUpdate({ target: users_topics.userId, set: { threadId: newThreadId, connectionId, lastUpdate: now } })
                .run();

            return newThreadId;
        } finally {
            await db.delete(app_settings).where(eq(app_settings.key, lockKey)).run();
        }
    } else {
        for (let i = 0; i < 10; i++) {
            await api.getMe();
            const record = await db.select().from(users_topics).where(eq(users_topics.userId, userId)).get();
            if (record && record.threadId && record.threadId !== brokenThreadId) {
                return record.threadId;
            }
        }
        return null;
    }
}

export default async function (business_message) {
    // ======== بداية دالة الفحص (أضف هذا الجزء) ========
    console.log("📩 رسالة جديدة وصلت:", JSON.stringify(business_message, null, 2));

    if (business_message.via_bot || business_message.provider) {
        console.log("🤖 تم التقاط رسالة من سكرتير آخر! اسم البوت:", business_message.via_bot?.first_name || "غير معروف");
    }
    // ====================================================

    const chatId = String(business_message.chat.id);
    const fromId = business_message.from?.id ? String(business_message.from.id) : null;
    const msgId = business_message.message_id;
    // دعم النص العادي أو النص المرفق مع الوسائط (caption)
    const text = (business_message.text || business_message.caption || '').trim();
    const connectionId = business_message.business_connection_id;

    // أزلنا شرط !text لكي نسمح بمرور الصور والملصقات والرسائل الفارغة من النص
    if (!fromId || !connectionId) return;
    

    // 1. فحص اتصال الأعمال: منع أي اتصال ليس اتصالك الشخصي المخزن في الداتابيس (يحجب B نهائياً)
    const sender_id = fromId;
    let keyword = null;

    const connRecord = await db.select().from(app_settings).where(eq(app_settings.key, 'biz_connection')).get();
    if (!connRecord || connRecord.value !== connectionId) return;

    if (sender_id === OWNER_ID) {
        if (text.startsWith('!') || text.startsWith('.')) {
            keyword = text.substring(1).trim();
            
            // 🌟 أضف هذا الجزء هنا لكي يبحث عن الكلمة ويرد ثم يخرج فوراً دون فتح توبيك
            const match = await db.select().from(replies).where(eq(replies.word, keyword)).get();
            if (match) {
                await sendRichMessage(chatId, match, null, msgId, connectionId);
            }
            return; // يمنع إنشاء التوبيك أو إكمال أي كود آخر
            
        } else {
            return;
        }
    }

    // (باقي كود البحث عن الكلمة وإرسال الرد يأتي هنا تحت keyword)

    const msgLockKey = `mlock_${chatId}_${msgId}`;
    if (!(await acquireLock(msgLockKey, 300000))) return;

    const groupRecord = await db.select().from(app_settings).where(eq(app_settings.key, 'admin_group')).get();
    if (!groupRecord) return;
    const ADMIN_GROUP_ID = groupRecord.value;

    const userName = business_message.from?.first_name || 'User';
    const userHandle = business_message.from?.username ? `@${business_message.from.username}` : 'لا يوجد';
    const newTopicName = `${userName} (${fromId})`.substring(0, 127);

    let threadId = await getOrCreateTopic(ADMIN_GROUP_ID, fromId, newTopicName, connectionId, false, null);
    if (!threadId) return;


    // اصطياد الهدايا (Gifts)، الهدايا المطورة (Unique Gifts)، أو دفع النجوم (Stars)
    if (business_message.gift || business_message.unique_gift || business_message.successful_payment) {
        try {
            let alertMsg = "";
            let replyMarkup = null;

            // 1. إذا كانت هدية عادية
            if (business_message.gift) {
                const gift = business_message.gift;
                const stars = gift.star_count || "غير محدد";
                const emoji = (gift.sticker && gift.sticker.emoji) ? gift.sticker.emoji : "🎁";
                
                alertMsg = `🎁 **إشعار نظام - هدية جديدة!**\n\n`;
                alertMsg += `لقد قام هذا المستخدم بإرسال هدية لك (${emoji}).\n`;
                alertMsg += `⭐️ **القيمة:** ${stars} نجمة\n`;

                if (gift.slug && gift.num) {
                    alertMsg += `💎 **اسم ورقم الهدية:** \`${gift.slug}-${gift.num}\`\n`;
                    replyMarkup = { inline_keyboard: [[{ text: "رؤية الهدية 💎", url: `https://t.me/nft/${gift.slug}-${gift.num}` }]] };
                } else if (gift.id) {
                    alertMsg += `🔹 **معرف الهدية (ID):** \`${gift.id}\`\n`;
                }
            } 
            // 2. إذا كانت هدية مطورة منقولة (NFT - Unique Gift) 
            else if (business_message.unique_gift) {
                const uGift = business_message.unique_gift.gift;
                const nftName = uGift.name; // يأتي مدمجاً جاهزاً مثل SpringBasket-30477
                const baseName = uGift.base_name;
                const emoji = uGift.model?.sticker?.emoji || "💎";
                const transferStars = business_message.unique_gift.transfer_star_count || 0;

                alertMsg = `💎 **إشعار نظام - هدية مطورة (NFT) منقولة!**\n\n`;
                alertMsg += `لقد قام هذا المستخدم بنقل هدية مطورة إليك (${emoji}).\n`;
                alertMsg += `🏷 **الاسم:** ${baseName}\n`;
                alertMsg += `⭐️ **تكلفة النقل:** ${transferStars} نجمة\n`;
                alertMsg += `🔗 **المعرف:** \`${nftName}\`\n`;

                // زر الرابط المباشر بناءً على الاسم المدمج
                replyMarkup = { inline_keyboard: [[{ text: "رؤية الهدية المطورة 💎", url: `https://t.me/nft/${nftName}` }]] };
            }
            // 3. إذا كانت عملية دفع مباشر بالنجوم
            else if (business_message.successful_payment) {
                const payment = business_message.successful_payment;
                alertMsg = `⭐️ **إشعار نظام - دفع بالنجوم!**\n\n`;
                alertMsg += `لقد قام هذا المستخدم بتحويل نجوم إليك.\n`;
                alertMsg += `⭐️ **الكمية:** ${payment.total_amount} نجمة\n`;
                alertMsg += `🔹 **المعرف:** \`${payment.telegram_payment_charge_id}\`\n`;
            }

            let sendPayload = {
                chat_id: ADMIN_GROUP_ID,
                message_thread_id: threadId,
                text: alertMsg,
                parse_mode: "Markdown"
            };

            if (replyMarkup) sendPayload.reply_markup = replyMarkup;

            await api.sendMessage(sendPayload);
        } catch (e) {
            console.error("Gift/Star alert error:", e);
        }
        return; // إيقاف الكود لمنع محاولة استنساخ رسائل النظام
    }


    let topicReplyToId = null;
    if (business_message.reply_to_message) {
        const mapRecord = await db.select().from(msg_map).where(eq(msg_map.userMsgId, business_message.reply_to_message.message_id)).get();
        if (mapRecord) topicReplyToId = mapRecord.topicMsgId;
    }

    // إرسال رسالة المستخدم للموضوع بنفس نوعها (بما فيها Rich Message)
    let copiedMsg = null;
    try {
        copiedMsg = await mirrorMessage(business_message, ADMIN_GROUP_ID, {
            threadId: threadId,
            replyToMsgId: topicReplyToId
        });

        if (copiedMsg && Number(copiedMsg.message_thread_id) !== Number(threadId)) {
            try { await api.deleteMessage({ chat_id: ADMIN_GROUP_ID, message_id: copiedMsg.message_id }); } catch (e) {}
            throw new Error('TOPIC_DELETED');
        }
    } catch (error) {
        const errStr = String(error?.description || error?.message || '');
        const isTopicDeleted =
            errStr.includes('TOPIC_DELETED') ||
            errStr.includes('thread not found') ||
            errStr.includes('TOPIC_ID_INVALID') ||
            errStr.includes('message thread not found');

        if (isTopicDeleted) {
            threadId = await getOrCreateTopic(ADMIN_GROUP_ID, fromId, newTopicName, connectionId, true, threadId);
            if (!threadId) return;
            try {
                copiedMsg = await mirrorMessage(business_message, ADMIN_GROUP_ID, {
                    threadId: threadId
                });
            } catch (retryErr) {
                return;
            }
        } else {
            console.error("Mirror message error:", error);
            return;
        }
    }


    if (copiedMsg && copiedMsg.message_id) {
        await db.insert(msg_map)
            .values({ topicMsgId: copiedMsg.message_id, userMsgId: msgId, userId: fromId })
            .onConflictDoUpdate({ target: msg_map.topicMsgId, set: { userMsgId: msgId, userId: fromId } })
            .run();

        // إرسال "تم التحويل من: ..." في موضوع الإدارة فقط إذا كانت الرسالة محولة
        const forwardInfo = getForwardOriginText(business_message);
        if (forwardInfo) {
            try {
                await api.sendMessage({
                    chat_id: ADMIN_GROUP_ID,
                    message_thread_id: threadId,
                    text: forwardInfo,
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                    reply_parameters: { message_id: copiedMsg.message_id, allow_sending_without_reply: true }
                });
            } catch (e) {}
        }
    }

    // تحديث اسم الموضوع كل 24 ساعة
    const now = Date.now();
    const topicRecord = await db.select().from(users_topics).where(eq(users_topics.userId, fromId)).get();
    if (topicRecord && (now - (topicRecord.lastUpdate || 0)) >= 86400000) {
        try { await api.editForumTopic({ chat_id: ADMIN_GROUP_ID, message_thread_id: threadId, name: newTopicName }); } catch (e) {}
        await db.update(users_topics).set({ lastUpdate: now }).where(eq(users_topics.userId, fromId)).run();
    }



    // إرسال إشعار الـ General
    if (await acquireLock(`nlock_${fromId}`, 10000)) {
        const existingNotif = await db.select().from(inbox_notifications).where(eq(inbox_notifications.userId, fromId)).get();
        
        // إذا كان هناك إشعار سابق معلق، نقوم بحذفه من المجموعة لتجديده في الأسفل
        if (existingNotif) {
            try { await api.deleteMessage({ chat_id: ADMIN_GROUP_ID, message_id: existingNotif.notifMsgId }); } catch(e) {}
        }

        const cleanGroupId = ADMIN_GROUP_ID.replace('-100', '');
        const topicLink = `https://t.me/c/${cleanGroupId}/${threadId}`;
        const notifText = `رسالة جديدة 📩\n\n• المعرف: <code>${fromId}</code>\n• الاسم: ${userName}\n• اسم المستخدم: ${userHandle}`;
        const keyboard = { inline_keyboard: [[{ text: "اذهب إلى الدردشة 💬", url: topicLink }], [{ text: "قراءة ✔️", callback_data: `read_${fromId}` }]] };

        try {
            const notifMsg = await api.sendMessage({ chat_id: ADMIN_GROUP_ID, text: notifText, parse_mode: 'HTML', reply_markup: keyboard });
            if (notifMsg) {
                await db.insert(inbox_notifications)
                    .values({ userId: fromId, notifMsgId: notifMsg.message_id })
                    .onConflictDoUpdate({ target: inbox_notifications.userId, set: { notifMsgId: notifMsg.message_id } })
                    .run();
            }
        } catch (e) {}
    }

    // الردود التلقائية (hi) والردود المحفوظة
    let checkText = text.trim();
    if (checkText === '/start') checkText = 'hi';

    const cooldownRecord = await db.select().from(thread_cooldowns).where(eq(thread_cooldowns.userId, fromId)).get();
    let shouldSendHi = false;

    if (checkText.toLowerCase() === 'hi') {
        shouldSendHi = true;
    } else if (!cooldownRecord || (now - cooldownRecord.lastSentAt) >= 7200000) {
        shouldSendHi = true;
    }

    if (shouldSendHi) {
        const hiMatch = await db.select().from(replies).where(eq(replies.word, 'hi')).get();
        if (hiMatch) {
            await db.insert(thread_cooldowns)
                .values({ userId: fromId, lastSentAt: now })
                .onConflictDoUpdate({ target: thread_cooldowns.userId, set: { lastSentAt: now } })
                .run();
            await sendRichMessage(chatId, hiMatch, null, msgId, connectionId);
            await sendRichMessage(ADMIN_GROUP_ID, hiMatch, threadId);
        }
    }

    if (checkText && checkText.toLowerCase() !== 'hi') {
        const match = await db.select().from(replies).where(eq(replies.word, checkText)).get();
        if (match) {
            await sendRichMessage(chatId, match, null, msgId, connectionId);
            await sendRichMessage(ADMIN_GROUP_ID, match, threadId);
        }
    }
}


import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { replies, users_topics, msg_map, app_settings, inbox_notifications, custom_buttons, thread_cooldowns } from '../schema.js';
import { sendRichMessage, parseAndBuildKeyboard, mirrorMessage } from '../lib/utils.js';

import { OWNER_ID } from '../lib/config.js';

export default async function (message) {
    const chatId = String(message.chat.id);
    if (message.chat.type === 'private') {
        if (String(message.from?.id) !== OWNER_ID) await api.sendMessage({ chat_id: chatId, text: "أنا بوت سكرتير أعمال." });
        return;
    }

    const fromId = message.from?.id;
    const msgId = message.message_id;
    // إزالة معرف البوت (إن وجد) من الأوامر لضمان استجابتها داخل المجموعة
    const text = (message.text || '').replace('@Ya933nSecretaryBot', '');

    if (String(fromId) !== OWNER_ID) return;

    if (text === '/setgroup') {
        await db.insert(app_settings).values({ key: 'admin_group', value: chatId }).onConflictDoUpdate({ target: app_settings.key, set: { value: chatId } }).run();

        // بناء قائمة الأوامر وتخصيصها لتظهر في مجموعة الإدارة فقط
        try {
            await api.setMyCommands({
                commands: [
                    { command: 'list', description: 'عرض جميع الردود المحفوظة' },
                    { command: 'add', description: 'إضافة رد جديد (بالرد على رسالة)' },
                    { command: 'del', description: 'حذف رد محفوظ' },
                    { command: 'btns', description: 'عرض قائمة الأزرار المحفوظة' },
                    { command: 'btn', description: 'إضافة أو معاينة أو حذف زر' }
                ],
                // هذا السطر السحري يفعل الأوامر داخل هذه المجموعة المحددة فقط!
                scope: { type: 'chat', chat_id: chatId }
            });
        } catch (err) {
            console.error("Error setting commands:", err);
        }

        await api.sendMessage({ chat_id: chatId, text: "✅ تم التعيين كمجموعة إدارة، وتم إعداد قائمة الأوامر (Menu) للبوت تلقائياً!" });
        return;
    }


    const groupRecord = await db.select().from(app_settings).where(eq(app_settings.key, 'admin_group')).get();
    if (!groupRecord || groupRecord.value !== chatId) return;
    const threadId = message.message_thread_id;

    // إدارة الأزرار (/btns و /btn)
    if (text.startsWith('/btns')) {
        const allBtns = await db.select().from(custom_buttons).all();
        if (allBtns.length === 0) { await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: 'لا توجد أزرار.' }); return; }
        const listText = allBtns.map(b => `• <code>${b.btnId}</code> : ${b.name} (${b.btnType})`).join('\n');
        await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: `🎛 الأزرار المحفوظة:\n${listText}`, parse_mode: 'HTML' });
        return;
    }

    if (text.startsWith('/btn')) {
        const btnArgs = text.substring(4).trim();
        if (btnArgs.startsWith('-')) {
            const delId = btnArgs.substring(1).trim();
            await db.delete(custom_buttons).where(eq(custom_buttons.btnId, delId)).run();
            await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: `✅ تم حذف الزر: ${delId}` });
        } else if (!btnArgs.includes('-')) {
            const previewId = btnArgs;
            const b = await db.select().from(custom_buttons).where(eq(custom_buttons.btnId, previewId)).get();
            if (!b) { await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: `⚠️ الزر غير موجود.` }); return; }

            const infoText = `🎛 معلومات الزر:\n\n` +
                             `• ايدي الزر: <code>${b.btnId}</code>\n` +
                             `• نوع الزر: ${b.btnType}\n` +
                             `• اسم الزر: ${b.name}\n` +
                             `• محتوى الزر: ${b.content}\n` +
                             `• لون الزر: ${b.color}\n` +
                             `• ايدي الايموجي: ${b.emojiId}`;

            const { replyMarkup } = await parseAndBuildKeyboard(`معاينة\n{{${previewId}}}`);
            await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: infoText, parse_mode: 'HTML', reply_markup: replyMarkup });
        } else {
            const match = btnArgs.match(/^([A-Za-z0-9_]+)\s*-\s*(.+?)\s*-\s*(url|copy|callback_data|cb)\s*-\s*(.+?)\s*-\s*(r|b|g|n)(?:\s*-\s*(.*))?$/i);
            if (match) {
                const [_, btnId, name, btnType, content, color, emojiId = 'null'] = match;
                const finalType = btnType.toLowerCase() === 'cb' ? 'callback_data' : btnType.toLowerCase();
                await db.insert(custom_buttons).values({ btnId, name, btnType: finalType, content, color: color.toLowerCase(), emojiId })
                      .onConflictDoUpdate({ target: custom_buttons.btnId, set: { name, btnType: finalType, content, color: color.toLowerCase(), emojiId } }).run();
                await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: `✅ تم حفظ الزر: ${btnId}` });
            } else {
                await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: `⚠️ خطأ في التنسيق!` });
            }
        }
        return;
    }

    // أوامر الردود (/add يحفظ الرسائل الغنية الجاهزة والوسائط والنصوص)
    if (text.startsWith('/add ') && message.reply_to_message) {
        let word = text.substring(5).trim();
        const replyTo = message.reply_to_message;

        // دعم كتابة {{1,2}} مع أمر /add مباشرة في حال الرغبة بإرفاق أزرار لرسالة غنية جاهزة
        let extraBtns = '';
        const btnInCmd = word.match(/(\{\{[A-Za-z0-9_,|\s]+\}\})\s*$/);
        if (btnInCmd) {
            extraBtns = ' ' + btnInCmd[1];
            word = word.replace(btnInCmd[0], '').trim();
        }

        let content = (replyTo.text || replyTo.caption || '') + extraBtns;
        let fileId = null, fileType = 'text', entities = replyTo.entities || replyTo.caption_entities || null;

        if (replyTo.rich_message) {
            fileType = 'rich';
            entities = {
                rich_message: replyTo.rich_message,
                reply_markup: replyTo.reply_markup || null
            };
        } else if (replyTo.photo) { fileId = replyTo.photo[replyTo.photo.length - 1].file_id; fileType = 'photo'; }
        else if (replyTo.video) { fileId = replyTo.video.file_id; fileType = 'video'; }
        else if (replyTo.document) { fileId = replyTo.document.file_id; fileType = 'document'; }
        else if (replyTo.voice) { fileId = replyTo.voice.file_id; fileType = 'voice'; }
        else if (replyTo.animation) { fileId = replyTo.animation.file_id; fileType = 'animation'; }

        await db.insert(replies).values({ word, content, fileId, fileType, entities }).onConflictDoUpdate({ target: replies.word, set: { content, fileId, fileType, entities } }).run();
        await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: `✅ تم حفظ الرد: ${word}` });
        return;
    }

    if (text.startsWith('/del ')) {
        const word = text.substring(5).trim();
        await db.delete(replies).where(eq(replies.word, word)).run();
        await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: `✅ تم الحذف.` });
        return;
    }

    if (text === '/list') {
        const allReps = await db.select().from(replies).all();
        if (allReps.length === 0) { await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: 'لا توجد ردود محفوظة.' }); return; }
        const listText = allReps.map(r => `• <code>${r.word}</code> (${r.fileType || 'text'})`).join('\n');
        await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: `💬 الردود المحفوظة:\n${listText}`, parse_mode: 'HTML' });
        return;
    }


    let targetUserId = null;
    let topicConnId = null;
    if (threadId) {
        const topicRecord = await db.select().from(users_topics).where(eq(users_topics.threadId, threadId)).get();
        if (topicRecord) {
            targetUserId = topicRecord.userId;
            topicConnId = topicRecord.connectionId;
        }
    }


    // سحب اتصال الأعمال المحمي الخاص بالمالك (أو المسجل في الموضوع كاحتياط)
    let bizConnectionId = topicConnId;
    const bizRecord = await db.select().from(app_settings).where(eq(app_settings.key, 'biz_connection')).get();
    if (bizRecord) bizConnectionId = bizRecord.value;


    // ===================================
    // نظام حذف الرسائل من الطرفين (بالرد بكلمة: حذف أو دليت)
    // ===================================
    if (['حذف', 'دليت', '/delmsg'].includes(text) && message.reply_to_message) {
        const replyMsgId = message.reply_to_message.message_id;
        const mapRecord = await db.select().from(msg_map).where(eq(msg_map.topicMsgId, replyMsgId)).get();

        if (mapRecord) {
            // 1. حذف الرسالة من خاص المستخدم للطرفين
            try {
                await api.deleteBusinessMessages({
                    business_connection_id: bizConnectionId,
                    message_ids: [Number(mapRecord.userMsgId)]
                });
            } catch (e) {
                try {
                    await api.deleteMessage({
                        chat_id: mapRecord.userId,
                        message_id: Number(mapRecord.userMsgId)
                    });
                } catch (err) {}
            }
            await db.delete(msg_map).where(eq(msg_map.topicMsgId, replyMsgId)).run();
        }

        // 2. حذف الرسالة الأصلية ورسالة الأمر من موضوع المجموعة
        try { await api.deleteMessage({ chat_id: chatId, message_id: replyMsgId }); } catch (e) {}
        try { await api.deleteMessage({ chat_id: chatId, message_id: msgId }); } catch (e) {}
        return;
    }



    // ===================================
    // نظام التذكيرات الشامل (يدعم Rich Message والاسم الحقيقي)
    // ===================================
    if (['تذكير', 'لاحقا', 'مهم'].includes(text) && message.reply_to_message) {
        let topicNameMap = {
            'تذكير': '🔔 التذكيرات',
            'لاحقا': '⏳ لاحقا',
            'مهم': '⭐ مهم'
        };

        let targetTopicTitle = topicNameMap[text];
        let reminderThreadId = null;

        const remRecord = await db.select().from(app_settings).where(eq(app_settings.key, `rem_topic_${text}`)).get();
        if (!remRecord) {
            const newTopic = await api.createForumTopic({ chat_id: chatId, name: targetTopicTitle });
            reminderThreadId = newTopic.message_thread_id;
            await db.insert(app_settings).values({ key: `rem_topic_${text}`, value: String(reminderThreadId) }).run();
        } else {
            reminderThreadId = Number(remRecord.value);
        }

        const cleanGroupId = chatId.replace('-100', '');
        const replyTo = message.reply_to_message;
        const realUserId = targetUserId || replyTo.from?.id || "مستخدم";


        // جلب اسم المستخدم الحقيقي المرتبط بهذا الموضوع حصراً (وليس البوت)
        let displayUserName = "مستخدم";
        try {
            if (targetUserId) {
                // محاولة جلب معلومات المستخدم من حساب الأعمال أو من تليجرام مباشرة
                const chatInfo = await api.getChat({ chat_id: targetUserId });
                if (chatInfo && chatInfo.first_name) {
                    displayUserName = chatInfo.first_name;
                }
            }
        } catch (e) {}

        const keyboard = {
            inline_keyboard: [
                [
                    { text: `${realUserId}`, copy_text: { text: String(realUserId) } },
                    { text: `${displayUserName}`, callback_data: "noop" } // زر اسم المستخدم الحقيقي
                ],
                [{ text: "اذهب إلى الدردشة 💬", url: `https://t.me/c/${cleanGroupId}/${threadId}` }],
                [{ text: "حذف التذكير 🗑", callback_data: `delrem` }]
            ]
        };

        // الطريقة المضمونة لإرسال الرسالة (سواء كانت Rich Message أو نص/وسائط) مع الأزرار الثلاثة:
        try {
            const sendParams = {
                chat_id: chatId,
                message_thread_id: reminderThreadId,
                reply_markup: keyboard
            };

            if (replyTo.rich_message) {
                sendParams.rich_message = {
                    blocks: replyTo.rich_message.blocks,
                    is_rtl: replyTo.rich_message.is_rtl ?? true
                };
                await api.sendRichMessage(sendParams);
            } else if (replyTo.text) {
                await api.sendMessage({ ...sendParams, text: replyTo.text, entities: replyTo.entities });
            } else if (replyTo.photo) {
                await api.sendPhoto({ ...sendParams, photo: replyTo.photo[replyTo.photo.length - 1].file_id, caption: replyTo.caption });
            } else if (replyTo.video) {
                await api.sendVideo({ ...sendParams, video: replyTo.video.file_id, caption: replyTo.caption });
            } else if (replyTo.document) {
                await api.sendDocument({ ...sendParams, document: replyTo.document.file_id, caption: replyTo.caption });
            } else if (replyTo.voice) {
                await api.sendVoice({ ...sendParams, voice: replyTo.voice.file_id, caption: replyTo.caption });
            } else if (replyTo.sticker) {
                await api.sendSticker({ ...sendParams, sticker: replyTo.sticker.file_id });
            }

            await api.deleteMessage({ chat_id: chatId, message_id: msgId });
        } catch (err) {
            console.error("Reminder error:", err);
        }
        return;
    }

    let userReplyToId = null;
    if (message.reply_to_message) {
        const mapRecord = await db.select().from(msg_map).where(eq(msg_map.topicMsgId, message.reply_to_message.message_id)).get();
        if (mapRecord) userReplyToId = mapRecord.userMsgId;
    }
    // أمر قراءة سريع من داخل الموضوع (يعمل كزر قراءة ✔️)
    if (text === '!تم' || text === '.تم') {
        if (targetUserId) {
            // استدعاء دالة التنظيف وتعيين الرسائل كمقروءة للطرفين
            await clearInboxNotification(targetUserId, chatId, bizConnectionId, null);
            
            // حذف رسالتك (!تم) ليبقى الموضوع نظيفاً
            try { await api.deleteMessage({ chat_id: chatId, message_id: msgId }); } catch(e) {}
        }
        return; // إيقاف التنفيذ هنا
    }



    // الردود السريعة (! أو .)
    if (text.startsWith('!') || text.startsWith('.')) {
        const triggerWord = text.substring(1).trim();
        const match = await db.select().from(replies).where(eq(replies.word, triggerWord)).get();
        if (match) {
            if (targetUserId) {
                await sendRichMessage(targetUserId, match, null, userReplyToId, bizConnectionId);
                await sendRichMessage(chatId, match, threadId, message.reply_to_message?.message_id);
                await clearInboxNotification(targetUserId, chatId);
                await db.insert(thread_cooldowns).values({ userId: targetUserId, lastSentAt: Date.now() }).onConflictDoUpdate({ target: thread_cooldowns.userId, set: { lastSentAt: Date.now() } }).run();
            } else {
                await api.sendMessage({ chat_id: chatId, message_thread_id: threadId, text: `⚠️ لا يمكن الإرسال هنا. يرجى استخدام هذا الأمر داخل موضوع المستخدم.` });
            }
            return;
        }
    }
    // إرسال رسالتك اليدوية للمستخدم بنفس نوعها (Rich Message أو نص أو وسائط)
    if (targetUserId && !text.startsWith('/')) {
        try {
            let sentMsg = null;
            sentMsg = await mirrorMessage(message, targetUserId, {
                replyToMsgId: userReplyToId,
                bizConnectionId: bizConnectionId,
                parseButtons: true
            });

            if (sentMsg && sentMsg.message_id) {
                await db.insert(msg_map)
                    .values({ topicMsgId: msgId, userMsgId: sentMsg.message_id, userId: targetUserId })
                    .onConflictDoUpdate({ target: msg_map.topicMsgId, set: { userMsgId: sentMsg.message_id, userId: targetUserId } })
                    .run();
            }
            await clearInboxNotification(targetUserId, chatId, bizConnectionId, userReplyToId);
            await db.insert(thread_cooldowns).values({ userId: targetUserId, lastSentAt: Date.now() }).onConflictDoUpdate({ target: thread_cooldowns.userId, set: { lastSentAt: Date.now() } }).run();
        } catch (err) {
            console.error("Send to user error:", err);
        }
    }
}



async function clearInboxNotification(userId, adminGroupId, bizConnectionId = null, userReplyToId = null) {
    const notif = await db.select().from(inbox_notifications).where(eq(inbox_notifications.userId, userId)).get();
    if (notif) {
        try { await api.deleteMessage({ chat_id: adminGroupId, message_id: notif.notifMsgId }); } catch (e) {}
        await db.delete(inbox_notifications).where(eq(inbox_notifications.userId, userId)).run();
    }

    // تعيين رسائل المستخدم كمقروءة فعلياً في واجهة تيليجرام للطرفين (إذا تم تمرير bizConnectionId)
    if (bizConnectionId) {
        try {
            let msgToRead = userReplyToId;
            if (!msgToRead) {
                const userMsgs = await db.select().from(msg_map).where(eq(msg_map.userId, String(userId))).all();
                if (userMsgs && userMsgs.length > 0) {
                    const maxMsg = userMsgs.reduce((prev, current) => (Number(prev.userMsgId) > Number(current.userMsgId)) ? prev : current);
                    msgToRead = maxMsg.userMsgId;
                }
            }
            
            if (msgToRead) {
                await api.readBusinessMessage({
                    business_connection_id: bizConnectionId,
                    chat_id: String(userId),
                    message_id: Number(msgToRead)
                });
            }
        } catch (e) {
            console.error("Failed to mark as read:", e);
        }
    }
}

//async function clearInboxNotification(userId, adminGroupId) {
  //  const notif = await db.select().from(inbox_notifications).where(eq(inbox_notifications.userId, userId)).get();
    //if (notif) {
      //  try { await api.deleteMessage({ chat_id: adminGroupId, message_id: notif.notifMsgId }); } catch (e) {}
        //await db.delete(inbox_notifications).where(eq(inbox_notifications.userId, userId)).run();
    //}
//}

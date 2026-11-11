import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { msg_map, users_topics, app_settings } from '../schema.js';

export default async function (deleted_business_messages) {
    const deletedIds = deleted_business_messages.message_ids || [];
    const userChatId = deleted_business_messages.chat?.id ? String(deleted_business_messages.chat.id) : null;

    // تجاهل الحدث إذا كان الحذف في محادثة غير صالحة
    if (!deletedIds.length) return;

    const groupRecord = await db.select().from(app_settings).where(eq(app_settings.key, 'admin_group')).get();
    if (!groupRecord) return;
    const adminGroupId = groupRecord.value;

    // ==============================================================
    // 🌟 ميزة اكتشاف مسح المحادثة أو الحذف المتعدد (لمنع الـ Spam)
    // ==============================================================
    if (deletedIds.length > 4 && userChatId) {
        const topicRecord = await db.select().from(users_topics).where(eq(users_topics.userId, userChatId)).get();
        if (topicRecord) {
            try {
                await api.sendMessage({
                    chat_id: adminGroupId,
                    message_thread_id: topicRecord.threadId,
                    text: `🧹 <b>تنبيه:</b> يبدو أن المستخدم قام بمسح سجل المحادثة أو حذف عدد كبير من الرسائل دفعة واحدة (${deletedIds.length} رسالة).`,
                    parse_mode: 'HTML'
                });
            } catch (e) {
                console.error("Clear history notification error:", e);
            }
        }
        return; // الخروج فوراً لمنع إرسال تنبيه فردي لكل رسالة محذوفة
    }

    // ==============================================================
    // معالجة الحذف الفردي (أو أقل من 5 رسائل)
    // ==============================================================
    for (const rawMsgId of deletedIds) {
        const msgId = Number(rawMsgId);

        // 1. البحث عن الرسالة في جدول الربط (مع محاولة ثانية إذا حُذفت الرسالة بسرعة)
        let mapRecord = await db.select().from(msg_map).where(eq(msg_map.userMsgId, msgId)).get();
        if (!mapRecord) {
            await api.getMe(); // انتظار قصير ريثما يكتمل حفظ الرسالة
            mapRecord = await db.select().from(msg_map).where(eq(msg_map.userMsgId, msgId)).get();
        }

        if (mapRecord) {
            const topicRecord = await db.select().from(users_topics).where(eq(users_topics.userId, String(mapRecord.userId))).get();
            if (topicRecord) {
                try {
                    await api.sendMessage({
                        chat_id: adminGroupId,
                        message_thread_id: topicRecord.threadId,
                        text: '<tg-emoji emoji-id="5445267414562389170">🗑</tg-emoji> قام المستخدم بحذف هذه الرسالة.'
                        parse_mode: 'HTML', // السطر الذي تم إضافته
                        reply_parameters: {
                            message_id: Number(mapRecord.topicMsgId),
                            allow_sending_without_reply: true
                        }
                    });
                } catch (e) {}
            }
            continue;
        }

/*
        // 2. خطة بديلة شاملة إذا لم تكن الرسالة مسجلة
        if (userChatId) {
            const topicRecord = await db.select().from(users_topics).where(eq(users_topics.userId, userChatId)).get();
            if (topicRecord) {
                try {
                    await api.sendMessage({
                        chat_id: adminGroupId,
                        message_thread_id: topicRecord.threadId,
                        text: "🗑 قام المستخدم بحذف رسالة غير مرتبطة."
                    });
                } catch (e) {}
            }
        }*/
    }
}


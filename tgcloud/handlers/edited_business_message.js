import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { msg_map, users_topics, app_settings } from '../schema.js';
import { mirrorMessage } from '../lib/utils.js';

import { OWNER_ID } from '../lib/config.js';

export default async function (edited_business_message) {
    const fromId = edited_business_message.from?.id ? String(edited_business_message.from.id) : null;
    const userId = String(edited_business_message.chat.id);
    const userMsgId = edited_business_message.message_id;

    // 1. إذا كنت أنت (المالك) من عدّل رسالته في الخاص، لا ترسل تنبيهاً للمستخدم
    if (!fromId || fromId === OWNER_ID) return;

    const topicRecord = await db.select().from(users_topics).where(eq(users_topics.userId, userId)).get();
    if (!topicRecord) return;

    const groupRecord = await db.select().from(app_settings).where(eq(app_settings.key, 'admin_group')).get();
    if (!groupRecord) return;

    const adminGroupId = groupRecord.value;
    const threadId = topicRecord.threadId;

    // البحث عن الرسالة الأصلية في الموضوع للرد عليها
    const mapRecord = await db.select().from(msg_map).where(eq(msg_map.userMsgId, userMsgId)).get();
    const replyToTopicMsgId = mapRecord ? mapRecord.topicMsgId : null;

    try {
        // أ. إرسال تنبيه في الموضوع مع الرد على الرسالة القديمة
        const alertMsg = await api.sendMessage({
            chat_id: adminGroupId,
            message_thread_id: threadId,
            text: '<tg-emoji emoji-id="5395444784611480792">✏️</tg-emoji> قام المستخدم بتعديل هذه الرسالة إلى:',
            parse_mode: 'HTML',
            reply_parameters: replyToTopicMsgId ? { message_id: replyToTopicMsgId, allow_sending_without_reply: true } : undefined
        });

        // ب. إرسال النسخة الجديدة بعد التعديل (نص، وسائط، أو رسالة غنية)
        const newCopiedMsg = await mirrorMessage(edited_business_message, adminGroupId, {
            threadId: threadId,
            replyToMsgId: alertMsg ? alertMsg.message_id : replyToTopicMsgId
        });

        // تحديث الربط في قاعدة البيانات في حال قام بحذفها أو تعديلها مرة أخرى
        if (newCopiedMsg && newCopiedMsg.message_id && !mapRecord) {
            await db.insert(msg_map)
                .values({ topicMsgId: newCopiedMsg.message_id, userMsgId: userMsgId, userId: userId })
                .onConflictDoUpdate({ target: msg_map.topicMsgId, set: { userMsgId: userMsgId, userId: userId } })
                .run();
        }
    } catch (err) {
        console.error("Edit business message error:", err);
    }
}


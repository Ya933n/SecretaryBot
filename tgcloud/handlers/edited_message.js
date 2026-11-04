import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { msg_map, users_topics, app_settings } from '../schema.js';

export default async function (edited_message) {
    const chatType = edited_message.chat.type;

    // ==========================================
    // 1. إذا قام المستخدم بتعديل رسالته في (الخاص)
    // ==========================================
    if (chatType === 'private') {
        const userId = edited_message.chat.id;
        const userMsgId = edited_message.message_id;

        // أ. تنبيه المستخدم في الخاص
        try {
            await api.sendMessage({
                chat_id: userId,
                text: "⚠️ تنبيه: التعديلات التي تود إجراها على رسالتك لا تظهر لدى الإدارة. يرجى إرسال رسالة جديدة.",
                reply_parameters: { message_id: userMsgId, allow_sending_without_reply: true }
            });
        } catch (e) {}

        // ب. إرسال تنبيه للإدارة (رد على رسالة المستخدم داخل موضوعه)
        try {
            const topicRecord = await db.select().from(users_topics).where(eq(users_topics.userId, userId)).get();
            if (topicRecord) {
                const threadId = topicRecord.threadId;
                
                // البحث عن رسالة الإدارة المرتبطة برسالة المستخدم المعدلة
                const mapRecord = await db.select().from(msg_map).where(eq(msg_map.userMsgId, userMsgId)).get();
                
                const groupRecord = await db.select().from(app_settings).where(eq(app_settings.key, 'admin_group')).get();
                if (groupRecord) {
                    const adminGroupId = groupRecord.value;
                    const sendParams = {
                        chat_id: adminGroupId,
                        message_thread_id: threadId,
                        text: "⚠️ حاول المستخدم تعديل الرسالة السابقة."
                    };

                    // إذا وجدنا ربط الرسالة، نرد عليها (Reply)، وإلا نرسلها في الموضوع
                    if (mapRecord) {
                        sendParams.reply_parameters = { message_id: mapRecord.topicMsgId, allow_sending_without_reply: true };
                    }

                    await api.sendMessage(sendParams);
                }
            }
        } catch (err) {}
        
        return;
    }

    // ==========================================
    // 2. إذا قمت أنت (الآدمن) بتعديل رسالتك في (المجموعة)
    // ==========================================
    const topicMsgId = edited_message.message_id;
    const mapRecord = await db.select().from(msg_map).where(eq(msg_map.topicMsgId, topicMsgId)).get();
    if (!mapRecord) return;

    let bizConnectionId = null;
    const topicRecord = await db.select().from(users_topics).where(eq(users_topics.userId, mapRecord.userId)).get();
    if (topicRecord) bizConnectionId = topicRecord.connectionId;

    try {
        const editParams = {
            chat_id: mapRecord.userId,
            message_id: mapRecord.userMsgId,
            is_rtl: true
        };
        if (bizConnectionId) editParams.business_connection_id = bizConnectionId;

        if (edited_message.text) {
            editParams.text = edited_message.text;
            editParams.entities = edited_message.entities;
            await api.editMessageText(editParams);
        } else if (edited_message.caption) {
            editParams.caption = edited_message.caption;
            editParams.caption_entities = edited_message.caption_entities;
            await api.editMessageCaption(editParams);
        }
    } catch (error) {}
}


import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { msg_map, users_topics } from '../schema.js';

export default async function (edited_message) {
    // 1. تجاهل أي تعديل يحصل في الخاص (لا تنبيه للمستخدم ولا للإدارة)
    if (edited_message.chat.type === 'private') {
        return;
    }

    // 2. إذا قمت أنت (الآدمن) بتعديل رسالتك في (المجموعة)، اعكس التعديل للعميل
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

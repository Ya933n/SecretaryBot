import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { inbox_notifications, custom_buttons, replies, users_topics, msg_map, app_settings } from '../schema.js';
import { sendRichMessage } from '../lib/utils.js';

export default async function (callback_query) {
    const data = callback_query.data;
    const msgId = callback_query.message?.message_id;
    const chatId = callback_query.message?.chat.id;
    const queryId = callback_query.id;

    if (data.startsWith('read_')) {
        const userId = data.split('_')[1];
        
        try { await api.deleteMessage({ chat_id: chatId, message_id: msgId }); } catch(e) {}
        try {
            await db.delete(inbox_notifications).where(eq(inbox_notifications.userId, Number(userId))).run();
            await db.delete(inbox_notifications).where(eq(inbox_notifications.userId, String(userId))).run();
        } catch(e) {}

        // إجبار تيليجرام على مسح الدائرة وتعيين رسائل المستخدم كمقروءة
        try {
            const topicRecord = await db.select().from(users_topics).where(eq(users_topics.userId, String(userId))).get();
            let bizId = topicRecord ? topicRecord.connectionId : null;
            
            if (!bizId) {
                const bizRecord = await db.select().from(app_settings).where(eq(app_settings.key, 'biz_connection')).get();
                if (bizRecord) bizId = bizRecord.value;
            }

            if (bizId) {
                const userMsgs = await db.select().from(msg_map).where(eq(msg_map.userId, String(userId))).all();
                if (userMsgs && userMsgs.length > 0) {
                    const maxMsg = userMsgs.reduce((prev, current) => (Number(prev.userMsgId) > Number(current.userMsgId)) ? prev : current);
                    await api.readBusinessMessage({
                        business_connection_id: bizId,
                        chat_id: String(userId),
                        message_id: Number(maxMsg.userMsgId)
                    });
                }
            }
        } catch(e) {
            console.error("Mark as read via button failed:", e);
        }

        try { await api.answerCallbackQuery({ callback_query_id: queryId, text: "تم وضع علامة مقروء للطرفين ✔️" }); } catch (e) {}
        return;
    }

    
    if (data === 'delrem') {
        try { await api.deleteMessage({ chat_id: chatId, message_id: msgId }); } catch(e){}
        await api.answerCallbackQuery({ callback_query_id: queryId, text: "تم حذف التذكير بنجاح 🗑" });
    }

    // *** معالجة أزرار الردود في الخاص والمجموعة بدقة ***
    if (data.startsWith('brep_')) {
        const btnId = data.substring(5);
        const btnRecord = await db.select().from(custom_buttons).where(eq(custom_buttons.btnId, btnId)).get();
        
        if (btnRecord) {
            const targetWord = btnRecord.content; 
            const match = await db.select().from(replies).where(eq(replies.word, targetWord)).get();
            
            if (match) {
                // جلب مسار اتصال الأعمال (connectionId) الخاص بهذا المستخدم إن وجد
                let cbBizId = null;
                const userTopicRec = await db.select().from(users_topics).where(eq(users_topics.userId, Number(chatId))).get();
                if (userTopicRec) {
                    cbBizId = userTopicRec.connectionId;
                }

                // إرسال الرد مع تمرير اتصال الأعمال ليعمل في الخاص بامتياز
                await sendRichMessage(chatId, match, null, null, cbBizId);
                
                // إيقاف إشارة التحميل
                await api.answerCallbackQuery({ callback_query_id: queryId, text: "تم تنفيذ الطلب بنجاح ✓" });

                // تعديل الرسالة وإزالة الأزرار لمنع الـ Spam (مع دعم الرسائل الغنية والنصوص)
                try {
                    const msgObj = callback_query.message;
                    if (msgObj && msgObj.rich_message) {
                        // إذا كانت الرسالة غنية (Rich Message)
                        const updatedRich = JSON.parse(JSON.stringify(msgObj.rich_message));
                        await api.editMessageText({
                            chat_id: chatId,
                            message_id: msgId,
                            rich_message: updatedRich,
                            reply_markup: { inline_keyboard: [] }
                        });
                    } else if (msgObj && msgObj.caption) {
                        // إذا كانت صورة أو وسائط مع تعليق
                        await api.editMessageCaption({
                            chat_id: chatId,
                            message_id: msgId,
                            caption: msgObj.caption + "\n\n<i>(تم التنفيذ)</i>",
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: [] }
                        });
                    } else {
                        // نص عادي
                        const originalText = msgObj?.text || "";
                        await api.editMessageText({
                            chat_id: chatId,
                            message_id: msgId,
                            text: originalText + "\n\n<i>(تم التنفيذ)</i>",
                            parse_mode: 'HTML',
                            reply_markup: { inline_keyboard: [] }
                        });
                    }
                } catch (editErr) {
                    console.error("Edit message markup error:", editErr);
                }

            } else {
                await api.answerCallbackQuery({ callback_query_id: queryId, text: "⚠️ الرد المرتبط غير موجود!", show_alert: true });
            }
        } else {
            await api.answerCallbackQuery({ callback_query_id: queryId, text: "⚠️ هذا الزر لم يعد متوفراً!", show_alert: true });
        }
    }
}


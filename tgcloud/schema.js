import { table, integer, text, json } from 'sdk/db';

export const replies = table('replies', {
    word: text('word').primaryKey(),
    content: text('content').notNull(),
    fileId: text('file_id'),
    fileType: text('file_type'),
    entities: json('entities')
});

export const users_topics = table('users_topics', {
    userId: integer('user_id').primaryKey(),
    threadId: integer('thread_id').notNull(),
    connectionId: text('connection_id'),
    lastUpdate: integer('last_update')
});

export const msg_map = table('msg_map', {
    topicMsgId: integer('topic_msg_id').primaryKey(),
    userMsgId: integer('user_msg_id').notNull(),
    userId: integer('user_id').notNull()
});

export const app_settings = table('app_settings', {
    key: text('key').primaryKey(),
    value: text('value').notNull()
});

export const inbox_notifications = table('inbox_notifications', {
    userId: integer('user_id').primaryKey(),
    notifMsgId: integer('notif_msg_id').notNull()
});

export const custom_buttons = table('custom_buttons', {
    btnId: text('btn_id').primaryKey(),
    name: text('name').notNull(),
    btnType: text('btn_type').notNull(),
    content: text('content'),
    color: text('color'),
    emojiId: text('emoji_id')
});

// === الجدول المعاد: نظام التبريد لمنع تكرار الرد ===
export const thread_cooldowns = table('thread_cooldowns', {
    userId: integer('user_id').primaryKey(),
    lastSentAt: integer('last_sent_at').notNull()
});


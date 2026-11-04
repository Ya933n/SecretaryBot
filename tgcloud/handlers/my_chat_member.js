import { api } from 'sdk';

import { OWNER_ID } from '../lib/config.js';

export default async function (myChatMember) {
    const chat = myChatMember.chat;
    const from = myChatMember.from;
    const newStatus = myChatMember.new_chat_member.status;

    if ((chat.type === 'group' || chat.type === 'supergroup') && (newStatus === 'member' || newStatus === 'administrator')) {
        if (String(from.id) !== OWNER_ID) {
            await api.leaveChat({ chat_id: chat.id });
        }
    }
}


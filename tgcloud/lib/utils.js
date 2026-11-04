import { api, db } from 'sdk';
import { eq } from 'sdk/db';
import { custom_buttons } from '../schema.js';

function escapeHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function trimEntities(entities, maxLen) {
    if (!Array.isArray(entities)) return undefined;
    return entities
        .filter(e => e.offset < maxLen)
        .map(e => (e.offset + e.length > maxLen ? { ...e, length: maxLen - e.offset } : e));
}

// 1. محرك استخراج وبناء الأزرار {{1,2|3}}
export async function parseAndBuildKeyboard(text) {
    let cleanText = text || '';
    let replyMarkup = null;

    const btnRegex = /\{\{([A-Za-z0-9_,|\s]+)\}\}/;
    const match = cleanText.match(btnRegex);
    if (match) {
        cleanText = cleanText.replace(match[0], '').trim();
        const layoutStr = match[1].replace(/\s/g, '');
        const rows = layoutStr.split('|');
        const inline_keyboard = [];

        for (const row of rows) {
            if (!row) continue;
            const btnIds = row.split(',');
            const kbRow = [];

            for (const id of btnIds) {
                if (!id) continue;
                const btnRecord = await db.select().from(custom_buttons).where(eq(custom_buttons.btnId, id)).get();
                if (btnRecord) {
                    let btnObj = { text: btnRecord.name };

                    if (btnRecord.color === 'r') btnObj.style = 'danger';
                    else if (btnRecord.color === 'b') btnObj.style = 'primary';
                    else if (btnRecord.color === 'g') btnObj.style = 'success';

                    if (btnRecord.emojiId && btnRecord.emojiId !== 'none' && btnRecord.emojiId !== 'null') {
                        btnObj.icon_custom_emoji_id = btnRecord.emojiId;
                    }

                    if (btnRecord.btnType === 'url') {
                        let urlStr = btnRecord.content;
                        if (!urlStr.startsWith('http') && !urlStr.startsWith('tg://')) urlStr = 'https://' + urlStr;
                        btnObj.url = urlStr;
                    } else if (btnRecord.btnType === 'copy') {
                        btnObj.copy_text = { text: btnRecord.content };
                    } else if (btnRecord.btnType === 'callback_data' || btnRecord.btnType === 'cb') {
                        btnObj.callback_data = `brep_${btnRecord.btnId}`;
                    }
                    kbRow.push(btnObj);
                }
            }
            if (kbRow.length > 0) inline_keyboard.push(kbRow);
        }
        if (inline_keyboard.length > 0) replyMarkup = { inline_keyboard };
    }

    if (!cleanText || cleanText.trim() === '') {
        cleanText = '\u200b';
    }

    return { cleanText, replyMarkup };
}

// فحص ما إذا كانت الكتلة لا تزال تحتوي على نص أو وسائط بعد حذف {{...}}
function hasVisibleContent(node) {
    if (!node || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(hasVisibleContent);
    for (const key of Object.keys(node)) {
        if (key === 'type' || key === 'is_rtl' || key === 'entities' || key === 'language') continue;
        if (['file_id', 'media', 'photo', 'video', 'animation', 'document', 'audio', 'voice', 'voice_note', 'sticker'].includes(key) && node[key]) {
            return true;
        }
        const val = node[key];
        if (typeof val === 'string' && val.trim().length > 0) return true;
        if (typeof val === 'object' && val !== null && hasVisibleContent(val)) return true;
    }
    return false;
}

// معالجة أزرار الكيبورد داخل الـ Rich Message
async function processRichMessageButtons(richMsg, extraText = '') {
    if (!richMsg) return { cleanedRich: richMsg, replyMarkup: null };
    const copy = JSON.parse(JSON.stringify(richMsg));
    let foundTag = null;
    const btnRegex = /\{\{([A-Za-z0-9_,|\s]+)\}\}/;
    const modifiedBlocks = new Set();

    function walk(node, topBlockIdx = null) {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
            for (let i = node.length - 1; i >= 0; i--) {
                walk(node[i], topBlockIdx);
            }
            return;
        }
        for (const key of Object.keys(node)) {
            if (['type', 'id', 'file_id', 'url'].includes(key)) continue;
            const val = node[key];
            if (typeof val === 'string') {
                const m = val.match(btnRegex);
                if (m) {
                    if (!foundTag) foundTag = m[0];
                    node[key] = val.replace(btnRegex, '').trimEnd();
                    if (Array.isArray(node.entities)) {
                        node.entities = trimEntities(node.entities, node[key].length);
                    }
                    if (topBlockIdx !== null) modifiedBlocks.add(topBlockIdx);
                }
            } else if (typeof val === 'object' && val !== null) {
                walk(val, topBlockIdx);
            }
        }
    }

    if (Array.isArray(copy.blocks)) {
        for (let i = copy.blocks.length - 1; i >= 0; i--) {
            walk(copy.blocks[i], i);
        }
        if (copy.blocks.length > 1 && modifiedBlocks.size > 0) {
            copy.blocks = copy.blocks.filter((block, idx) => !modifiedBlocks.has(idx) || hasVisibleContent(block));
        }
    } else {
        walk(copy);
    }

    if (!foundTag && extraText) {
        const m = extraText.match(btnRegex);
        if (m) foundTag = m[0];
    }

    let replyMarkup = null;
    if (foundTag) {
        const parsed = await parseAndBuildKeyboard(foundTag);
        replyMarkup = parsed.replyMarkup;
    }

    return { cleanedRich: copy, replyMarkup };
}

// استخراج file_id الصافي من أي كائن وسائط أو مصفوفة PhotoSize
function extractFileId(mediaProp) {
    if (!mediaProp) return null;
    if (typeof mediaProp === 'string') return mediaProp;
    if (Array.isArray(mediaProp) && mediaProp.length > 0) {
        const best = mediaProp[mediaProp.length - 1];
        return best?.file_id || best?.media || null;
    }
    if (typeof mediaProp === 'object') {
        return mediaProp.media || mediaProp.file_id || null;
    }
    return null;
}

// تحويل كل كتلة (بما في ذلك الكتل المتداخلة داخل collage و slideshow) إلى InputRichBlock قياسي
function normalizeRichBlock(block) {
    if (!block || typeof block !== 'object') return block;

    const cleanCaption = (block.caption && hasVisibleContent(block.caption)) ? block.caption : undefined;

    // 1. معالجة الكتل الحاوية (مثل collage أو slideshow) بشكل تكراري (Recursive)
    if (Array.isArray(block.blocks)) {
        const cloned = {
            ...block,
            blocks: block.blocks.map(normalizeRichBlock)
        };
        if (cleanCaption) cloned.caption = cleanCaption;
        else delete cloned.caption;
        return cloned;
    }

    // 2. معالجة كتلة الصور InputRichBlockPhoto -> InputMediaPhoto
    if (block.type === 'photo' || block.photo) {
        const fileId = extractFileId(block.photo || block.media);
        if (fileId) {
            const res = {
                type: 'photo',
                photo: { type: 'photo', media: fileId }
            };
            if (cleanCaption) res.caption = cleanCaption;
            return res;
        }
    }

    // 3. معالجة كتلة الفيديو InputRichBlockVideo -> InputMediaVideo
    if (block.type === 'video' || block.video) {
        const fileId = extractFileId(block.video || block.media);
        if (fileId) {
            const res = {
                type: 'video',
                video: { type: 'video', media: fileId }
            };
            if (cleanCaption) res.caption = cleanCaption;
            return res;
        }
    }

    // 4. معالجة كتلة الصور المتحركة InputRichBlockAnimation -> InputMediaAnimation
    if (block.type === 'animation' || block.animation) {
        const fileId = extractFileId(block.animation || block.media);
        if (fileId) {
            const res = {
                type: 'animation',
                animation: { type: 'animation', media: fileId }
            };
            if (cleanCaption) res.caption = cleanCaption;
            return res;
        }
    }

    // 5. معالجة كتلة الصوتيات InputRichBlockAudio -> InputMediaAudio
    if (block.type === 'audio' || block.audio) {
        const fileId = extractFileId(block.audio || block.media);
        if (fileId) {
            const res = {
                type: 'audio',
                audio: { type: 'audio', media: fileId }
            };
            if (cleanCaption) res.caption = cleanCaption;
            return res;
        }
    }

    // 6. معالجة كتلة الملفات InputRichBlockDocument -> InputMediaDocument
    if (block.type === 'document' || block.document) {
        const fileId = extractFileId(block.document || block.media);
        if (fileId) {
            const res = {
                type: 'document',
                document: { type: 'document', media: fileId }
            };
            if (cleanCaption) res.caption = cleanCaption;
            return res;
        }
    }

    // 7. معالجة كتلة البصمات الصوتية InputRichBlockVoiceNote -> InputMediaVoiceNote
    if (block.type === 'voice_note' || block.voice_note || block.voice) {
        const fileId = extractFileId(block.voice_note || block.voice || block.media);
        if (fileId) {
            const res = {
                type: 'voice_note',
                voice_note: { type: 'voice_note', media: fileId }
            };
            if (cleanCaption) res.caption = cleanCaption;
            return res;
        }
    }

    return block;
}

function buildRichMediaPayload(richObj) {
    const payload = {
        is_rtl: richObj.is_rtl ?? true
    };

    if (Array.isArray(richObj.blocks)) {
        payload.blocks = richObj.blocks.map(normalizeRichBlock);
    } else if (richObj.html) {
        payload.html = richObj.html;
    } else if (richObj.markdown) {
        payload.markdown = richObj.markdown;
    }

    if (Array.isArray(richObj.media) && richObj.media.length > 0) {
        payload.media = richObj.media.map((item, index) => {
            if (!item || typeof item !== 'object') return item;

            let type = item.media?.type || item.type;
            let fileId = item.media?.media || item.media || item.file_id;

            const src = item.media || item;
            if (Array.isArray(src.photo) && src.photo.length > 0) {
                type = 'photo';
                fileId = src.photo[src.photo.length - 1].file_id;
            } else if (src.photo?.file_id) {
                type = 'photo';
                fileId = src.photo.file_id;
            } else if (src.video?.file_id) {
                type = 'video';
                fileId = src.video.file_id;
            } else if (src.animation?.file_id) {
                type = 'animation';
                fileId = src.animation.file_id;
            } else if (src.document?.file_id) {
                type = 'document';
                fileId = src.document.file_id;
            } else if (src.audio?.file_id) {
                type = 'audio';
                fileId = src.audio.file_id;
            } else if (src.voice?.file_id || src.voice_note?.file_id) {
                type = 'voice_note';
                fileId = (src.voice || src.voice_note).file_id;
            }

            if (type && fileId) {
                return {
                    id: item.id || `media_${index + 1}`,
                    media: { type, media: fileId }
                };
            }
            return item;
        });
    }

    return payload;
}


// 2. دالة إرسال الردود المحفوظة والتلقائية (تدعم العادية والـ Rich معاً)
export async function sendRichMessage(targetChat, matchData, threadId = null, replyToMsgId = null, bizConnectionId = null) {
    let rawContent = matchData.content || '';
    const { cleanText, replyMarkup } = await parseAndBuildKeyboard(rawContent);
    const fType = matchData.fileType || 'text';

    const sendParams = { chat_id: targetChat };
    if (threadId) sendParams.message_thread_id = threadId;
    if (replyToMsgId) sendParams.reply_parameters = { message_id: replyToMsgId, allow_sending_without_reply: true };
    if (bizConnectionId) sendParams.business_connection_id = bizConnectionId;

    // أ. إذا كان الرد المحفوظ عبارة عن رسالة غنية (Rich Message)
    if (fType === 'rich' && matchData.entities && matchData.entities.rich_message) {
        const savedRich = matchData.entities.rich_message;
        const { cleanedRich, replyMarkup: richBtnMarkup } = await processRichMessageButtons(savedRich, rawContent);

        sendParams.rich_message = buildRichMediaPayload(cleanedRich);

        const finalMarkup = richBtnMarkup || replyMarkup || matchData.entities.reply_markup;
        if (finalMarkup) sendParams.reply_markup = finalMarkup;

        try {
            return await api.sendRichMessage(sendParams);
        } catch (e) {
            console.error("Rich Message Error:", e);
            return null;
        }
    }

    // ب. إذا كان الرد المحفوظ رسالة عادية (نص أو وسائط غير Rich)
    if (replyMarkup) sendParams.reply_markup = replyMarkup;

    // للوسائط: إذا كان النص فارغاً بعد إزالة كود الأزرار {{...}} نجعل الكابشن undefined
    const cleanCaption = cleanText === '\u200b' ? '' : cleanText;
    const savedEntities = Array.isArray(matchData.entities) ? matchData.entities : undefined;

    try {
        if (fType === 'photo' && matchData.fileId) {
            const ents = trimEntities(savedEntities, cleanCaption.length);
            return await api.sendPhoto({ ...sendParams, photo: matchData.fileId, caption: cleanCaption || undefined, caption_entities: ents });
        } else if (fType === 'video' && matchData.fileId) {
            const ents = trimEntities(savedEntities, cleanCaption.length);
            return await api.sendVideo({ ...sendParams, video: matchData.fileId, caption: cleanCaption || undefined, caption_entities: ents });
        } else if (fType === 'animation' && matchData.fileId) {
            const ents = trimEntities(savedEntities, cleanCaption.length);
            return await api.sendAnimation({ ...sendParams, animation: matchData.fileId, caption: cleanCaption || undefined, caption_entities: ents });
        } else if (fType === 'document' && matchData.fileId) {
            const ents = trimEntities(savedEntities, cleanCaption.length);
            return await api.sendDocument({ ...sendParams, document: matchData.fileId, caption: cleanCaption || undefined, caption_entities: ents });
        } else if (fType === 'voice' && matchData.fileId) {
            const ents = trimEntities(savedEntities, cleanCaption.length);
            return await api.sendVoice({ ...sendParams, voice: matchData.fileId, caption: cleanCaption || undefined, caption_entities: ents });
        } else if (fType === 'audio' && matchData.fileId) {
            const ents = trimEntities(savedEntities, cleanCaption.length);
            return await api.sendAudio({ ...sendParams, audio: matchData.fileId, caption: cleanCaption || undefined, caption_entities: ents });
        } else if (fType === 'sticker' && matchData.fileId) {
            return await api.sendSticker({ ...sendParams, sticker: matchData.fileId });
        } else {
            // رسالة نصية عادية مع الحفاظ على الايموجيات المميزة والتنسيقات
            const ents = trimEntities(savedEntities, cleanText.length);
            return await api.sendMessage({ ...sendParams, text: cleanText, entities: ents });
        }
    } catch (e) {
        console.error("Normal Reply Error:", e);
        return null;
    }
}

// 3. دالة نقل الرسائل (Mirror)
export async function mirrorMessage(sourceMsg, targetChatId, { threadId = null, replyToMsgId = null, bizConnectionId = null, parseButtons = false } = {}) {
    const sendParams = { chat_id: targetChatId };
    if (threadId) sendParams.message_thread_id = threadId;
    if (replyToMsgId) sendParams.reply_parameters = { message_id: replyToMsgId, allow_sending_without_reply: true };
    if (bizConnectionId) sendParams.business_connection_id = bizConnectionId;

    const rawText = sourceMsg.text || sourceMsg.caption || '';
    let cleanText = rawText;
    let customMarkup = null;

    if (parseButtons && rawText) {
        const parsed = await parseAndBuildKeyboard(rawText);
        cleanText = parsed.cleanText;
        customMarkup = parsed.replyMarkup;
    }

    if (sourceMsg.rich_message) {
        let richToUse = sourceMsg.rich_message;
        let richMarkup = null;

        if (parseButtons) {
            const processed = await processRichMessageButtons(sourceMsg.rich_message, rawText);
            richToUse = processed.cleanedRich;
            richMarkup = processed.replyMarkup;
        }

        sendParams.rich_message = buildRichMediaPayload(richToUse);

        const finalMarkup = richMarkup || customMarkup || sourceMsg.reply_markup;
        if (finalMarkup) sendParams.reply_markup = finalMarkup;

        return await api.sendRichMessage(sendParams);
    }

    const finalMarkup = customMarkup || sourceMsg.reply_markup;
    if (finalMarkup) sendParams.reply_markup = finalMarkup;

    if (sourceMsg.photo) {
        const ents = trimEntities(sourceMsg.caption_entities, cleanText.length);
        return await api.sendPhoto({ ...sendParams, photo: sourceMsg.photo[sourceMsg.photo.length - 1].file_id, caption: cleanText || undefined, caption_entities: ents });
    } else if (sourceMsg.video) {
        const ents = trimEntities(sourceMsg.caption_entities, cleanText.length);
        return await api.sendVideo({ ...sendParams, video: sourceMsg.video.file_id, caption: cleanText || undefined, caption_entities: ents });
    } else if (sourceMsg.animation) {
        const ents = trimEntities(sourceMsg.caption_entities, cleanText.length);
        return await api.sendAnimation({ ...sendParams, animation: sourceMsg.animation.file_id, caption: cleanText || undefined, caption_entities: ents });
    } else if (sourceMsg.document) {
        const ents = trimEntities(sourceMsg.caption_entities, cleanText.length);
        return await api.sendDocument({ ...sendParams, document: sourceMsg.document.file_id, caption: cleanText || undefined, caption_entities: ents });
    } else if (sourceMsg.audio) {
        const ents = trimEntities(sourceMsg.caption_entities, cleanText.length);
        return await api.sendAudio({ ...sendParams, audio: sourceMsg.audio.file_id, caption: cleanText || undefined, caption_entities: ents });
    } else if (sourceMsg.voice) {
        const ents = trimEntities(sourceMsg.caption_entities, cleanText.length);
        return await api.sendVoice({ ...sendParams, voice: sourceMsg.voice.file_id, caption: cleanText || undefined, caption_entities: ents });
    } else if (sourceMsg.sticker) {
        return await api.sendSticker({ ...sendParams, sticker: sourceMsg.sticker.file_id });
    } else if (sourceMsg.video_note) {
        return await api.sendVideoNote({ ...sendParams, video_note: sourceMsg.video_note.file_id });
    } else if (sourceMsg.story) {
        const s = sourceMsg.story;
        const sChat = s.chat || {};
        const sTitle = [sChat.first_name, sChat.last_name, sChat.title].filter(Boolean).join(' ') || 'مستخدم';
        const userLink = sChat.username ? `https://t.me/${sChat.username}` : (sChat.id ? `tg://user?id=${sChat.id}` : '');

        let storyText = `<b>ستوري محوّل من:</b> ${userLink ? `<a href="${userLink}">${escapeHtml(sTitle)}</a>` : escapeHtml(sTitle)}`;

        if (sChat.username) {
            const storyUrl = `https://t.me/${sChat.username}/s/${s.id}`;
            storyText += `\n${storyUrl}`;
        }
        if (cleanText) {
            storyText += `\n\n${escapeHtml(cleanText)}`;
        }

        return await api.sendMessage({
            ...sendParams,
            text: storyText,
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: false }
        });
    } else if (sourceMsg.text) {
        const ents = trimEntities(sourceMsg.entities, cleanText.length);
        return await api.sendMessage({ ...sendParams, text: cleanText, entities: ents });
    }

    // نسخ أي نوع آخر من الرسائل (إيموجي تفاعلي، جهة اتصال، موقع...) لضمان حفظه في msg_map
    if (sourceMsg.chat?.id && sourceMsg.message_id) {
        try {
            return await api.copyMessage({
                ...sendParams,
                from_chat_id: sourceMsg.chat.id,
                message_id: sourceMsg.message_id
            });
        } catch (e) {}
    }
    return null;
}

// 4. استخراج معلومات الرسالة المحولة
export function getForwardOriginText(msg) {
    const origin = msg.forward_origin;
    if (origin) {
        if (origin.type === 'user' && origin.sender_user) {
            const u = origin.sender_user;
            const fullName = escapeHtml([u.first_name, u.last_name].filter(Boolean).join(' ') || 'مستخدم');
            const link = u.username ? `https://t.me/${u.username}` : `tg://user?id=${u.id}`;
            return `تم التحويل من: <a href="${link}">${fullName}</a>`;
        }
        if (origin.type === 'hidden_user') {
            return `تم التحويل من: ${escapeHtml(origin.sender_user_name || 'مستخدم مخفي')}`;
        }
        if (origin.type === 'chat' && origin.sender_chat) {
            const c = origin.sender_chat;
            const title = escapeHtml(c.title || 'محادثة');
            if (c.username) return `تم التحويل من: <a href="https://t.me/${c.username}">${title}</a>`;
            return `تم التحويل من: ${title}`;
        }
        if (origin.type === 'channel' && origin.chat) {
            const c = origin.chat;
            const title = escapeHtml(c.title || 'قناة');
            if (c.username) {
                const link = origin.message_id ? `https://t.me/${c.username}/${origin.message_id}` : `https://t.me/${c.username}`;
                return `تم التحويل من: <a href="${link}">${title}</a>`;
            }
            return `تم التحويل من: ${title}`;
        }
    }

    if (msg.forward_from) {
        const u = msg.forward_from;
        const fullName = escapeHtml([u.first_name, u.last_name].filter(Boolean).join(' ') || 'مستخدم');
        const link = u.username ? `https://t.me/${u.username}` : `tg://user?id=${u.id}`;
        return `تم التحويل من: <a href="https://t.me/${u.username}">${fullName}</a>`;
    }
    if (msg.forward_from_chat) {
        const c = msg.forward_from_chat;
        const title = escapeHtml(c.title || 'قناة/محادثة');
        if (c.username) {
            const link = msg.forward_from_message_id ? `https://t.me/${c.username}/${msg.forward_from_message_id}` : `https://t.me/${c.username}`;
            return `تم التحويل من: <a href="https://t.me/${c.username}">${title}</a>`;
        }
        return `تم التحويل من: ${title}`;
    }
    if (msg.forward_sender_name) {
        return `تم التحويل من: ${escapeHtml(msg.forward_sender_name)}`;
    }

    return null;
}


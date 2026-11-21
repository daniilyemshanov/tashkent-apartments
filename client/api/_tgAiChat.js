// ИИ-чат по базе в Telegram. Запуск: /ai текст. Продолжение: ответом (Reply) на сообщение ИИ.
// Обычные сообщения группы ИИ НЕ читает — иначе он отвечал бы на каждую болтовню и жёг деньги.
//
// Память диалога лежит в уже существующей таблице bot_sessions (миграция не нужна).
// Чтобы не затирать состояние мастера /find (там state перезаписывается целиком), диалог ИИ
// хранится в отдельной строке: user_id = -<telegram id> (отрицательный, с настоящими id не пересекается).

import { supabase } from './_supabase.js';
import { sendMessage, editMessageText, escapeHtml } from './_telegramApi.js';
import { runListingChat } from './_aiChat.js';
import { throwOnSupabaseError } from './_dbErrors.js';

const SESSION_TTL_MS = 6 * 60 * 60 * 1000; // через 6 часов тишины диалог начинается заново
const DAILY_LIMIT = Number(process.env.TG_AI_DAILY_LIMIT) || 30; // сообщений на человека в сутки (защита бюджета)
const KEEP_MSGS = 8;
const MAX_TG_BODY = 3300;
const RESET_RE = /^(сброс|новый|новая|заново|reset|new)$/i;

const ERROR_TEXT = {
  ai_unavailable: '⚠️ ИИ не настроен (нет ANTHROPIC_API_KEY на сервере).',
  rate_limited: '⏳ ИИ сейчас перегружен, попробуйте через минуту.',
  timeout: '⏳ ИИ отвечал слишком долго, попробуйте ещё раз.',
};

const threadExtra = (threadId) => (threadId ? { message_thread_id: threadId } : {});
const today = () => new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); // дата по Ташкенту (UTC+5)
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function loadChat(chatId, userId) {
  const { data, error } = await supabase
    .from('bot_sessions').select('state').eq('chat_id', chatId).eq('user_id', -userId).maybeSingle();
  throwOnSupabaseError('getAiChat', error);
  return data?.state || null;
}

async function saveChat(chatId, userId, state) {
  const { error } = await supabase
    .from('bot_sessions')
    .upsert({ chat_id: chatId, user_id: -userId, state, updated_at: new Date().toISOString() });
  throwOnSupabaseError('saveAiChat', error);
}

/** true, если это ответ на сообщение ИИ-чата этого же человека (и диалог ещё не протух). */
export async function loadContinuation(message) {
  const replyTo = message.reply_to_message;
  if (!message.text || !replyTo?.from?.is_bot || !message.from?.id) return null;
  const state = await loadChat(message.chat.id, message.from.id);
  if (!state?.botMsgIds?.includes(replyTo.message_id)) return null;
  return state;
}

function formatAnswer(reply, cards, firstTurn) {
  let body = escapeHtml(reply);
  if (body.length > MAX_TG_BODY) body = body.slice(0, MAX_TG_BODY) + '…';
  const lines = (cards || [])
    .filter((c) => /^https?:\/\//.test(c.url || ''))
    .map((c) => {
      const label = [c.price, c.rooms ? `${c.rooms} комн.` : null, c.district].filter(Boolean).join(' · ') || c.title || 'объявление';
      return `🏠 <a href="${attr(c.url)}">${escapeHtml(label)}</a>`;
    });
  let out = body + (lines.length ? `\n\n${lines.join('\n')}` : '');
  if (firstTurn) out += '\n\n<i>Продолжайте, отвечая (Reply) на это сообщение. Начать заново: /ai новый</i>';
  return out;
}

/**
 * @param {object} message сообщение Telegram
 * @param {string} text текст вопроса (после /ai или тело ответа)
 * @param {object|null} state уже загруженное состояние (для продолжения)
 */
export async function handleTgAiChat(message, text, state = null) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const threadId = message.message_thread_id;
  const extra = threadExtra(threadId);

  if (RESET_RE.test(text.trim())) {
    await saveChat(chatId, userId, { msgs: [], botMsgIds: [], day: state?.day || today(), count: state?.count || 0, ts: Date.now() });
    await sendMessage(chatId, '🧹 Начали заново. Опишите, что ищете: <code>/ai 2-комнатная на аренду в Чиланзаре до 500$</code>', extra);
    return;
  }

  const cur = state || (await loadChat(chatId, userId)) || {};
  const fresh = !cur.ts || Date.now() - cur.ts > SESSION_TTL_MS;
  const msgs = fresh ? [] : cur.msgs || [];
  const day = today();
  const count = cur.day === day ? cur.count || 0 : 0;

  if (count >= DAILY_LIMIT) {
    await sendMessage(chatId, `⛔ Дневной лимит ИИ-чата (${DAILY_LIMIT} сообщений) исчерпан, завтра снова. Обычный поиск работает: /search`, extra);
    return;
  }

  const placeholder = await sendMessage(chatId, '💬 Думаю, ищу по базе…', { ...extra, reply_to_message_id: message.message_id });
  const placeholderId = placeholder?.result?.message_id;

  const userText = text.slice(0, 800);
  const result = await runListingChat([...msgs, { role: 'user', content: userText }], `tg:${userId}`);

  if (!result.ok) {
    const err = ERROR_TEXT[result.error] || '⚠️ Не получилось получить ответ, попробуйте ещё раз.';
    if (placeholderId) await editMessageText(chatId, placeholderId, err);
    else await sendMessage(chatId, err, extra);
    return;
  }

  const html = formatAnswer(result.reply, result.cards, msgs.length === 0);
  let botMsgId = placeholderId;
  if (placeholderId) {
    const edited = await editMessageText(chatId, placeholderId, html);
    if (edited && edited.ok === false) botMsgId = null;
  }
  if (!botMsgId) {
    const sent = await sendMessage(chatId, html, extra);
    botMsgId = sent?.result?.message_id;
  }

  // В историю кладём и id показанных объявлений: тогда «покажи ещё» не повторит те же варианты
  const shown = result.cards.length ? `\n[показаны id: ${result.cards.map((c) => c.id).join(',')}]` : '';
  const nextMsgs = [...msgs, { role: 'user', content: userText }, { role: 'assistant', content: result.reply.slice(0, 1500) + shown }].slice(-KEEP_MSGS);
  await saveChat(chatId, userId, {
    msgs: nextMsgs,
    botMsgIds: [...(fresh ? [] : cur.botMsgIds || []), botMsgId].filter(Boolean).slice(-8),
    day,
    count: count + 1,
    ts: Date.now(),
  });
}

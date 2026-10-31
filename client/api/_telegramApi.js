// Тонкая обёртка над Telegram Bot API через обычный fetch — отдельная
// от scraper/src/telegram.js (та работает в GitHub Actions и только
// ОТПРАВЛЯЕТ уведомления). Эта — для интерактивного бота на Vercel,
// который ОТВЕЧАЕТ на команды и нажатия кнопок через webhook.

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const API = `https://api.telegram.org/bot${TOKEN}`;
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_API_TIMEOUT_MS) || 8000;

function assertConfigured() {
  if (!TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан в переменных окружения Vercel');
  }
}

async function call(method, payload) {
  assertConfigured();
  const started = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
    const data = await res.json();
    const description = String(data?.description || '');
    const expectedNoop = method === 'editMessageText' && /message is not modified/i.test(description);
    const expiredCallback = method === 'answerCallbackQuery' && /query is too old|query ID is invalid/i.test(description);
    if (!data?.ok && !expectedNoop && !expiredCallback) console.error(JSON.stringify({ event: 'telegram_api_error', method, status: res.status, description, duration_ms: Date.now() - started }));
    else if (process.env.LOG_API_TIMINGS === 'true') console.log(JSON.stringify({ event: 'telegram_api', method, duration_ms: Date.now() - started, ok: !!data?.ok }));
    return data;
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    console.error(JSON.stringify({ event: 'telegram_api_failure', method, kind: timedOut ? 'timeout' : 'network', duration_ms: Date.now() - started }));
    const failure = new Error(`Telegram ${method} ${timedOut ? 'timed out' : 'request failed'}`);
    failure.cause = error;
    throw failure;
  } finally { clearTimeout(timeout); }
}

export function sendMessage(chatId, text, extra = {}) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

export function editMessageText(chatId, messageId, text, extra = {}) {
  return call('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...extra,
  });
}

export function answerCallbackQuery(callbackQueryId, text = '') {
  return call('answerCallbackQuery', { callback_query_id: callbackQueryId, text });
}

// Используется, когда карточку помечают "Это агент" — сообщение сразу
// убирается из группы вместо того, чтобы просто менять бейдж на нём.
// Возвращает true/false, не бросает исключение — вызывающий код решает,
// что делать, если удалить не получилось (например, сообщение старше
// 48 часов и Telegram сам уже не даёт его удалить).
export async function deleteMessage(chatId, messageId) {
  const data = await call('deleteMessage', { chat_id: chatId, message_id: messageId });
  return !!data.ok;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
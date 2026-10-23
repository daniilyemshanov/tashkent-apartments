// Тонкая обёртка над Telegram Bot API через обычный fetch — отдельная
// от scraper/src/telegram.js (та работает в GitHub Actions и только
// ОТПРАВЛЯЕТ уведомления). Эта — для интерактивного бота на Vercel,
// который ОТВЕЧАЕТ на команды и нажатия кнопок через webhook.

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const API = `https://api.telegram.org/bot${TOKEN}`;

function assertConfigured() {
  if (!TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN не задан в переменных окружения Vercel');
  }
}

async function call(method, payload) {
  assertConfigured();
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) {
    console.error(`Telegram API ошибка (${method}):`, data.description);
  }
  return data;
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
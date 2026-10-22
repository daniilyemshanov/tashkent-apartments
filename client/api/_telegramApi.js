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
  const startedAt = Date.now();
  try {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(method === 'answerCallbackQuery' ? 2500 : 10000),
    });
    const data = await res.json();
    if (!data.ok) {
      const description = data.description || '';
      const expectedNoop =
        /message is not modified/i.test(description) ||
        (method === 'answerCallbackQuery' && /query is too old|query id is invalid|response timeout expired/i.test(description));
      // Эти ответы означают, что действие уже не применимо. Не повторяем
      // запрос: остальные API-ошибки по-прежнему остаются в логах.
      if (!expectedNoop) console.error(`Telegram API ошибка (${method}):`, description);
    }
    console.info(`[perf] telegram.${method} ${Date.now() - startedAt}ms${res.ok ? '' : ' http_error'}`);
    return data;
  } catch (error) {
    const message = String(error?.message || 'unknown transport error');
    const safeMessage = TOKEN ? message.split(TOKEN).join('[redacted]') : message;
    console.error(`[telegram] ${method} transport failure after ${Date.now() - startedAt}ms:`, safeMessage);
    throw new Error(safeMessage);
  }
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
import { pathToFileURL } from 'node:url';

const TELEGRAM_TIMEOUT_MS = 8000;

export async function sendTelegramAlert(message, fetchImpl = fetch) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!token || !chatId) {
    console.error(JSON.stringify({ event: 'alert_not_configured' }));
    return false;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: controller.signal,
    });
    const body = await response.json();
    return response.ok && body?.ok === true;
  } catch {
    console.error(JSON.stringify({ event: 'telegram_alert_failed' }));
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const message = process.argv.slice(2).join(' ');
  sendTelegramAlert(message).then((ok) => { if (!ok) process.exitCode = 1; });
}

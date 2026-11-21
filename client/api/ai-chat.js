import { requireAuth } from './_auth.js';
import { runListingChat } from './_aiChat.js';

// Чат с ИИ по нашей базе для сайта. Без состояния на сервере: фронтенд присылает
// историю (только текст). Сам цикл «модель → поиск по базе → модель» — в _aiChat.js.

const STATUS = { ai_unavailable: 503, rate_limited: 503, timeout: 504, bad_request: 400, too_many_steps: 502, ai_failed: 502 };

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const email = await requireAuth(req, res);
  if (!email) return;

  const result = await runListingChat(req.body?.messages, email);
  if (!result.ok) return res.status(STATUS[result.error] || 502).json({ error: result.error });
  return res.status(200).json({ reply: result.reply, cards: result.cards });
}

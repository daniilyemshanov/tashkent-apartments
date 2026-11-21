import { useEffect, useRef, useState } from 'react';

// Плавающий ИИ-чат по базе объявлений. История хранится в состоянии (до
// перезагрузки страницы), на сервер уходят только текстовые реплики.
const SUGGESTIONS = [
  '2-комнатная на аренду в Юнусабаде до 500$',
  '3-комнатная на покупку до 100000$ с хорошим ремонтом',
  'Что-нибудь получше, бюджет можно выше',
];

const ERRORS = {
  rate_limited: 'ИИ сейчас перегружен, попробуйте через минуту.',
  timeout: 'ИИ отвечал слишком долго, попробуйте ещё раз.',
  ai_unavailable: 'ИИ-чат не настроен (нет ключа на сервере).',
};

export default function ChatPanel({ authFetch, onClose }) {
  const [msgs, setMsgs] = useState([]); // {role, content, cards?}
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const bottomRef = useRef(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, busy]);

  async function send(text) {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    const next = [...msgs, { role: 'user', content }];
    setMsgs(next);
    setInput('');
    setError('');
    setBusy(true);
    try {
      const res = await authFetch('/api/ai-chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // к ответам ИИ дописываем id показанных объявлений, чтобы «покажи ещё» не повторялось
        body: JSON.stringify({
          messages: next.map(({ role, content: c, cards }) => ({
            role,
            content: cards?.length ? `${c}\n[показаны id: ${cards.map((x) => x.id).join(',')}]` : c,
          })),
        }),
      });
      if (!res) return;
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(ERRORS[body?.error] || 'Не получилось получить ответ, попробуйте ещё раз.');
        return;
      }
      setMsgs([...next, { role: 'assistant', content: body.reply, cards: body.cards || [] }]);
    } catch {
      setError('Нет связи с сервером.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <b>💬 ИИ-помощник по базе</b>
        <span>
          {msgs.length > 0 && <button className="btn" onClick={() => { setMsgs([]); setError(''); }}>Новый чат</button>}
          <button className="btn" onClick={onClose}>✕</button>
        </span>
      </div>

      <div className="chat-body">
        {msgs.length === 0 && (
          <div className="chat-hint">
            Опишите, что ищете, и уточняйте по ходу: «а подешевле», «получше ремонт, бюджет выше», «только от собственника».
            <div className="chat-suggest">
              {SUGGESTIONS.map((s) => <button key={s} className="btn" onClick={() => send(s)}>{s}</button>)}
            </div>
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            <div className="chat-bubble">{m.content}</div>
            {m.cards?.length > 0 && (
              <div className="chat-cards">
                {m.cards.map((c) => (
                  <a key={c.id} className="chat-card" href={c.url} target="_blank" rel="noreferrer">
                    {c.image && <img src={c.image} alt="" loading="lazy" />}
                    <div>
                      <div className="chat-card-price">{c.price}</div>
                      <div className="chat-card-title">{c.title}</div>
                      <div className="chat-card-sub">{[c.district, c.rooms && `${c.rooms} комн.`].filter(Boolean).join(' · ')}</div>
                    </div>
                  </a>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div className="chat-msg chat-assistant"><div className="chat-bubble chat-typing">Ищу в базе…</div></div>}
        {error && <div className="chat-error">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input">
        <input
          type="text"
          placeholder="Напишите запрос…"
          value={input}
          maxLength={800}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
          disabled={busy}
        />
        <button className="btn" onClick={() => send()} disabled={busy || !input.trim()}>Отправить</button>
      </div>
    </div>
  );
}

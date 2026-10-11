// Диагностика цепочки AI-провайдеров (Claude Haiku 5.5 → Mistral), не
// трогает production-логику — только читает те же ENV-переменные, что и
// aiProviders.js, и показывает, что реально произойдёт при следующем
// запуске скрейпера.
//
// ПО УМОЛЧАНИЮ (без флагов) — ничего не отправляет в сеть, только
// печатает план: какие провайдеры включены и в каком порядке они
// будут пробоваться, судя по текущим ENV. Безопасно гонять сколько
// угодно раз, ключи не тратятся.
//
// Запуск:
//   node src/scripts/verify-ai-fallback.js
//
// Живая проверка (реально дергает провайдеров одним маленьким
// запросом на каждого по очереди, тратит немного квоты) — только
// если явно попросили:
//   node src/scripts/verify-ai-fallback.js --live
//
// Ключи НИКОГДА не печатаются в лог — только их наличие (да/нет) и
// длина (чтобы отличить пустую строку от реального ключа).

import 'dotenv/config';
import { providerPlan, runAiJsonChain } from '../aiProviders.js';

const live = process.argv.includes('--live');

function maskedStatus(name, value) {
  if (!value) return `${name}: НЕ задан`;
  return `${name}: задан (${value.length} симв.)`;
}

console.log('=== ENV-статус провайдеров ===');
console.log(maskedStatus('ANTHROPIC_API_KEY', process.env.ANTHROPIC_API_KEY));
console.log(`ANTHROPIC_MODEL: ${process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5 (по умолчанию)'}`);
console.log(`ANTHROPIC_EFFORT: ${process.env.ANTHROPIC_EFFORT ?? 'low (по умолчанию)'}`);
console.log(maskedStatus('MISTRAL_API_KEY (запасной)', process.env.MISTRAL_API_KEY));
console.log(`AI_FALLBACK_ENABLED: ${process.env.AI_FALLBACK_ENABLED === 'true' ? 'да' : 'нет (fallback-провайдеры пропускаются, даже если ключи заданы)'}`);

const plan = providerPlan();
console.log('\n=== Порядок провайдеров (как в проде прямо сейчас) ===');
if (plan.length === 0) {
  console.log('Пусто — ни один провайдер не настроен. AI-фичи откатятся на regex-фолбэк.');
} else {
  plan.forEach((p, i) => console.log(`${i + 1}. ${p.name}`));
}

if (!live) {
  console.log('\nЭто был dry-run (без сети). Для реальной проверки цепочки запустите с флагом --live.');
  process.exit(0);
}

console.log('\n=== Живая проверка: один маленький JSON-запрос через цепочку ===');
const result = await runAiJsonChain({
  taskName: 'verify-ai-fallback',
  systemPrompt: 'Ответь строго JSON-объектом {"ok": true} и больше ничем.',
  userText: 'ping',
  maxTokens: 20,
});

if (result.ok) {
  console.log(`Успех через провайдера: ${result.provider}`);
  console.log('Ответ:', result.data);
} else {
  console.log(`Не удалось получить ответ ни от одного провайдера. reason=${result.reason}`);
  if (result.error) console.log('Последняя ошибка:', result.error);
}

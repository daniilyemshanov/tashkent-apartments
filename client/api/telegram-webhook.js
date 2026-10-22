// Webhook для интерактивного поиска прямо в Telegram-группе.
// Доступен ВСЕМ участникам группы (не только админам), полный фильтр
// сразу (район + комнаты + цена + тип сделки), в виде кнопок —
// как и просил пользователь.
//
// НАСТРОЙКА (сделать один раз после деплоя на Vercel):
//  1. В Vercel → Project Settings → Environment Variables добавить:
//     TELEGRAM_WEBHOOK_SECRET — любая случайная строка, придумайте сами
//       (напр. openssl rand -hex 24 в терминале).
//     EXCHANGE_RATE_USD_UZS — опционально, курс $ к суму для сравнения
//       цен в разных валютах при фильтрации (по умолчанию ~11990,
//       актуально на 04.08.2026 — стоит периодически сверять с
//       реальным курсом ЦБ РУз и обновлять).
//  2. У бота в @BotFather выполнить /setprivacy → Disable для этого
//     бота — БЕЗ этого бот не будет видеть обычные текстовые
//     сообщения в группе (только команды), и шаг "введите цену
//     текстом" не будет работать.
//  3. Зарегистрировать сам webhook (один раз, из терминала, замените
//     значения на свои):
//     curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
//       -d "url=https://<ваш-домен>.vercel.app/api/telegram-webhook" \
//       -d "secret_token=<тот же TELEGRAM_WEBHOOK_SECRET>"
//  4. Проверить: curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
//     — там должен появиться ваш URL без pending_update_count ошибок.
//
// Как пользоваться в группе: любой участник пишет /find (или жмёт
// кнопку "🔍 Найти" в приветственном сообщении бота) и проходит
// короткий мастер из кнопок.

import { supabase } from './_supabase.js';
import { sendMessage, editMessageText, answerCallbackQuery, escapeHtml, deleteMessage } from './_telegramApi.js';
import { DISTRICTS, districtSlug, districtFromSlug } from './_districts.js';
import { parsePriceRange } from './_priceParser.js';
import { buildListingText, buildListingButtons } from './_listingMessage.js';
import { cleanAgentMessagesBatch } from './_cleanAgents.js';
import { parseSearchQuery } from './_aiSearch.js';
import { isDuplicateUpdate } from './_updateDedupe.js';
import { throwOnSupabaseError } from './_dbErrors.js';

const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const EXCHANGE_RATE_USD_UZS = Number(process.env.EXCHANGE_RATE_USD_UZS) || 11990;
const RESULTS_PAGE_SIZE = 5;
const SEARCH_WINDOW_DAYS = 14; // не тащим совсем старые объявления в поиск

// ---------- session (bot_sessions table) ----------

async function getSession(chatId, userId) {
  const startedAt = Date.now();
  const { data, error } = await supabase
    .from('bot_sessions')
    .select('state')
    .eq('chat_id', chatId)
    .eq('user_id', userId)
    .maybeSingle();
  console.info(`[perf] db.getSession ${Date.now() - startedAt}ms${error ? ' error' : ''}`);
  throwOnSupabaseError('getSession', error);
  return data?.state || null;
}

async function saveSession(chatId, userId, state) {
  const startedAt = Date.now();
  const { error } = await supabase
    .from('bot_sessions')
    .upsert({ chat_id: chatId, user_id: userId, state, updated_at: new Date().toISOString() });
  console.info(`[perf] db.saveSession ${Date.now() - startedAt}ms${error ? ' error' : ''}`);
  throwOnSupabaseError('saveSession', error);
}

function displayName(from) {
  if (!from) return 'Агент';
  if (from.username) return `@${from.username}`;
  return [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Агент';
}

// ---------- кнопки "Связался" / "Беру в работу" на карточках объявлений ----------
// Не часть мастера поиска (bot_sessions) — работают на самих
// сообщениях-объявлениях в супергруппах, независимо от сессии.

const LISTING_MESSAGE_FIELDS =
  'id, source, label_kind, flagged_agent, flagged_by, label_text, deal_type, property_type, rooms, title, area, price, district, phone, assigned_to, contacted, contacted_by, notes, url';

async function editListingMessage(chatId, messageId, listing) {
  await editMessageText(chatId, messageId, buildListingText(listing), {
    parse_mode: undefined,
    reply_markup: { inline_keyboard: buildListingButtons(listing) },
  });
  return listing;
}

async function refreshListingMessage(chatId, messageId, listingId) {
  const startedAt = Date.now();
  const { data: listing, error } = await supabase
    .from('listings')
    .select(LISTING_MESSAGE_FIELDS)
    .eq('id', listingId)
    .maybeSingle();
  console.info(`[perf] db.refreshListing ${Date.now() - startedAt}ms${error ? ' error' : ''}`);
  throwOnSupabaseError('refreshListingMessage', error);
  if (!listing) {
    console.error('Не удалось перечитать объявление для обновления карточки: не найдено');
    return null;
  }
  return editListingMessage(chatId, messageId, listing);
}

async function toggleContacted(chatId, messageId, listingId, agentName) {
  const readStartedAt = Date.now();
  const { data: current, error: readError } = await supabase
    .from('listings').select('contacted').eq('id', listingId).maybeSingle();
  console.info(`[perf] db.toggleContacted.read ${Date.now() - readStartedAt}ms${readError ? ' error' : ''}`);
  throwOnSupabaseError('toggleContacted.read', readError);
  if (!current) throw new Error('Объявление не найдено для отметки контакта');
  const next = !current.contacted;
  const updateStartedAt = Date.now();
  const { data: listing, error: updateError } = await supabase
    .from('listings')
    .update({
      contacted: next,
      contacted_by: next ? agentName : null,
      contacted_at: next ? new Date().toISOString() : null,
    })
    .eq('id', listingId)
    .select(LISTING_MESSAGE_FIELDS)
    .maybeSingle();
  console.info(`[perf] db.toggleContacted.update ${Date.now() - updateStartedAt}ms${updateError ? ' error' : ''}`);
  throwOnSupabaseError('toggleContacted.update', updateError);
  if (listing) await editListingMessage(chatId, messageId, listing);
}

async function toggleAssigned(chatId, messageId, listingId, agentName) {
  const readStartedAt = Date.now();
  const { data: current, error: readError } = await supabase
    .from('listings').select('assigned_to').eq('id', listingId).maybeSingle();
  console.info(`[perf] db.toggleAssigned.read ${Date.now() - readStartedAt}ms${readError ? ' error' : ''}`);
  throwOnSupabaseError('toggleAssigned.read', readError);
  if (!current) throw new Error('Объявление не найдено для назначения');
  if (current.assigned_to && current.assigned_to !== agentName) return;
  const next = current.assigned_to ? null : agentName;
  const updateStartedAt = Date.now();
  const { data: listing, error: updateError } = await supabase
    .from('listings')
    .update({ assigned_to: next, assigned_at: next ? new Date().toISOString() : null })
    .eq('id', listingId)
    .select(LISTING_MESSAGE_FIELDS)
    .maybeSingle();
  console.info(`[perf] db.toggleAssigned.update ${Date.now() - updateStartedAt}ms${updateError ? ' error' : ''}`);
  throwOnSupabaseError('toggleAssigned.update', updateError);
  if (listing) await editListingMessage(chatId, messageId, listing);
}


function dealTypeKeyboard() {
  return [[{ text: '🔑 Аренда', callback_data: 'dt:rent' }, { text: '🏷️ Продажа', callback_data: 'dt:sale' }]];
}

function propertyTypeKeyboard() {
  return [
    [{ text: '🏢 Квартиры', callback_data: 'pt:apartment' }, { text: '🏡 Дома', callback_data: 'pt:house' }],
    [{ text: '🏬 Коммерция', callback_data: 'pt:commercial' }, { text: '🤷 Неважно', callback_data: 'pt:any' }],
  ];
}

function districtKeyboard(selected) {
  const rows = [];
  for (let i = 0; i < DISTRICTS.length; i += 2) {
    const row = DISTRICTS.slice(i, i + 2).map((d) => {
      const slug = districtSlug(d.canonical);
      const mark = selected.includes(d.canonical) ? '✅ ' : '';
      return { text: `${mark}${d.canonical}`, callback_data: `d:${slug}` };
    });
    rows.push(row);
  }
  rows.push([{ text: '🌆 Любой район', callback_data: 'd:any' }]);
  rows.push([{ text: '➡️ Далее', callback_data: 'd:done' }]);
  return rows;
}

function roomsKeyboard(selected) {
  const row1 = ['1', '2', '3', '4'].map((n) => {
    const mark = selected.includes(n) ? '✅ ' : '';
    return { text: `${mark}${n}`, callback_data: `r:${n}` };
  });
  const mark5 = selected.includes('5plus') ? '✅ ' : '';
  return [
    row1,
    [{ text: `${mark5}5+`, callback_data: 'r:5plus' }],
    [{ text: '🤷 Неважно', callback_data: 'r:any' }, { text: '➡️ Далее', callback_data: 'r:done' }],
  ];
}

function priceKeyboard() {
  return [[{ text: '💸 Без ограничений по цене', callback_data: 'p:any' }]];
}

const PRICE_STEP_TEXT =
  'Диапазон цены?\n\nОтветьте (Reply) на это сообщение, например: <code>300-800 млн</code>, <code>от 2 млрд</code>, <code>500-1500$</code> — или нажмите кнопку ниже, если цена неважна.';

const AREA_STEP_TEXT =
  'Площадь, м²?\n\nОтветьте (Reply) на это сообщение, например: <code>50-100</code>, <code>от 200</code> — или нажмите кнопку ниже, если площадь неважна.';

function areaKeyboard() {
  return [[{ text: '📐 Без ограничений по площади', callback_data: 'a:any' }]];
}

// Комнатность не применима к коммерции (офис/склад/магазин — это
// площадь, а не комнаты, по просьбе Владика 24.08.2026), поэтому для
// неё пропускаем шаг "Сколько комнат?" и вместо этого спрашиваем
// площадь — а для квартир/домов, наоборот, площадь пока не спрашиваем
// (она не так критична при поиске квартиры, комнатность важнее).
function goToRoomsOrPriceStep(session, filters) {
  if (filters.propertyType === 'commercial') {
    filters.rooms = [];
    session.step = 'area';
  } else {
    session.step = 'rooms';
  }
}

function sendRoomsOrPriceMessage(chatId, messageId, filters) {
  if (filters.propertyType === 'commercial') {
    return editMessageText(chatId, messageId, AREA_STEP_TEXT, { reply_markup: { inline_keyboard: areaKeyboard() } });
  }
  return editMessageText(chatId, messageId, 'Сколько комнат? (можно выбрать несколько)', {
    reply_markup: { inline_keyboard: roomsKeyboard(filters.rooms) },
  });
}

function resultsKeyboard(hasMore, hasPrev) {
  const row = [];
  // По просьбе пользователя (20.08.2026): "Ещё" сдвигал offset только
  // вперёд — старые уже показанные объявления пролистать назад было
  // нельзя. Добавили симметричную кнопку "Назад" — она просто уменьшает
  // тот же offset (см. 'back' в handleCallback), список результатов
  // (state.results) уже целиком лежит в сессии, повторный поиск не нужен.
  if (hasPrev) row.push({ text: '⬅️ Назад', callback_data: 'back' });
  if (hasMore) row.push({ text: '➡️ Ещё', callback_data: 'more' });
  return [row, [{ text: '🔄 Новый поиск', callback_data: 'new' }]];
}

// Telegram передаёт message_thread_id только в супергруппах с
// включёнными "темами" (forum topics) — и только когда сообщение
// реально отправлено внутри конкретной темы (не в "General"). Раньше
// бот всегда отвечал через обычный sendMessage без этого поля —
// Telegram в таком случае кладёт ответ в General, а не в ту тему, где
// человек написал команду (жалоба пользователя 20.08.2026). Просто
// подмешиваем это поле в extra для sendMessage, где он есть, и
// молча ничего не добавляем, если сообщение вне тем (обычный чат/
// группа без тем, или тема "General", у которой thread_id нет).
function threadExtra(threadId) {
  return threadId ? { message_thread_id: threadId } : {};
}

async function toggleFlaggedAgent(chatId, messageId, listingId, agentName) {
  const readStartedAt = Date.now();
  const { data: current, error: readError } = await supabase
    .from('listings').select('flagged_agent, label_kind').eq('id', listingId).maybeSingle();
  console.info(`[perf] db.toggleFlagged.read ${Date.now() - readStartedAt}ms${readError ? ' error' : ''}`);
  throwOnSupabaseError('toggleFlaggedAgent.read', readError);
  if (!current) throw new Error('Объявление не найдено для изменения метки');
  const next = !current.flagged_agent;
  const updateStartedAt = Date.now();
  const { error: updateError } = await supabase
    .from('listings')
    .update({
      flagged_agent: next,
      flagged_by: next ? agentName : null,
      flagged_at: next ? new Date().toISOString() : null,
      label_kind: next ? 'agent' : current.label_kind,
    })
    .eq('id', listingId);
  console.info(`[perf] db.toggleFlagged.update ${Date.now() - updateStartedAt}ms${updateError ? ' error' : ''}`);
  throwOnSupabaseError('toggleFlaggedAgent.update', updateError);

  if (next) {
    // Раньше тут просто обновлялась карточка (бейдж "Похоже на
    // агентство") — сообщение оставалось висеть в чате и дальше
    // мешало. По просьбе пользователя: если кто-то в группе пометил
    // объявление как агента, сообщение сразу убирается из чата, а не
    // просто перекрашивается. Снятие пометки (next === false) ничего
    // не восстанавливает — Telegram не даёт "отменить" удаление,
    // сообщение всё равно уже отправлено один раз в прошлом.
    const deleted = await deleteMessage(chatId, messageId);
    if (deleted) {
      const { error: deletedError } = await supabase.from('listings').update({ telegram_deleted: true }).eq('id', listingId);
      throwOnSupabaseError('toggleFlaggedAgent.markDeleted', deletedError);
      return;
    }
    // Не удалилось (например, сообщению больше 48 часов — Telegram
    // сам такое запрещает удалять ботам) — хотя бы обновляем карточку,
    // как раньше, чтобы было видно пометку.
    await refreshListingMessage(chatId, messageId, listingId);
    return;
  }

  await refreshListingMessage(chatId, messageId, listingId);
}

// Заметки не пишутся мастером/кнопками (Telegram не даёт открыть
// текстовое поле по кнопке) — вместо этого просим агента ОТВЕТИТЬ
// (Reply) на специальное сообщение-приглашение, которое бот отправляет
// сам. Так надёжнее, чем "просто следующее сообщение в чате" — в
// групповом чате между нажатием кнопки и ответом агента может
// проскочить сообщение от кого-то другого.
async function promptForNote(chatId, cardMessageId, listingId, userId, threadId) {
  const res = await sendMessage(chatId, '✏️ Напишите заметку ОТВЕТОМ (Reply) на это сообщение.', {
    reply_to_message_id: cardMessageId,
    ...threadExtra(threadId),
  });
  const promptMessageId = res?.result?.message_id;
  if (!promptMessageId) return;
  await saveSession(chatId, userId, { mode: 'awaiting_note', listingId, cardMessageId, promptMessageId });
}

async function tryHandleNoteReply(message) {
  // Большинство апдейтов (включая /start и обычные команды) не являются
  // ответом на prompt заметки. Не ходим в Supabase за bot_sessions для
  // каждого такого сообщения: это лишний сетевой round-trip перед
  // обработкой даже самых простых команд.
  if (!message.reply_to_message || !message.text || !message.from) return false;

  const chatId = message.chat.id;
  const userId = message.from.id;
  const session = await getSession(chatId, userId);
  if (session?.mode !== 'awaiting_note') return false;
  if (!message.text || message.reply_to_message?.message_id !== session.promptMessageId) return false;

  await supabase.from('listings').update({ notes: message.text.slice(0, 500) }).eq('id', session.listingId);
  await refreshListingMessage(chatId, session.cardMessageId, session.listingId);
  await saveSession(chatId, userId, {});
  await sendMessage(chatId, '📝 Заметка сохранена.', threadExtra(message.message_thread_id));
  return true;
}

// ---------- text helpers ----------

const DEAL_LABEL = { rent: '🔑 Аренда', sale: '🏷️ Продажа' };
const PROPERTY_LABEL = { apartment: '🏢 Квартиры', house: '🏡 Дома', commercial: '🏬 Коммерция', any: 'любой тип' };

function roomsLabel(rooms) {
  if (!rooms || !rooms.length) return 'неважно';
  return rooms.map((r) => (r === '5plus' ? '5+' : String(r))).join(', ');
}

function filtersSummary(filters) {
  const parts = [
    DEAL_LABEL[filters.dealType] || '',
    PROPERTY_LABEL[filters.propertyType] || '',
    filters.districts?.length ? filters.districts.join(', ') : 'любой район',
  ];
  if (filters.propertyType === 'commercial') {
    if (filters.areaRange) {
      const { min, max } = filters.areaRange;
      if (min && max) parts.push(`площадь: ${min}–${max} м²`);
      else if (min) parts.push(`площадь: от ${min} м²`);
      else if (max) parts.push(`площадь: до ${max} м²`);
    }
  } else {
    parts.push(`комнат: ${roomsLabel(filters.rooms)}`);
  }
  if (filters.priceRange) {
    const { min, max, currency } = filters.priceRange;
    const unit = currency === 'USD' ? '$' : 'сум';
    if (min && max) parts.push(`цена: ${min.toLocaleString('ru')}–${max.toLocaleString('ru')} ${unit}`);
    else if (min) parts.push(`цена: от ${min.toLocaleString('ru')} ${unit}`);
    else if (max) parts.push(`цена: до ${max.toLocaleString('ru')} ${unit}`);
  }
  return parts.filter(Boolean).join(' · ');
}

function listingLine(l) {
  const badge = l.label_kind === 'owner' ? '✅' : l.label_kind === 'agent' ? '🏢' : '📋';
  const roomsPart = l.rooms ? `${l.rooms}-комн. ` : '';
  const areaPart = l.area ? `, ${l.area} м²` : '';
  const districtPart = l.district ? ` · 📍 ${l.district}` : '';
  return (
    `${badge} <b>${roomsPart}${escapeHtml(l.title)}${areaPart}</b>\n` +
    `💰 ${escapeHtml(l.price || 'цена не указана')}${districtPart}\n` +
    `${escapeHtml(l.url)}`
  );
}

// ---------- price range in UZS for comparison ----------

function toUzs(value, currency) {
  if (value === null || value === undefined) return null;
  return currency === 'USD' ? value * EXCHANGE_RATE_USD_UZS : value;
}

function listingPriceUzs(l) {
  return toUzs(l.price_value, l.price_currency);
}

// ---------- search ----------

async function runSearch(filters) {
  // Выбираем только поля, которые реально нужны поиску и карточкам.
  // select('*') загружал десятки полей на каждое объявление, хотя сессия
  // хранит максимум 100 результатов; это лишний трафик и JSON-парсинг.
  let query = supabase
    .from('listings')
    .select('id, title, price, district, rooms, area, url, label_kind, created_at, price_value, price_currency, raw_text')
    .order('created_at', { ascending: false })
    .range(0, 999);

  // Агентства (label_kind='agent') не показываем — как и на сайте/в
  // push-уведомлениях, их снова полностью скрываем.
  query = query.neq('label_kind', 'agent');

  if (filters.dealType) query = query.eq('deal_type', filters.dealType);
  if (filters.propertyType && filters.propertyType !== 'any') query = query.eq('property_type', filters.propertyType);
  if (filters.districts?.length) query = query.in('district', filters.districts);
  // filters.rooms теперь массив (можно искать сразу "2 и 3 комнаты",
  // как и раньше можно было выбрать сразу несколько районов) — по
  // просьбе Владика 24.08.2026. Supabase не даёт напрямую смешать
  // .in() и .gte() одним вызовом на одну колонку, поэтому при наличии
  // "5plus" вместе с обычными числами собираем OR-условие вручную.
  if (filters.rooms?.length) {
    const numeric = filters.rooms.filter((r) => r !== '5plus').map(Number);
    const has5plus = filters.rooms.includes('5plus');
    if (has5plus && numeric.length) {
      query = query.or(`rooms.in.(${numeric.join(',')}),rooms.gte.5`);
    } else if (has5plus) {
      query = query.gte('rooms', 5);
    } else if (numeric.length) {
      query = query.in('rooms', numeric);
    }
  }

  const cutoff = new Date(Date.now() - SEARCH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  query = query.gte('created_at', cutoff);

  const dbStartedAt = Date.now();
  const { data, error } = await query;
  console.info(`[perf] db.runSearch ${Date.now() - dbStartedAt}ms rows=${data?.length ?? 0}${error ? ' error' : ''}`);
  if (error) {
    console.error('Ошибка поиска в Supabase:', error.message);
    return [];
  }

  let results = data || [];

  if (filters.priceRange) {
    const minUzs = toUzs(filters.priceRange.min, filters.priceRange.currency);
    const maxUzs = toUzs(filters.priceRange.max, filters.priceRange.currency);
    results = results.filter((l) => {
      const priceUzs = listingPriceUzs(l);
      if (priceUzs === null) return false; // без цены — не знаем, попадает ли в диапазон
      if (minUzs !== null && priceUzs < minUzs) return false;
      if (maxUzs !== null && priceUzs > maxUzs) return false;
      return true;
    });
  }

  // Площадь — по просьбе Владика 24.08.2026: для коммерции комнат нет,
  // но площадь как раз то, по чему там реально фильтруют. Та же логика,
  // что и с ценой: без площади в объявлении — не знаем, попадает ли в
  // диапазон, лучше отбросить, чем показать заведомо нерелевантное.
  if (filters.areaRange) {
    const { min, max } = filters.areaRange;
    results = results.filter((l) => {
      if (l.area == null) return false;
      if (min != null && l.area < min) return false;
      if (max != null && l.area > max) return false;
      return true;
    });
  }

  // Собственники сверху, дальше новые сверху — та же логика, что и на сайте.
  const rank = { owner: 0, unchecked: 1, uncertain: 2, agent: 3 };
  results.sort((a, b) => {
    const rd = (rank[a.label_kind] ?? 1) - (rank[b.label_kind] ?? 1);
    if (rd !== 0) return rd;
    return new Date(b.created_at) - new Date(a.created_at);
  });

  // В сессию кладём только компактные поля — полная строка на 100+
  // объявлений в jsonb не нужна и раздувает таблицу.
  return results.slice(0, 100).map((l) => ({
    title: l.title,
    price: l.price,
    district: l.district,
    rooms: l.rooms,
    area: l.area,
    url: l.url,
    label_kind: l.label_kind,
  }));
}

async function renderResultsPage(chatId, messageId, state) {
  const { results, offset, filters } = state;
  const page = results.slice(offset, offset + RESULTS_PAGE_SIZE);
  const hasMore = offset + RESULTS_PAGE_SIZE < results.length;
  const hasPrev = offset > 0;

  let text;
  if (results.length === 0) {
    text = `😕 По фильтру ничего не нашлось за последние ${SEARCH_WINDOW_DAYS} дней.\n\n<i>${filtersSummary(filters)}</i>`;
  } else {
    const header = `🔎 Найдено: ${results.length}\n<i>${filtersSummary(filters)}</i>\n\n`;
    text = header + page.map(listingLine).join('\n\n');
  }

  await editMessageText(chatId, messageId, text, { reply_markup: { inline_keyboard: resultsKeyboard(hasMore, hasPrev) } });
}

// ---------- main step handlers ----------

async function startWizard(chatId, userId, existingMessageId, threadId) {
  const text = 'Выберите тип сделки:';
  const markup = { reply_markup: { inline_keyboard: dealTypeKeyboard() } };

  let messageId = existingMessageId;
  if (existingMessageId) {
    await editMessageText(chatId, existingMessageId, text, markup);
  } else {
    const res = await sendMessage(chatId, text, { ...markup, ...threadExtra(threadId) });
    messageId = res?.result?.message_id;
  }

  await saveSession(chatId, userId, {
    step: 'deal_type',
    menuMessageId: messageId,
    filters: { districts: [], rooms: [] },
  });
}

async function handleCallback(update) {
  const cb = update.callback_query;
  // Inline callbacks без message не поддерживаются этим мастером.
  if (!cb?.message || !cb?.from?.id) return;
  const data = cb.data || '';
  const chatId = cb.message.chat.id;
  const userId = cb.from.id;
  const messageId = cb.message.message_id;

  // Кнопки на карточках объявлений ("Связался"/"Беру в работу") — не
  // часть мастера поиска, обрабатываем сразу и выходим, до всей
  // остальной логики сессий ниже.
  if (data.startsWith('ct:')) {
    await toggleContacted(chatId, messageId, data.slice(3), displayName(cb.from));
    return;
  }
  if (data.startsWith('as:')) {
    await toggleAssigned(chatId, messageId, data.slice(3), displayName(cb.from));
    return;
  }
  if (data.startsWith('fl:')) {
    await toggleFlaggedAgent(chatId, messageId, data.slice(3), displayName(cb.from));
    return;
  }
  if (data.startsWith('nt:')) {
    await promptForNote(chatId, messageId, data.slice(3), userId, cb.message.message_thread_id);
    return;
  }

  if (data === 'new') {
    await startWizard(chatId, userId, messageId);
    return;
  }

  const session = await getSession(chatId, userId);
  if (!session) {
    // Сессия потерялась (истекла/сброшена) — начинаем заново на этом же сообщении.
    await startWizard(chatId, userId, messageId);
    return;
  }
  const filters = session.filters;

  if (data.startsWith('dt:')) {
    filters.dealType = data.slice(3);
    session.step = 'property_type';
    await editMessageText(chatId, messageId, 'Тип недвижимости:', {
      reply_markup: { inline_keyboard: propertyTypeKeyboard() },
    });
  } else if (data.startsWith('pt:')) {
    filters.propertyType = data.slice(3);
    session.step = 'district';
    await editMessageText(chatId, messageId, 'Район (можно выбрать несколько):', {
      reply_markup: { inline_keyboard: districtKeyboard(filters.districts) },
    });
  } else if (data.startsWith('d:')) {
    const slug = data.slice(2);
    if (slug === 'any') {
      filters.districts = [];
      goToRoomsOrPriceStep(session, filters);
      await sendRoomsOrPriceMessage(chatId, messageId, filters);
    } else if (slug === 'done') {
      goToRoomsOrPriceStep(session, filters);
      await sendRoomsOrPriceMessage(chatId, messageId, filters);
    } else {
      const canonical = districtFromSlug(slug);
      if (canonical) {
        const idx = filters.districts.indexOf(canonical);
        if (idx === -1) filters.districts.push(canonical);
        else filters.districts.splice(idx, 1);
      }
      await editMessageText(chatId, messageId, 'Район (можно выбрать несколько):', {
        reply_markup: { inline_keyboard: districtKeyboard(filters.districts) },
      });
    }
  } else if (data.startsWith('r:')) {
    const val = data.slice(2);
    if (val === 'any') {
      filters.rooms = [];
      session.step = 'price';
      await editMessageText(chatId, messageId, PRICE_STEP_TEXT, { reply_markup: { inline_keyboard: priceKeyboard() } });
    } else if (val === 'done') {
      session.step = 'price';
      await editMessageText(chatId, messageId, PRICE_STEP_TEXT, { reply_markup: { inline_keyboard: priceKeyboard() } });
    } else {
      filters.rooms = filters.rooms || [];
      const idx = filters.rooms.indexOf(val);
      if (idx === -1) filters.rooms.push(val);
      else filters.rooms.splice(idx, 1);
      await editMessageText(chatId, messageId, 'Сколько комнат? (можно выбрать несколько)', {
        reply_markup: { inline_keyboard: roomsKeyboard(filters.rooms) },
      });
    }
  } else if (data === 'a:any') {
    filters.areaRange = null;
    session.step = 'price';
    await editMessageText(chatId, messageId, PRICE_STEP_TEXT, { reply_markup: { inline_keyboard: priceKeyboard() } });
  } else if (data === 'p:any') {
    filters.priceRange = null;
    const results = await runSearch(filters);
    session.step = 'results';
    session.results = results;
    session.offset = 0;
    await renderResultsPage(chatId, messageId, session);
  } else if (data === 'more') {
    session.offset = (session.offset || 0) + RESULTS_PAGE_SIZE;
    await renderResultsPage(chatId, messageId, session);
  } else if (data === 'back') {
    session.offset = Math.max(0, (session.offset || 0) - RESULTS_PAGE_SIZE);
    await renderResultsPage(chatId, messageId, session);
  }

  await saveSession(chatId, userId, session);
}

// Простой парсер диапазона площади (м²) — без валюты/множителей
// ("млн"/"сум"), в отличие от parsePriceRange. Тот же порядок
// попыток: "50-100", "от 200", "до 80", просто "60" (трактуем как
// потолок, чтобы не отсекать чуть меньшие варианты).
function parseAreaRange(text) {
  if (!text) return null;
  const raw = String(text).trim().replace(',', '.');
  const rangeMatch = raw.match(/(\d+(?:\.\d+)?)\s*(?:-|–|—|до)\s*(\d+(?:\.\d+)?)/i);
  if (rangeMatch) return { min: parseFloat(rangeMatch[1]), max: parseFloat(rangeMatch[2]) };
  const fromMatch = raw.match(/от\s*(\d+(?:\.\d+)?)/i);
  if (fromMatch) return { min: parseFloat(fromMatch[1]), max: null };
  const toMatch = raw.match(/до\s*(\d+(?:\.\d+)?)/i);
  if (toMatch) return { min: null, max: parseFloat(toMatch[1]) };
  const single = raw.match(/(\d+(?:\.\d+)?)/);
  if (single) return { min: null, max: parseFloat(single[1]) };
  return null;
}

async function handleAreaTextReply(message, loadedSession) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const session = loadedSession === undefined ? await getSession(chatId, userId) : loadedSession;
  if (!session || session.step !== 'area') return false;

  const parsed = parseAreaRange(message.text);
  if (!parsed) {
    await sendMessage(
      chatId,
      '🤔 Не понял площадь. Попробуйте, например: <code>50-100</code> или <code>от 200</code>.',
      threadExtra(message.message_thread_id)
    );
    return true;
  }

  session.filters.areaRange = parsed;
  session.step = 'price';
  await editMessageText(chatId, session.menuMessageId, PRICE_STEP_TEXT, { reply_markup: { inline_keyboard: priceKeyboard() } });
  await saveSession(chatId, userId, session);
  return true;
}

async function handlePriceTextReply(message, loadedSession) {
  const chatId = message.chat.id;
  const userId = message.from.id;
  const session = loadedSession === undefined ? await getSession(chatId, userId) : loadedSession;
  if (!session) return false;

  // Раньше это работало ТОЛЬКО сразу после шага "Диапазон цены?"
  // (session.step === 'price') — если человек уже увидел результаты
  // и решил просто прислать новый диапазон ответом на них (не
  // перезапуская весь /find с нуля), ничего не происходило (жалоба
  // Владика 24.08.2026: "100000$-100000$" в реплае к результатам
  // тихо игнорировался). Теперь это работает и после результатов —
  // но ТОЛЬКО если текст реально похож на диапазон цены: на шаге
  // 'price' мы явно его ждём (и переспрашиваем, если не поняли), а
  // на шаге 'results' — если текст не распознан как цена, просто
  // молча выходим, чтобы не превращать любой случайный реплай на
  // карточку в "🤔 Не понял диапазон".
  const atPriceStep = session.step === 'price';
  const atResultsStep = session.step === 'results';
  if (!atPriceStep && !atResultsStep) return false;

  const parsed = parsePriceRange(message.text);
  if (!parsed) {
    if (!atPriceStep) return false;
    await sendMessage(
      chatId,
      '🤔 Не понял диапазон. Попробуйте, например: <code>300-800 млн</code> или <code>от 500$</code>.',
      threadExtra(message.message_thread_id)
    );
    return true;
  }

  session.filters.priceRange = parsed;
  const results = await runSearch(session.filters);
  session.step = 'results';
  session.results = results;
  session.offset = 0;
  await renderResultsPage(chatId, session.menuMessageId, session);
  await saveSession(chatId, userId, session);
  return true;
}

// ---------- /search (ИИ-поиск свободным текстом) ----------
//
// Независим от мастера /find (тот сейчас выключен, см.
// FIND_WIZARD_ENABLED ниже) — не требует пошагового выбора кнопками,
// сразу разбирает всю фразу через ту же логику, что и на сайте (см.
// api/ai-search.js и общий модуль api/_aiSearch.js), и показывает
// результат тем же renderResultsPage/resultsKeyboard, что уже
// использует runSearch — то есть кнопки "ещё"/пагинация работают
// одинаково, откуда бы ни пришёл список результатов.

// Та же эвристика валюты по умолчанию, что и в _priceParser.js
// (detectCurrency, не экспортирована оттуда) — используется, только
// если ИИ распознал сумму, но НЕ распознал валюту явно (в тексте не
// было ни "$"/"баксов", ни "сум"): небольшие числа обычно означают
// доллары, крупные — сумы. Если модель вообще не увидела валюту явно,
// разумный дефолт лучше, чем показать диапазон без единиц измерения.
function guessCurrency(sampleValue) {
  return sampleValue !== null && sampleValue !== undefined && sampleValue < 100000 ? 'USD' : 'UZS';
}

async function handleAiSearch(chatId, userId, queryText, threadId) {
  const thinkingRes = await sendMessage(chatId, '🔎 Ищу…', threadExtra(threadId));
  const thinkingMessageId = thinkingRes?.result?.message_id;

  const parsed = await parseSearchQuery(queryText);

  if (!parsed.ok) {
    // unparseable — единственный случай, где дело реально может быть
    // в формулировке запроса. Всё остальное (rate_limited/bad_response/
    // timeout_or_network) — проблема на стороне сервиса, а не текста
    // пользователя; "переформулируйте" в этих случаях враньё — человек
    // будет пробовать другие слова, получать ту же ошибку и решит, что
    // сломан поиск вообще, а не то, что ИИ-сервис временно перегружен
    // (см. RETRYABLE_STATUSES в _aiSearch.js — retry там уже встроен,
    // если сообщение всё равно долетело сюда — значит и повтор не спас).
    const text =
      parsed.reason === 'unavailable'
        ? '⚠️ ИИ-поиск не настроен (нет ANTHROPIC_API_KEY на сервере).'
        : parsed.reason === 'unparseable'
          ? '🤔 Не получилось распознать запрос — попробуйте переформулировать.'
          : parsed.reason === 'fallback_exhausted'
            ? '⚠️ ИИ-поиск не смог ответить ни через одного провайдера — попробуйте позже.'
          : '⏳ ИИ-поиск сейчас перегружен или недоступен — попробуйте через минуту.';
    if (thinkingMessageId) await editMessageText(chatId, thinkingMessageId, text);
    else await sendMessage(chatId, text, threadExtra(threadId));
    return;
  }

  const f = parsed.filters;

  // Тот же формат filters, что понимает уже существующий runSearch
  // (см. выше) — используемый и мастером /find, когда он включён.
  let priceRange = null;
  if (f.priceMin != null || f.priceMax != null) {
    priceRange = {
      min: f.priceMin,
      max: f.priceMax,
      currency: f.currency || guessCurrency(f.priceMax ?? f.priceMin),
    };
  }

  const filters = {
    dealType: f.deal || null,
    propertyType: f.type || 'any',
    districts: f.district || [],
    rooms: f.rooms || [], // теперь массив, как и district — можно сразу "2-3 комнаты" (см. _aiSearch.js)
    areaRange: f.areaMin != null || f.areaMax != null ? { min: f.areaMin, max: f.areaMax } : null,
    priceRange,
  };

  let results = await runSearch(filters);

  // f.q — то, что ИИ не смог разложить по полям (например конкретный
  // ЖК, "с ремонтом", пожелание по инфраструктуре) — фильтруем
  // ДОПОЛНИТЕЛЬНО текстовым совпадением. Раньше проверялся только
  // title — а такие детали почти всегда пишут в ОПИСАНИИ, а не в
  // заголовке (жалоба пользователя 24.08.2026: "чтобы иишка тоже
  // могла искать по описаниям"). runSearch делает select('*'), так
  // что raw_text (title+описание, см. run.js) уже есть в каждой
  // записи — используем его, как и обычный поиск на сайте
  // (client/api/listings.js: title/district/raw_text через ilike).
  if (f.q) {
    const needle = f.q.toLowerCase();
    results = results.filter((l) => (l.raw_text || l.title || '').toLowerCase().includes(needle));
  }

  const state = { filters, results, offset: 0 };

  if (thinkingMessageId) {
    await renderResultsPage(chatId, thinkingMessageId, state);
    await saveSession(chatId, userId, { step: 'results', menuMessageId: thinkingMessageId, ...state });
  }
}

// Мастер поиска /find — кнопочный пошаговый фильтр (тип сделки →
// тип недвижимости → район → комнаты → цена), НЕЗАВИСИМЫЙ от /search
// (тот — свободный текст через ИИ). Был выключен 07.08.2026, когда
// объявления стали сами разлетаться по тематическим супергруппам
// (notifyToTopicGroup в scraper/src/telegram.js) — тогда казалось,
// что отдельный поиск через бота не нужен. По просьбе пользователя
// (20.08.2026) включаем обратно как отдельную команду — /search
// удобен, когда точно знаешь, что хочешь написать текстом, а /find —
// когда хочется просто потыкать кнопки без необходимости
// формулировать запрос. Команды не конфликтуют — у каждой своя ветка
// в handleMessage ниже, сессии (bot_sessions) общие, но handleAiSearch
// не трогает bot_sessions.step у мастера и наоборот.
const FIND_WIZARD_ENABLED = true;

function commandName(message) {
  const entity = (message.entities || []).find((e) => e.type === 'bot_command' && e.offset === 0);
  if (!entity) return null;
  return message.text.slice(0, entity.length).split('@')[0]; // срезаем @имя_бота, если есть
}

// Текст ПОСЛЕ команды — режем по entity.length (полная длина команды,
// включая "@ИмяБота", если Telegram его дописал), а НЕ по длине cmd из
// commandName() выше (та уже укорочена split('@')[0] и будет короче,
// если бота вызвали как "/search@ИмяБота текст" — тогда обрезка по
// cmd.length оставила бы в начале результата хвост "@ИмяБота").
function commandArgs(message) {
  const entity = (message.entities || []).find((e) => e.type === 'bot_command' && e.offset === 0);
  if (!entity) return '';
  return message.text.slice(entity.length).trim();
}

async function handleClean(chatId, threadId) {
  await sendMessage(chatId, '🧹 Чищу агентские посты...', threadExtra(threadId));
  try {
    const result = await cleanAgentMessagesBatch(25);
    let text = `Готово: удалено ${result.deleted}`;
    if (result.failed) text += `, не удалось ${result.failed}`;
    text += '.';
    if (result.hasMore) text += '\n\nЕщё остались — наберите /clean ещё раз.';
    if (result.processed === 0) text = 'Чистить нечего — новых агентских постов не найдено.';
    await sendMessage(chatId, text, threadExtra(threadId));
  } catch (err) {
    console.error('Ошибка команды /clean:', err);
    await sendMessage(chatId, `⚠️ Не получилось: ${err.message}`, threadExtra(threadId));
  }
}

async function handleMessage(message) {
  if (await tryHandleNoteReply(message)) return;

  // message_thread_id есть только в супергруппах с включёнными темами
  // (forum topics), и только когда сообщение отправлено внутри
  // конкретной темы — прокидываем его дальше, чтобы ответ бота ушёл
  // туда же, а не в General (см. threadExtra выше по файлу).
  const threadId = message.message_thread_id;

  const cmd = commandName(message);
  if (cmd === '/clean') {
    await handleClean(message.chat.id, threadId);
    return;
  }
  if (cmd === '/search' || cmd === '/найти') {
    const queryText = commandArgs(message);
    if (!queryText) {
      await sendMessage(
        message.chat.id,
        'Напишите после команды, что ищете, например:\n<code>/search 3-комнатная в Юнусабаде до 80000$, только от собственника</code>',
        threadExtra(threadId)
      );
      return;
    }
    await handleAiSearch(message.chat.id, message.from.id, queryText, threadId);
    return;
  }
  if (cmd === '/start') {
    // /start — просто приветствие с подсказкой по обеим командам, а не
    // сразу мастер: человек может добавить бота в группу и написать
    // /start случайно/не глядя — сразу вываливать пошаговый мастер
    // было бы навязчиво. Сам мастер — по явной команде /find (или
    // /filter/фильтр), см. ниже.
    await sendMessage(
      message.chat.id,
      '👋 Привет! Два способа искать:\n\n' +
        '🔍 <code>/find</code> — пошаговый фильтр кнопками (тип сделки, район, комнаты, цена)\n' +
        '💬 <code>/search текст</code> — опишите словами, например:\n<code>/search 3-комнатная в Юнусабаде до 80000$, только от собственника</code>',
      threadExtra(threadId)
    );
    return;
  }
  if (cmd === '/find' || cmd === '/filter' || cmd === '/фильтр') {
    if (!FIND_WIZARD_ENABLED) {
      await sendMessage(
        message.chat.id,
        'Поиск через кнопки сейчас выключен — объявления сами приходят в свою тему группы по типу и району.\n\n' +
          'Но можно спросить своими словами: <code>/search 3-комнатная в Юнусабаде до 80000$</code>',
        threadExtra(threadId)
      );
      return;
    }
    await startWizard(message.chat.id, message.from.id, null, threadId);
    return;
  }
  if (message.text && !cmd) {
    // Загружаем сессию один раз: раньше обычный текст мог вызвать два
    // последовательных SELECT (area, затем price) даже когда шаг не совпадал.
    const session = await getSession(message.chat.id, message.from.id);
    if (await handleAreaTextReply(message, session)) return;
    await handlePriceTextReply(message, session);
  }
}

// ---------- entrypoint ----------

export default async function handler(req, res) {
  const requestStartedAt = Date.now();
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method not allowed' });
    return;
  }

  const got = req.headers['x-telegram-bot-api-secret-token'];
  if (!WEBHOOK_SECRET || got !== WEBHOOK_SECRET) {
    res.status(401).json({ error: 'bad secret token' });
    return;
  }

  const update = req.body;
  if (isDuplicateUpdate(update?.update_id)) {
    console.info('[perf] webhook duplicate update skipped');
    res.status(200).json({ ok: true, duplicate: true });
    return;
  }

  try {
    if (update?.callback_query) {
      // Telegram requires a callback acknowledgement quickly. Do this before
      // any Supabase reads, edits, or business logic, and exactly once.
      const callbackId = update.callback_query.id;
      try {
        await answerCallbackQuery(callbackId);
      } catch (ackError) {
        console.error('[telegram] callback acknowledgement transport failure:', ackError.message);
      }
      const callbackStartedAt = Date.now();
      await handleCallback(update);
      console.info(`[perf] business.callback ${Date.now() - callbackStartedAt}ms`);
    } else if (update?.message) {
      const messageStartedAt = Date.now();
      await handleMessage(update.message);
      console.info(`[perf] business.message ${Date.now() - messageStartedAt}ms`);
    }
  } catch (err) {
    console.error('Ошибка обработки Telegram-апдейта:', err);
    const chatId = update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;
    const threadId = update?.message?.message_thread_id ?? update?.callback_query?.message?.message_thread_id;
    if (chatId) {
      try {
        await sendMessage(
          chatId,
          '⚠️ Что-то пошло не так при обработке запроса. Попробуйте ещё раз или начните заново: /find',
          threadExtra(threadId)
        );
      } catch (sendErr) {
        console.error('Не удалось отправить сообщение об ошибке:', sendErr.message);
      }
    }
  } finally {
    console.info(`[perf] webhook ${Date.now() - requestStartedAt}ms type=${update?.callback_query ? 'callback' : update?.message ? 'message' : 'other'}`);
  }

  res.status(200).json({ ok: true });
}

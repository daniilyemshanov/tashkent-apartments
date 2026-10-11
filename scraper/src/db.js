import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

// Supabase-клиент по умолчанию создаёт Realtime-подключение (даже если
// оно нам не нужно — мы им не пользуемся), а для этого ему нужен
// глобальный WebSocket. В Node.js < 22 его нет, поэтому передаём
// реализацию из пакета ws явно — так не зависим от того, какую версию
// Node.js фактически использует раннер GitHub Actions.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY, // service_role ключ — обходит RLS, только для бэкенда, никогда не светить на фронтенде
  {
    realtime: { transport: WebSocket },
  }
);

export async function isKnown(id) {
  const { data, error } = await supabase.from('listings').select('id').eq('id', id).maybeSingle();
  if (error) {
    console.error('Supabase (isKnown) ошибка:', error.message);
    return false; // при сбое лучше перепроверить объявление ещё раз, чем потерять его
  }
  return !!data;
}

/**
 * Достаёт уже сохранённое объявление целиком для сравнения с новым
 * скрапом. Нужен для "повторно увидели тот же id / ту же сущность" —
 * чтобы не парсить и не отправлять повторно без нужды.
 */
export async function getListingById(id) {
  const { data, error } = await supabase
    .from('listings')
    .select(
      'id, url, title, price, price_value, price_currency, price_per_sqm, raw_text, district, rooms, area, phone, phone_normalized, seller_name, seller_type, confidence, label_kind, label_text, seller_listings_count, market_segment, owner_score, is_duplicate, duplicate_of_id, duplicate_reason, entity_key, price_history, price_history_count, price_drop_count, price_change_count, last_price_change_pct, last_price_change_at, first_seen_price_value, last_seen_price_value, notified, created_at'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('Supabase (getListingById) ошибка:', error.message);
    return null;
  }
  return data || null;
}

/**
 * Ищет последнюю запись с тем же entity_key. Используется для
 * подавления дублей между разными id и для определения, считать ли
 * репост новым событием или просто повтором.
 */
export async function getLatestListingByEntityKey(entityKey, excludeId = null) {
  if (!entityKey) return null;
  let query = supabase
    .from('listings')
    .select(
      'id, url, title, price, price_value, price_currency, price_per_sqm, phone_normalized, district, rooms, area, entity_key, price_history, price_history_count, price_drop_count, price_change_count, last_price_change_pct, last_price_change_at, first_seen_price_value, last_seen_price_value, owner_score, notified, created_at'
    )
    .eq('entity_key', entityKey)
    .order('created_at', { ascending: false })
    .limit(1);
  if (excludeId) query = query.neq('id', excludeId);
  const { data, error } = await query.maybeSingle();
  if (error) {
    console.error('Supabase (getLatestListingByEntityKey) ошибка:', error.message);
    return null;
  }
  return data || null;
}

/**
 * @returns {Promise<boolean>} true, если запись реально сохранилась.
 * ВАЖНО: раньше эта функция ничего не возвращала, а ошибку просто
 * логировала — вызывающий код (run.js) не знал, что сохранение не
 * удалось, и всё равно слал уведомление в Telegram и пытался
 * отметить notified=true. Если строки в базе на самом деле не было,
 * markNotified молча обновлял 0 строк (без ошибки), и на следующем
 * прогоне isKnown() снова возвращал false — объявление уходило в
 * Telegram ПОВТОРНО. Теперь вызывающий код обязан проверять результат
 * и не слать уведомление, если сохранение не удалось.
 */
export async function saveListing(listing, previousListing = null) {
  const preserved = previousListing
    ? {
        contacted: previousListing.contacted ?? false,
        contacted_by: previousListing.contacted_by ?? null,
        contacted_at: previousListing.contacted_at ?? null,
        assigned_to: previousListing.assigned_to ?? null,
        assigned_at: previousListing.assigned_at ?? null,
        notes: previousListing.notes ?? null,
        flagged_agent: previousListing.flagged_agent ?? false,
        flagged_by: previousListing.flagged_by ?? null,
        flagged_at: previousListing.flagged_at ?? null,
        telegram_chat_id: previousListing.telegram_chat_id ?? null,
        telegram_message_id: previousListing.telegram_message_id ?? null,
        telegram_deleted: previousListing.telegram_deleted ?? false,
        notified: previousListing.notified ?? false,
      }
    : { contacted: false };
  const payload = { ...listing, ...preserved };
  const { error } = await supabase.from('listings').upsert(payload, { onConflict: 'id' });
  if (error) {
    console.error('Supabase (saveListing) ошибка:', error.message);
    return false;
  }
  return true;
}

/**
 * @param {string} id
 * @param {{chatId?: string|number, messageId?: number}} [sentTo] — если
 *   сообщение реально ушло в Telegram, сохраняем chat_id+message_id —
 *   это позволяет позже программно удалить конкретное сообщение
 *   (bot.deleteMessage), если объявление переклассифицируют в агента.
 *   Без этого удалять приходилось только вручную, вслепую ища по всем
 *   супергруппам (см. scraper/src/recheck-owners.js — там ссылки на
 *   темы для случаев, когда message_id ещё не был сохранён).
 */
export async function markNotified(id, sentTo) {
  const update = { notified: true };
  if (sentTo?.chatId) update.telegram_chat_id = String(sentTo.chatId);
  if (sentTo?.messageId) update.telegram_message_id = sentTo.messageId;
  const { error } = await supabase.from('listings').update(update).eq('id', id);
  if (error) {
    console.error('Supabase (markNotified) ошибка:', error.message);
  }
}

/**
 * Достаёт сохранённые chat_id/message_id для объявления — нужно перед
 * попыткой удалить его сообщение из Telegram (см. delete-agent-messages.js).
 */
export async function getTelegramMessageInfo(id) {
  const { data, error } = await supabase
    .from('listings')
    .select('telegram_chat_id, telegram_message_id, telegram_deleted')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    console.error('Supabase (getTelegramMessageInfo) ошибка:', error.message);
    return null;
  }
  return data;
}

export async function markTelegramDeleted(id) {
  const { error } = await supabase.from('listings').update({ telegram_deleted: true }).eq('id', id);
  if (error) {
    console.error('Supabase (markTelegramDeleted) ошибка:', error.message);
  }
}

/**
 * Считает, сколько ДРУГИХ объявлений в базе уже имеют этот же
 * (нормализованный) номер телефона — сильный сигнал агента: частник
 * крайне редко выставляет несколько РАЗНЫХ объявлений под одним и тем
 * же номером, а агентство/риелтор — постоянно (один контакт на много
 * объектов). Не зависит от вёрстки сайтов вообще — работает, даже
 * если завтра OLX/Uybor/Realting поменяют HTML.
 * @param {string|null} phoneNormalized — уже нормализованный номер (см. phone.js), не сырой
 * @param {string} excludeId — id текущего объявления, чтобы не считать само себя
 * @returns {Promise<number>} 0, если номера нет или произошла ошибка (при сбое не блокируем — лучше пропустить проверку, чем ошибочно посчитать всех агентами)
 */
export async function countListingsByPhone(phoneNormalized, excludeId) {
  if (!phoneNormalized) return 0;
  const { count, error } = await supabase
    .from('listings')
    .select('id', { count: 'exact', head: true })
    .eq('phone_normalized', phoneNormalized)
    .neq('id', excludeId);
  if (error) {
    console.error('Supabase (countListingsByPhone) ошибка:', error.message);
    return 0;
  }
  return count || 0;
}

/**
 * Возвращает message_thread_id темы для пары (groupKey, district),
 * или null, если такой темы ещё нет (тогда сообщение уйдёт в общую
 * тему группы без привязки к теме).
 */
export async function getTopicId(groupKey, district) {
  if (!district) return null;
  const { data, error } = await supabase
    .from('forum_topics')
    .select('message_thread_id')
    .eq('group_key', groupKey)
    .eq('district', district)
    .maybeSingle();
  if (error) {
    console.error('Supabase (getTopicId) ошибка:', error.message);
    return null;
  }
  return data?.message_thread_id ?? null;
}

/**
 * Сохраняет ID темы после того, как она создана в Telegram
 * (см. scraper/src/setup-topics.js).
 */
export async function saveTopicId(groupKey, district, messageThreadId) {
  const { error } = await supabase
    .from('forum_topics')
    .upsert({ group_key: groupKey, district, message_thread_id: messageThreadId }, { onConflict: 'group_key,district' });
  if (error) {
    console.error('Supabase (saveTopicId) ошибка:', error.message);
  }
}


import TelegramBot from 'node-telegram-bot-api';
import { getTopicId } from './db.js';

const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
// Личный chat_id (не группа) — куда идут служебные алерты о сбоях
// парсера (notifyAlert ниже), см. пояснение там. Отдельно от chatId
// выше: тот — общий чат с обычными карточками объявлений, туда
// алерты раньше падали вперемешку с ними и терялись.
const adminChatId = (process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();

let bot = null;
if (token) {
  // polling: false — боту не нужно ничего "слушать", он только отправляет
  bot = new TelegramBot(token, { polling: false });
}

/**
 * Проверка при старте — сразу видно в консоли, подключился ли бот
 * на самом деле, вместо того чтобы узнавать об этом только когда
 * первое уведомление не дойдёт.
 */
export async function checkTelegramConnection() {
  if (!token) {
    console.warn('⚠️  TELEGRAM_BOT_TOKEN не задан в .env — уведомления в Telegram работать не будут.');
    return;
  }
  if (!chatId) {
    console.warn('⚠️  TELEGRAM_CHAT_ID не задан в .env — уведомления в Telegram работать не будут.');
    return;
  }
  try {
    const me = await bot.getMe();
    console.log(`✅ Telegram-бот подключён: @${me.username}`);
  } catch (err) {
    console.error(`❌ Telegram-бот НЕ подключился: ${err.message}`);
    console.error('   Проверьте TELEGRAM_BOT_TOKEN в .env — возможно, скопирован не полностью.');
    return;
  }
  try {
    await bot.sendMessage(chatId, '✅ Бот подключён и готов присылать объявления.');
    console.log(`✅ Тестовое сообщение отправлено в chat_id ${chatId}`);
  } catch (err) {
    console.error(`❌ Не удалось отправить сообщение на chat_id "${chatId}": ${err.message}`);
    console.error('   Проверьте TELEGRAM_CHAT_ID в .env, и что вы нажали /start своему боту в Telegram.');
  }
}

// Хештеги в тексте сообщения — не отдельная функция бота, а просто
// слова вида #Чиланзар в самом сообщении. Telegram делает такие слова
// кликабельными и учитывает их во встроенном поиске по чату (можно
// набрать "#Чиланзар" в поиске чата и увидеть только эти объявления).
// Хештег не может содержать пробелы/дефисы/цифры-в-начале — чистим.
function toHashtag(word) {
  if (!word) return null;
  const cleaned = String(word)
    .replace(/['".,()]/g, '')
    .replace(/[\s\-]+/g, '');
  if (!cleaned) return null;
  return `#${cleaned}`;
}

function buildHashtags(listing) {
  const tags = [];
  const dealTag = listing.deal_type === 'sale' ? 'продажа' : listing.deal_type === 'rent' ? 'аренда' : null;
  if (dealTag) tags.push(toHashtag(dealTag));

  const typeTag =
    listing.property_type === 'house' ? 'дом' : listing.property_type === 'commercial' ? 'коммерция' : 'квартира';
  tags.push(toHashtag(typeTag));

  if (listing.district) tags.push(toHashtag(listing.district));
  if (listing.rooms) tags.push(toHashtag(`${listing.rooms}комн`));

  return tags.filter(Boolean).join(' ');
}

/**
 * Собирает текст сообщения и кнопки — общая логика для обоих
 * назначений (основная группа с /find и тематические супергруппы).
 */
// export — нужна отдельным разовым скриптам (см.
// scripts/backfill-telegram-segment-labels.js), которые правят текст
// УЖЕ отправленных сообщений задним числом, не переотправляя их.
export function buildMessagePayload(listing) {
  const roomsLine = listing.rooms ? `${listing.rooms}-комн. ` : '';
  const areaLine = listing.area ? `, ${listing.area} м²` : '';
  const districtLine = listing.district ? `📍 ${listing.district}\n` : '';
  const phoneLine = listing.phone ? `📞 ${listing.phone}\n` : '';
  const dealLine = listing.deal_type === 'sale' ? '🏷️ Продажа\n' : listing.deal_type === 'rent' ? '🔑 Аренда\n' : '';
  const typeLine =
    listing.property_type === 'house' ? '🏡 Дом\n' : listing.property_type === 'commercial' ? '🏢 Коммерция\n' : '';

  const badge =
    listing.label_kind === 'owner'
      ? '✅ Собственник'
      : listing.label_kind === 'unchecked'
        ? '🙂 Скорее всего собственник'
        : listing.label_kind === 'agent'
          ? '🏢 Похоже на агентство'
          : '❓ Сомнительно — проверьте сами';

  const message =
    `🏠 Новое объявление (${listing.source})\n` +
    `${badge}\n\n` +
    typeLine +
    `${roomsLine}${listing.title}${areaLine}\n` +
    `💰 ${listing.price || 'цена не указана'}\n` +
    districtLine +
    phoneLine +
    `\n${listing.url}`;

  const buttons = [];
  if (listing.phone) {
    const digits = listing.phone.replace(/[^\d]/g, '');
    // Кнопку "Позвонить" через url: 'tel:...' убрали — в Bot API
    // официально поддерживаются только http(s):// и tg:// (см. доки
    // InlineKeyboardButton), 'tel:' работает "на птичьих правах" и
    // иногда Telegram отвечает 400 Bad Request ("Wrong port number
    // specified in the URL") на конкретных номерах, роняя отправку
    // всего сообщения целиком. Номер телефона у нас и так есть текстом
    // в сообщении (phoneLine выше) — Telegram сам подсвечивает номера
    // кликабельными в тексте, кнопка для этого не нужна.
    buttons.push([{ text: '💬 Написать в WhatsApp', url: `https://wa.me/${digits}` }]);
  }
  buttons.push([{ text: '🔗 Открыть объявление', url: listing.url }]);
  // Кнопки статуса — при первой отправке объявление всегда ещё не
  // взято в работу и не отмечено "связался" (только что появилось),
  // поэтому кнопки в начальном виде. Дальше, при нажатии, webhook
  // (client/api/telegram-webhook.js) сам пересобирает и текст, и
  // кнопки сообщения под актуальный статус — см. buildListingButtons
  // в client/api/_listingMessage.js (та же логика формата кнопок,
  // продублирована по той же причине, что и в других местах между
  // scraper/ и client/api/: два разных deployable-проекта).
  buttons.push([
    { text: '✅ Связался', callback_data: `ct:${listing.id}` },
    { text: '👤 Беру в работу', callback_data: `as:${listing.id}` },
  ]);
  buttons.push([
    { text: '🚫 Это агент', callback_data: `fl:${listing.id}` },
    { text: '📝 Заметка', callback_data: `nt:${listing.id}` },
  ]);

  return { message, buttons };
}

// Telegram ограничивает caption у фото 1024 символами (у обычного
// текстового сообщения — 4096). Наш message из buildMessagePayload
// рассчитан на текстовый лимит, поэтому при отправке как фото его
// надо аккуратно обрезать, а не просто рубить посередине слова/строки.
// Обрезаем по последнему переносу строки ПЕРЕД лимитом — так не
// разрывается ни одна строка (например "💰 $170 000" не станет "💰 $17").
function trimToCaption(text, max = 1024) {
  if (text.length <= max) return text;
  const ellipsis = '\n…';
  const budget = max - ellipsis.length;
  const cut = text.slice(0, budget);
  const lastNewline = cut.lastIndexOf('\n');
  const safe = lastNewline > 0 ? cut.slice(0, lastNewline) : cut;
  return `${safe}${ellipsis}`;
}

/**
 * Общая точка отправки карточки объявления — используется во всех
 * назначениях (основной чат и тематические супергруппы).
 *
 * 21.08.2026: раньше везде был bot.sendMessage с disable_web_page_preview:
 * false — карточка выглядела прилично только благодаря автоматическому
 * превью Telegram, который сам подтягивал og:image/og:description со
 * страницы объявления. Из-за этого текст превью был не наш, а взят с
 * сайта-источника напрямую — отсюда кривые формулировки вроде "с
 * Высокие потолки" (Realting особенно этим грешит, но не только он).
 * У нас уже есть image_url в базе (см. imageUrl во всех 4 scrapers/*.js)
 * — просто нигде не использовался. Теперь: если image_url есть,
 * отправляем ФОТО с нашим текстом в caption (полный контроль над
 * содержимым, никакого чужого og:description). Если фото нет или
 * Telegram не смог его загрузить (битая ссылка, сайт блокирует
 * скачивание по прямой ссылке и т.п.) — откатываемся на обычное
 * текстовое сообщение, и ТОЛЬКО тогда явно выключаем встроенное
 * превью (disable_web_page_preview: true), чтобы не вернуть тот же
 * самый баг с чужим текстом в превью-карточке.
 *
 * @returns {Promise<{message: import('node-telegram-bot-api').Message, sentAsPhoto: boolean}>}
 */
async function sendListingCard(targetChatId, listing, { message, buttons }, extraOpts = {}) {
  if (listing.image_url) {
    try {
      const sent = await bot.sendPhoto(targetChatId, listing.image_url, {
        caption: trimToCaption(message),
        reply_markup: { inline_keyboard: buttons },
        ...extraOpts,
      });
      return { message: sent, sentAsPhoto: true };
    } catch (err) {
      // Частые причины: Telegram не смог скачать картинку по ссылке
      // (сайт-источник блокирует прямые запросы не из браузера, ссылка
      // уже протухла, формат не поддерживается). Не роняем всё
      // уведомление целиком — просто уходим в текстовый фоллбэк ниже.
      console.warn(
        `[sendListingCard] Не удалось отправить фото (${listing.image_url}) для "${listing.title}" — отправляю текстом:`,
        err.message
      );
    }
  }
  const sent = await bot.sendMessage(targetChatId, message, {
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: buttons },
    ...extraOpts,
  });
  return { message: sent, sentAsPhoto: false };
}

export async function notifyNewListing(listing) {
  if (!bot || !chatId) {
    console.warn('Telegram не настроен — пропускаю уведомление');
    return;
  }

  const payload = buildMessagePayload(listing);
  await sendListingCard(chatId, listing, payload);
}

// Соответствие property_type (+ deal_type для аренды квартир и
// аренды коммерции — у них отдельные супергруппы) → переменная
// окружения с chat_id группы.
// Экспортируем — нужно и другим скриптам (recheck-owners.js,
// delete-agent-messages.js), чтобы не дублировать эту же карту.
export const TOPIC_GROUPS = {
  apartment: (process.env.TELEGRAM_GROUP_APARTMENT || '').trim(),
  apartment_rent: (process.env.TELEGRAM_GROUP_APARTMENT_RENT || '').trim(),
  commercial: (process.env.TELEGRAM_GROUP_COMMERCIAL || '').trim(),
  commercial_rent: (process.env.TELEGRAM_GROUP_COMMERCIAL_RENT || '').trim(),
  house: (process.env.TELEGRAM_GROUP_HOUSE || '').trim(),
};

/**
 * Аренда квартир и аренда коммерции — случаи, где группа зависит не
 * только от property_type, но и от deal_type (продажа остаётся в
 * обычной группе "Квартиры"/"Коммерция"). Если соответствующая
 * TELEGRAM_GROUP_*_RENT ещё не настроена — просто уходит в общую
 * группу того же типа, как раньше, ничего не ломается.
 */
export function resolveGroupKey(listing) {
  if (listing.property_type === 'apartment' && listing.deal_type === 'rent' && TOPIC_GROUPS.apartment_rent) {
    return 'apartment_rent';
  }
  if (listing.property_type === 'commercial' && listing.deal_type === 'rent' && TOPIC_GROUPS.commercial_rent) {
    return 'commercial_rent';
  }
  return listing.property_type || 'apartment';
}

/**
 * Отправляет объявление в тему нужного района внутри одной из
 * супергрупп (Квартиры/Аренда квартир/Коммерция/Аренда коммерции/
 * Дома). Если группа для этого типа не настроена (нет в .env) —
 * просто ничего не делает, молча. Если район неизвестен/тема ещё не
 * создана (setup-topics.js не запускали для него) — уходит в общую
 * тему группы.
 *
 * @returns {Promise<{chatId: string, messageId: number}|null>} —
 *   данные отправленного сообщения (для сохранения в базе, чтобы потом
 *   можно было программно удалить это конкретное сообщение), или null,
 *   если отправка не удалась/не была настроена.
 */
export async function notifyToTopicGroup(listing) {
  const groupKey = resolveGroupKey(listing);
  const targetChatId = TOPIC_GROUPS[groupKey];
  if (!bot || !targetChatId) return null;

  const payload = buildMessagePayload(listing);
  const messageThreadId = await getTopicId(groupKey, listing.district);

  // 21.08.2026: самодиагностика — раньше отсутствие темы для района
  // молча "проглатывалось" (объявление просто уходило в общую тему
  // группы без единого следа в логах), из-за чего было невозможно
  // отличить "у объявления не определился район" от "тема для района
  // не создана в setup-topics.js" не копаясь руками в базе. Логируем
  // оба случая по отдельности.
  if (!messageThreadId) {
    if (!listing.district) {
      console.warn(
        `[notifyToTopicGroup] У объявления не определён район — уходит в общую тему группы "${groupKey}": ${listing.url}`
      );
    } else {
      console.warn(
        `[notifyToTopicGroup] Нет темы "${listing.district}" в группе "${groupKey}" (не запускали setup-topics.js для этого района?) — уходит в общую тему: ${listing.url}`
      );
    }
  }

  try {
    const sent = await sendListingCard(targetChatId, listing, payload, {
      ...(messageThreadId ? { message_thread_id: messageThreadId } : {}),
    });
    return { chatId: String(sent.message.chat.id), messageId: sent.message.message_id };
  } catch (err) {
    console.error(`Не удалось отправить в тематическую супергруппу (${groupKey}):`, err.message);
    return null;
  }
}

/**
 * Удаляет конкретное сообщение (используется, когда объявление задним
 * числом переклассифицировали в агента — см. recheck-owners.js).
 * Работает только для сообщений, у которых сохранены chat_id/message_id
 * (см. markNotified в db.js) — то есть отправленных ПОСЛЕ того, как
 * это стало сохраняться. Для более старых сообщений id не известен,
 * автоматически удалить нечем.
 */
export async function deleteTelegramMessage(chatId, messageId) {
  if (!bot || !chatId || !messageId) return false;
  try {
    await bot.deleteMessage(chatId, messageId);
    return true;
  } catch (err) {
    console.error(`Не удалось удалить сообщение ${messageId} в чате ${chatId}:`, err.message);
    return false;
  }
}

/**
 * Правит ТЕКСТ уже отправленного сообщения задним числом (например,
 * когда backfill проставил market_segment уже после отправки — см.
 * scripts/backfill-telegram-segment-labels.js). Намеренно НЕ трогает
 * reply_markup (кнопки) — если их не передавать в editMessageText,
 * Telegram оставляет текущую клавиатуру как есть. Это важно: кнопки
 * "✅ Связался"/"👤 Беру в работу" могли быть уже нажаты и пересобраны
 * в другое состояние через client/api/telegram-webhook.js — переотправка
 * "свежей" клавиатуры из buildMessagePayload откатила бы это состояние
 * визуально, хотя в базе (contacted/assigned) всё осталось бы верно.
 * Текст же статус не отражает (см. buildMessagePayload) — его редактировать безопасно.
 *
 * Как и deleteTelegramMessage — работает только для сообщений, у
 * которых сохранены chat_id/message_id (см. markNotified в db.js).
 */
export async function editNotifiedMessageText(listing) {
  if (!bot || !listing?.telegram_chat_id || !listing?.telegram_message_id) return false;
  const { message } = buildMessagePayload(listing);
  const target = { chat_id: listing.telegram_chat_id, message_id: listing.telegram_message_id };

  const isNotModified = (err) => /message is not modified/i.test(err.message);
  // "there is no text in the message to edit" — именно так Telegram
  // отвечает, когда пытаешься editMessageText на сообщении, которое
  // на самом деле фото с caption (см. sendListingCard выше, теперь
  // часть сообщений отправляется именно так). Раньше эта функция
  // всегда знала, что сообщение текстовое — теперь нет, поэтому
  // пробуем оба варианта редактирования вместо одного.
  const looksLikePhotoMessage = (err) => /no text in the message|message can't be edited|there is no caption/i.test(err.message);

  try {
    await bot.editMessageText(message, target);
    return true;
  } catch (err) {
    if (isNotModified(err)) return true;
    if (!looksLikePhotoMessage(err)) {
      console.error(`Не удалось отредактировать сообщение ${listing.telegram_message_id} в чате ${listing.telegram_chat_id}:`, err.message);
      return false;
    }
  }

  try {
    await bot.editMessageCaption(trimToCaption(message), target);
    return true;
  } catch (err) {
    if (isNotModified(err)) return true;
    console.error(`Не удалось отредактировать caption сообщения ${listing.telegram_message_id} в чате ${listing.telegram_chat_id}:`, err.message);
    return false;
  }
}

/**
 * Служебные алерты о сбоях парсера (сайт не открылся, селекторы
 * перестали находить объявления и т.п.) — чтобы вы узнали о проблеме
 * сразу, а не через неделю тишины, гадая, закончились ли объявления.
 *
 * Идут ЛИЧНО вам через бота (TELEGRAM_ADMIN_CHAT_ID), а не в общий
 * чат с объявлениями (TELEGRAM_CHAT_ID) — раньше алерты падали в
 * общий чат вперемешку с обычными карточками и терялись в потоке
 * (см. диагностику 15.08.2026 — обнаружили молчание Realting только
 * по скриншоту, спустя несколько часов). Если TELEGRAM_ADMIN_CHAT_ID
 * не задан — алерт просто не отправится (см. предупреждение в
 * консоли), это не ломает остальной пайплайн.
 */
export async function notifyAlert(text) {
  if (!bot || !adminChatId) {
    if (!adminChatId) {
      console.warn('⚠️  TELEGRAM_ADMIN_CHAT_ID не задан — алерт не отправлен:', text);
    }
    return;
  }
  try {
    await bot.sendMessage(adminChatId, text);
  } catch (err) {
    console.error('Не удалось отправить алерт в Telegram:', err.message);
  }
}
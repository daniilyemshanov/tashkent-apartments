// Разовый скрипт настройки. Запускать вручную ОДИН РАЗ (или заново —
// если досоздали новый район), после того как:
//   1. Созданы супергруппы в Telegram (по одной на каждый заполненный
//      TELEGRAM_GROUP_* ниже)
//   2. В каждой включён режим "Темы" (Group settings → Topics → On)
//   3. Бот добавлен в каждую как администратор с правом "Управление темами"
//   4. В .env прописаны нужные TELEGRAM_GROUP_APARTMENT,
//      TELEGRAM_GROUP_APARTMENT_RENT, TELEGRAM_GROUP_COMMERCIAL,
//      TELEGRAM_GROUP_COMMERCIAL_RENT, TELEGRAM_GROUP_HOUSE (chat_id
//      каждой группы — узнать тем же способом, что и раньше, через
//      getUpdates)
//
// Запуск: node src/setup-topics.js

import 'dotenv/config';
import axios from 'axios';
import { DISTRICTS } from './districts.js';
import { saveTopicId, getTopicId } from './db.js';

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();

const GROUPS = {
  apartment: (process.env.TELEGRAM_GROUP_APARTMENT || '').trim(),
  apartment_rent: (process.env.TELEGRAM_GROUP_APARTMENT_RENT || '').trim(),
  commercial: (process.env.TELEGRAM_GROUP_COMMERCIAL || '').trim(),
  commercial_rent: (process.env.TELEGRAM_GROUP_COMMERCIAL_RENT || '').trim(),
  house: (process.env.TELEGRAM_GROUP_HOUSE || '').trim(),
};

const GROUP_LABELS = {
  apartment: 'Квартиры (продажа)',
  apartment_rent: 'Квартиры (аренда)',
  commercial: 'Коммерция (продажа)',
  commercial_rent: 'Коммерция (аренда)',
  house: 'Дома',
};

async function createTopic(chatId, name) {
  const { data } = await axios.post(`https://api.telegram.org/bot${TOKEN}/createForumTopic`, {
    chat_id: chatId,
    name,
  });
  return data.result.message_thread_id;
}

async function main() {
  if (!TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN не задан в .env');
    process.exit(1);
  }

  for (const [groupKey, chatId] of Object.entries(GROUPS)) {
    if (!chatId) {
      console.warn(`⚠️  ${GROUP_LABELS[groupKey]}: chat_id не задан (переменная TELEGRAM_GROUP_${groupKey.toUpperCase()}) — пропускаю`);
      continue;
    }

    console.log(`\n📁 ${GROUP_LABELS[groupKey]} (${chatId})`);

    for (const { canonical } of DISTRICTS) {
      const existing = await getTopicId(groupKey, canonical);
      if (existing) {
        console.log(`  ✓ "${canonical}" уже есть (тема #${existing})`);
        continue;
      }
      try {
        const threadId = await createTopic(chatId, canonical);
        await saveTopicId(groupKey, canonical, threadId);
        console.log(`  + "${canonical}" создана (тема #${threadId})`);
      } catch (err) {
        console.error(`  ✗ "${canonical}" не удалось создать:`, err.response?.data || err.message);
      }
      // небольшая пауза, чтобы не упереться в лимиты Telegram API
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  console.log('\nГотово.');
}

main();
// Разовый скрипт: регистрирует список команд бота в Telegram, чтобы при вводе
// «/» (и по кнопке «Меню» рядом с полем ввода) показывался готовый список с
// описаниями — люди перестают гадать, что бот умеет.
//
// Запуск: node src/scripts/set-bot-commands.js
// Перезапускать, если список команд поменялся.
// Нужен TELEGRAM_BOT_TOKEN в .env (тот же, что у бота).

import 'dotenv/config';
import axios from 'axios';

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
if (!TOKEN) {
  console.error('TELEGRAM_BOT_TOKEN не задан в .env');
  process.exit(1);
}

const COMMANDS = [
  { command: 'menu', description: 'Меню кнопками' },
  { command: 'find', description: 'Подбор по шагам: сделка, район, комнаты, цена' },
  { command: 'search', description: 'Поиск словами: /search 2-комн Чиланзар до 600$' },
  { command: 'today', description: 'Новые объявления за сутки' },
  { command: 'help', description: 'Что умеет бот' },
];

async function call(method, payload) {
  const { data } = await axios.post(`https://api.telegram.org/bot${TOKEN}/${method}`, payload);
  if (!data.ok) throw new Error(`${method}: ${data.description}`);
  return data.result;
}

// Для личных чатов и для групп — отдельные «области» (scope), иначе в группах
// Telegram может показывать только команды по умолчанию.
for (const scope of [{ type: 'default' }, { type: 'all_group_chats' }, { type: 'all_private_chats' }]) {
  await call('setMyCommands', { commands: COMMANDS, scope });
  console.log(`✓ команды заданы для scope=${scope.type}`);
}
// Кнопка «Меню» у поля ввода показывает список команд.
await call('setChatMenuButton', { menu_button: { type: 'commands' } });
console.log('✓ кнопка меню → список команд');

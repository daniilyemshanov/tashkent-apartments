# Что изменено: ИИ только для поиска + удалена оценка выгодности

## 1. ИИ (Claude Haiku 5.5, запасной — Mistral)
- ИИ работает ТОЛЬКО в поиске: ИИ-поиск на сайте, команда `/search`, другие команды бота (`client/api/_aiSearch.js` → `client/api/_aiProviders.js`).
- Скрапер работает БЕЗ ИИ (разбор площади/комнат — бесплатный regex). Вернуть ИИ-разбор: `USE_AI_EXTRACTION=true` + `ANTHROPIC_API_KEY` скраперу.
- Gemini / Groq / OpenRouter / SambaNova / Cloudflare из кода убраны.
- `scraper/src/aiProviders.js` и `client/api/_aiProviders.js` — идентичные копии (`diff` между ними должен быть пустым).

## 2. Удалена оценка выгодности объявлений
Удалено:
- Deal Score, «ниже рынка», сигнал срочности, расчёт медиан цены за м² (`market_stats`) и его пересчёт на каждом прогоне;
- дублирование в группу Telegram «Выгодные» (`notifyDeal`, `TELEGRAM_GROUP_DEALS`);
- на сайте: кнопка/режим «Выгодные», плитка «Ниже рынка», сортировка «Сильнее всего ниже рынка», бейджи Deal Score / «ниже рынка» / срочность;
- в сообщениях бота: блоки Deal Score, «ниже рыночной цены», «Срочность»;
- файлы: `scraper/src/marketStats.js`, `scraper/src/urgencySignals.js`, устаревшая копия `scraper/run.js`;
- `scraper/src/dealScoring.js` переименован в `listingScoring.js` и оставлено только нужное: `makeEntityKey`, `summarizePriceHistory`, `computeOwnerScore`, `isSignificantPriceChange`, `isDuplicatePriceChange`.

НЕ тронуто (на этом держатся дубли и уведомления): история цен, повторное уведомление при изменении цены,
`owner_score`, метка «новостройка/вторичка» (`market_segment`), фильтры «продажа/аренда» на сайте.

Важная правка: условие «объявление уже обработано» (`run.js`) раньше требовало `deal_score != null`.
Без правки каждое объявление обрабатывалось бы заново при каждом прогоне. Теперь условие: `owner_score` и `price_history_count`.

База данных: миграции НЕ нужны. Колонки (`deal_score`, `below_market*` и т.д.) и таблица `market_stats` остаются в БД,
просто код их больше не пишет и не читает. У старых объявлений значения останутся, но нигде не показываются.

Можно удалить: GitHub Secret `TELEGRAM_GROUP_DEALS`, переменные `DEAL_SCORE_*`, группу «Выгодные» в Telegram.
(`DEAL_SCORE_SIGNIFICANT_PRICE_CHANGE_PCT` оставлена как есть — это порог «цена изменилась заметно», по умолчанию 7%.)

## 3. Внедрение
1. `cd scraper && npm install && node src/scripts/test-ai-providers.js` → «Все 9 тестов прошли».
2. Anthropic Console: пополнить баланс, создать ключ.
3. **Vercel → Environment Variables** (обязательно): `ANTHROPIC_API_KEY`, `AI_FALLBACK_ENABLED=true`, `MISTRAL_API_KEY`;
   удалить старые `GEMINI_*`, `GROQ_*`, `OPENROUTER_*`, `SAMBANOVA_*`, `CLOUDFLARE_*`. Redeploy.
4. Живая проверка: `cd scraper && node check-ai-providers.mjs --env=<файл со значениями из Vercel>` → `anthropic: OK`.
5. Бот: `/search 2 комнатная юнусабад до 60000` → в логах Vercel `provider anthropic ok`.

## 4. Как это проверено (без реального ключа Anthropic)
- 9 офлайн-тестов ИИ-модуля (повторы, отказ по ключу/деньгам, thinking-блок, переход на запасного).
- Цикл обработки объявлений на заглушках: сохраняет без полей выгодности; повторный прогон пропускает обработанные;
  падение цены даёт повторное уведомление.
- `eslint no-undef` по всем изменённым файлам; `vite build` сайта; загрузка `run.js` без ошибок импорта.
- НЕ проверено: реальный вызов Claude (нужен ключ) и реальный OLX/Telegram — это шаг 4–5 выше.

## Откат
Файлы изменены в рабочей папке и не закоммичены: `git diff` покажет правки, `git checkout -- <файл>` откатит.

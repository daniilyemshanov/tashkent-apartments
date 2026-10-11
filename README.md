<div align="center">

# Tashkent Apartments

### Real Estate Search & Deal Discovery Platform

Finds new real estate listings from property owners in Tashkent, filters out agencies, analyzes market prices and delivers relevant listings to Telegram.

**React · JavaScript · Supabase · Telegram Bot · Web Scraping · AI**

</div>

---

## Overview

**Tashkent Apartments** is a real estate aggregation and analysis platform focused on finding property listings from owners in Tashkent.

The system collects listings for **rent and sale** from:

- OLX.uz
- Uybor.uz
- Realting.uz
- Domtut.uz
- Joymee.uz

It filters out real estate agencies, stores listings in Supabase, displays them through a React web application and sends notifications to Telegram.

The platform also calculates market statistics and highlights listings that are significantly below the average market price.

---

## Features

### Real Estate Scraper

- 5 supported sources
- Apartments, houses and commercial properties
- Sale and rental listings
- Scheduled scraping
- Duplicate protection
- Price history tracking
- Telegram notifications
- Source-specific error handling
- Circuit breakers for blocked or failing endpoints

### Owner vs Agency Detection

Agency detection works without AI and uses deterministic rules:

- Multiple property listings from the same seller
- Reused phone numbers across different listings
- Seller accounts identified as organizations or realtors
- Source-specific owner indicators

Listings that cannot be confidently classified are marked as:

> Probably an owner

They are not hidden in order to avoid losing legitimate owner listings.

---

## AI Features

AI is used only where it provides a practical advantage.

### AI Listing Extraction

AI can extract structured information from listing descriptions when regular parsing cannot reliably identify it.

Examples:

- Property area
- Land area
- Renovation
- New building / secondary market
- Legal information
- Other listing characteristics

Fallback chain:

```text
Gemini
   ↓
Groq
   ↓
OpenRouter
   ↓
Mistral
   ↓
SambaNova
   ↓
Cloudflare Workers AI
```

AI extraction is optional.

If AI is unavailable, the system automatically falls back to the regular parser.

### AI Search

The website and Telegram bot support natural-language property search.

Example:

```text
2-room apartment in Chilanzar under $500
```

The system converts the request into searchable listing parameters.

---

## Market Analysis

The platform calculates the median price per square meter for groups based on:

```text
Property type
+
Deal type
+
District
```

Listings priced significantly below the market are automatically detected.

Current threshold:

```text
≥ 15% below median market price
```

Such listings receive a **Below Market** indicator and can additionally be sent to a dedicated Telegram group.

The system also tracks:

- Price history
- Owner score

---

## Telegram Bot

The project includes an interactive Telegram bot.

### Guided Search

Commands:

```text
/start
/find
```

The bot guides the user through:

```text
Deal type
    ↓
Property type
    ↓
District
    ↓
Rooms
    ↓
Price
    ↓
Results
```

Results support pagination with an **"More"** button.

### AI Search

The `/search` command allows users to search using natural language.

Example:

```text
Find a 3-room apartment in Yunusabad under $700
```

---

## Telegram Notifications

Listings can be distributed across different Telegram groups and topics:

```text
Apartments
Apartments for Rent
Commercial
Commercial for Rent
Houses
```

The system can also send administrative alerts to a separate private chat.

Topic structure can be automatically created using:

```text
scraper/src/setup-topics.js
```

---

## Web Application

The frontend is built with React and Supabase.

### Main functionality

- Real estate feed
- Search and filters
- Natural-language AI search
- Authentication
- Team management
- User roles
- Contact status
- Listing management

Authentication uses passwordless email login.

Only users registered in the `team_members` table can access the application.

---

## Architecture

```text
                    cron-job.org
                         │
                         ▼
                GitHub Actions
                         │
                         ▼
                    scraper/
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
       OLX.uz         Uybor.uz      Realting.uz
       Domtut.uz      Joymee.uz
          │
          ▼
       Supabase
          │
     ┌────┴─────┐
     ▼          ▼
  React App   Telegram
     │          │
     ▼          ▼
   Vercel      Bot
```

### Project structure

```text
client/
├── React application
└── api/
    ├── serverless functions
    ├── AI search
    └── Telegram webhook

scraper/
├── src/
│   ├── scrapers/
│   ├── classify.js
│   ├── extractListingInfo.js
│   ├── listingScoring.js
│   ├── run.js
│   └── setup-topics.js
└── .env.example

supabase/
├── schema.sql
└── migrations

deploy/
├── tashkent-scraper.service
├── tashkent-scraper.timer
└── .env.example

.github/
└── workflows/
    └── scrape.yml
```

---

## Deployment

The project is designed to run entirely in the cloud.

Nothing needs to stay running on a local computer.

### Backend / Scraper

The scraper runs through:

```text
cron-job.org
        ↓
GitHub Actions
        ↓
Node.js scraper
```

The external cron service triggers the GitHub Actions workflow approximately every 15 minutes.

The workflow uses concurrency protection so a new run does not interrupt an already running scraper.

Maximum execution time:

```text
20 minutes
```

---

## Supabase

Supabase is used as the main PostgreSQL database.

Setup:

1. Create a Supabase project.
2. Open **SQL Editor**.
3. Run `supabase/schema.sql`.
4. Run migration files in numerical order.
5. Configure environment variables.

Required variables:

```env
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
```

### Security

`SUPABASE_SERVICE_KEY` provides full database access.

It must never be:

- committed to Git
- exposed in frontend code
- included in public files

Store it only in:

- GitHub Secrets
- Vercel Environment Variables

---

## Telegram Setup

Create a bot using:

```text
@BotFather
```

Required variables:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ADMIN_CHAT_ID=
```

For group notifications:

```env
TELEGRAM_GROUP_APARTMENT=
TELEGRAM_GROUP_APARTMENT_RENT=
TELEGRAM_GROUP_COMMERCIAL=
TELEGRAM_GROUP_COMMERCIAL_RENT=
TELEGRAM_GROUP_HOUSE=
```

The bot should be added as an administrator in groups where it needs to publish listings or manage topics.

---

## Local Development

### Scraper

```bash
cd scraper
npm install
cp .env.example .env
npm start
```

At minimum:

```env
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

### Frontend

```bash
cd client
npm install
npm run dev
```

The frontend will be available at:

```text
http://localhost:5173
```

For local API testing:

```bash
npm install -g vercel
cd client
vercel dev
```

---

## Vercel Deployment

The React application is deployed using Vercel.

Configuration:

```text
Root Directory: client
```

Required environment variables include:

```env
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
SUPABASE_URL=
SUPABASE_SERVICE_KEY=
```

After deployment, every push to GitHub automatically triggers a new Vercel deployment.

---

## Data Sources

### OLX.uz

Phone numbers can be obtained from listing text or through the dedicated phone endpoint.

Optional proxy support:

```env
OLX_PROXY_URL=
```

This can be useful if the server IP receives HTTP 403 responses.

### Uybor.uz

Uses the internal JSON API instead of HTML scraping because the website renders listings through JavaScript.

### Realting.uz

Apartment listings are supported and have been tested with real scraper runs.

### Domtut.uz

Can be enabled or disabled with:

```env
DOMTUT_ENABLED=
```

### Joymee.uz

Currently supports apartment sales.

Other property/deal combinations are still being tested.

---

## VPS Deployment

An alternative to GitHub Actions is provided in:

```text
deploy/
```

Included files:

```text
tashkent-scraper.service
tashkent-scraper.timer
.env.example
```

The system uses `systemd` and can run the scraper every 15 minutes.

Example:

```bash
systemctl enable --now tashkent-scraper.timer
```

Logs:

```bash
journalctl -u tashkent-scraper -f
```

---

## Authentication

The application uses passwordless email authentication.

Only users listed in:

```text
team_members
```

can access the platform.

Users with appropriate permissions can invite additional team members directly from the application.

---

## Contact Status

Each listing has a contact status.

The status is stored in Supabase, which means it is shared between all authorized users of the platform.

---

## Project Status

The project is actively developed.

Current focus:

- Improving scraper reliability
- Improving owner detection
- Expanding property sources
- Improving AI search
- Improving market analysis
- Telegram automation

---

<details>
<summary>🇷🇺 Русская версия</summary>

# Квартиры Ташкент — поиск объявлений от собственников

Платформа для поиска недвижимости в Ташкенте.

Собирает новые объявления об аренде и продаже квартир, домов и коммерческой недвижимости с:

- OLX.uz
- Uybor.uz
- Realting.uz
- Domtut.uz
- Joymee.uz

Система отсеивает агентства, сохраняет объявления в Supabase, показывает их на React-сайте и отправляет подходящие объявления в Telegram.

Дополнительно рассчитывается рыночная статистика и находятся объявления со значительно более низкой ценой.

## Что реализовано

- Скрапинг нескольких источников
- Фильтрация агентств
- Определение вероятного собственника
- AI-извлечение данных
- AI-поиск
- История изменения цены
- Owner score
- Telegram-бот
- Telegram-уведомления
- Авторизация
- Управление командой
- Статус «связались»

## Архитектура

```text
cron-job.org
      ↓
GitHub Actions
      ↓
scraper
      ↓
Supabase
   ↙       ↘
React     Telegram
  ↓
Vercel
```

## Локальный запуск

```bash
cd scraper
npm install
cp .env.example .env
npm start
```

Frontend:

```bash
cd client
npm install
npm run dev
```

## Стек

- React
- JavaScript
- Node.js
- Supabase
- PostgreSQL
- GitHub Actions
- Telegram Bot API
- Vercel
- AI APIs

## Статус

Проект находится в активной разработке.

</details>

---

## Author

**Daniil Yemshanov**

Frontend Developer · React · JavaScript

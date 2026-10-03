# Clearday: voice-first AI chief of staff for email (Gemini edition)

**What changed in this version**
- **Gemini** does all the AI: `gemini-3.5-flash-lite` classifies mail, `gemini-3.8-flash` handles chat and replies.
- **Gemini Live voice assistant** (`gemini-3.8-live`): click the mic in the Assistant tab and just talk. You can interrupt it, and it can read your briefing, open emails, save reply **drafts** and remember things. The browser connects to Gemini directly with a short-lived token, so your API key never leaves the server.
- **Only the latest 50 inbox emails per account** are ever read.
- **Local memory**: `data/memory.json` on your machine (Settings → Memory to view/delete). Say "remember that Anna is my thesis supervisor".
- Clearday still **never sends email**; there is no send tool or code path.

**v2 (categories + voice board)**
- At signup you describe who you are; Gemini proposes up to **6 categories** you can edit (Settings → Your categories later). Mail that fits none goes to "Everything else".
- The **Board** is the home page: one folder per category across all connected inboxes, with "waiting on you" and due-date badges. Click a mail to open it in Gmail/Outlook; mails that need a reply show **Draft reply** (saved to your Drafts, never sent).
- The **voice orb** is on the Board: tap it for a spoken, category-by-category briefing, then talk (Gemini Live).

## Quick start (English)
1. Install Node 20+ and run `npm install`.
2. `cp .env.example .env`, then set `SESSION_SECRET` (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) and `GEMINI_API_KEY` (from https://aistudio.google.com/apikey). Never commit `.env`.
3. Offline test without Gmail: set `DEV_MOCK=1`, run `npm start`, open http://localhost:3000 (use Chrome; the mic needs localhost or https), choose the Mock inbox.
4. Real Gmail: follow section 3 below (Google Cloud OAuth client, redirect `http://localhost:3000/auth/google/callback`, add your Gmail as a Test user), set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, restart, click Connect Gmail.

---

# Clearday — AI chief of staff for your email

Clearday подключается к настоящим ящикам Gmail и Outlook, читает новые письма через официальные API, анализирует их через Gemini и показывает:

- брифинг дня;
- доску с папками;
- задачи и дедлайны;
- саммари рассылок;
- черновики ответов;
- чат с почтой (текстом и голосом).

**Clearday никогда не отправляет письма.** Черновики сохраняются в твою папку «Черновики» в Gmail или Outlook, а отправляешь ты сама.

Режим **Try demo** продолжает работать без ключей. Это удобно для питча, если на сцене пропадёт интернет.

---

## 1. Быстрый старт (локально, ~15 минут)

Нужен Node.js 18.17 или новее.

```bash
npm install
cp .env.example .env
```

Сгенерируй секрет и вставь его в `SESSION_SECRET` в файле `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Запусти сервер:

```bash
npm start
```

Открой **http://localhost:3000**. В консоли сервер покажет, что уже настроено: Gmail, Outlook, AI.

> Хочешь сначала проверить всё без Google и Microsoft? Поставь `DEV_MOCK=1` в `.env`. На экране подключения появится кнопка **Mock** с фейковым ящиком.

---

## 2. Ключ Gemini (AI-анализ)

1. Зайди на https://aistudio.google.com/apikey и создай ключ.
2. Вставь ключ в `.env`: `GEMINI_API_KEY=...`

Без ключа приложение работает, но сортирует письма по простым правилам.

Модели задаются в `.env`:
- `AI_MODEL` — быстрая модель, ей классифицируется каждое письмо.
- `AI_SMART_MODEL` — модель для чата и переписывания черновиков.

---

## 3. Подключение Gmail (Google Cloud)

1. Открой https://console.cloud.google.com и создай новый проект (например, `clearday`).
2. **APIs & Services → Library** → найди **Gmail API** → **Enable**.
3. **Google Auth Platform** (или **OAuth consent screen**):
   - **Branding**: название `Clearday`, твой email.
   - **Audience**: тип **External**. В разделе **Test users** добавь все Gmail-адреса, которые будешь подключать.
   - **Data access → Add scopes**: `.../auth/gmail.readonly` и `.../auth/gmail.compose`.
4. **Clients → Create client → Web application**.
   - **Authorized redirect URIs**: `http://localhost:3000/auth/google/callback`. Позже добавь адрес продакшена, например `https://твой-домен/auth/google/callback`.
5. Скопируй **Client ID** и **Client secret** в `.env` (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`).

**Что важно знать:**
- Пока приложение в режиме **Testing**, при входе Google покажет «Google hasn't verified this app». Нажми **Advanced → Go to Clearday**. Для хакатона это нормально.
- В режиме Testing Google сбрасывает доступ примерно через 7 дней. Тогда в приложении появится кнопка **Reconnect**.
- Университетские ящики на Google Workspace иногда закрыты администратором для сторонних приложений. Это настройка университета, а не ошибка Clearday.
- Gmail-права «restricted». Для публичного запуска понадобится верификация у Google. Для демо и тест-пользователей она не нужна.

---

## 4. Подключение Outlook (Microsoft Entra / Azure)

1. Открой https://entra.microsoft.com (или portal.azure.com) → **App registrations → New registration**.
   - **Supported account types**: *Accounts in any organizational directory and personal Microsoft accounts*. Тогда работают и outlook.com/hotmail, и рабочие ящики.
   - **Redirect URI**: платформа **Web**, адрес `http://localhost:3000/auth/microsoft/callback`.
2. На странице приложения скопируй **Application (client) ID** → `MICROSOFT_CLIENT_ID`.
3. **Certificates & secrets → New client secret** → скопируй **Value** (не Secret ID) → `MICROSOFT_CLIENT_SECRET`.
4. **API permissions → Add → Microsoft Graph → Delegated**: `Mail.ReadWrite`, `User.Read`, `offline_access`, `openid`, `email`.

**Что важно знать:**
- Рабочий или учебный Microsoft-аккаунт может требовать согласия администратора. С личными outlook.com/hotmail всё работает сразу.
- `Mail.ReadWrite` нужен только для того, чтобы создавать черновики ответов. Кода отправки писем в проекте нет.

---

## 5. Деплой (чтобы показать по ссылке)

Подойдёт любой хостинг с постоянно работающим Node-сервером: **Render**, **Railway**, **Fly.io** или VPS.

Пример для Render:
1. Залей проект на GitHub.
2. Render → **New Web Service** → выбери репозиторий.
   - Build command: `npm install`
   - Start command: `npm start`
3. **Environment**: добавь все переменные из `.env`, а `APP_URL` поставь `https://<твой-сервис>.onrender.com`.
4. Добавь **Disk** с mount path `/data` и задай `DATA_DIR=/data`. Иначе токены будут теряться при перезапуске.
5. В Google и Microsoft добавь продакшен redirect URI: `https://<домен>/auth/google/callback` и `https://<домен>/auth/microsoft/callback`.

> Netlify сам по себе не подходит: там нет постоянного сервера и диска для токенов.

---

## Архитектура

```
public/index.html        фронтенд (брифинг, доска, чат, голос, demo-режим)
server/index.js          Express: OAuth, сессии, /api/sync, /api/draft, /api/chat, /api/rewrite
server/providers/google.js     Gmail API: чтение, определение «отвечено», черновики
server/providers/microsoft.js  Microsoft Graph: то же для Outlook
server/ai.js             Gemini: классификация, приоритеты, действия, саммари, черновики, чат
server/store.js          JSON-хранилище; OAuth-токены зашифрованы AES-256-GCM
```

**Как идёт синхронизация:**
1. Сервер забирает письма (только последние 50 из входящих на каждый ящик).
2. Нормализует Gmail и Outlook в одну модель.
3. Определяет, ответила ли ты: в Gmail проверяет отправленные письма в треде, в Outlook — Sent Items в той же беседе.
4. Отправляет в Gemini только новые письма, по 8 за запрос. Промо и соцсети, которые Gmail уже отфильтровал, разбираются без AI.
5. Кэширует результаты анализа. Тела писем на сервере не хранятся.

**Приватность:**
- Пароли не видим: вход только через OAuth.
- Права минимальные.
- Ящик можно отключить в любой момент; для Google доступ при этом отзывается автоматически.
- В настройках есть кнопка «Delete my data».
- Это хакатон-прототип без аудита безопасности.

## Частые ошибки

| Ошибка | Что делать |
|---|---|
| `redirect_uri_mismatch` | Redirect URI в Google или Azure должен **точно** совпадать с `APP_URL` + `/auth/.../callback` (http/https, порт, без слэша в конце). |
| `access_denied` / «app not verified» | Добавь свой адрес в **Test users** (Google). |
| «Gmail permission was not granted» | На экране согласия отметь галочки Gmail. |
| `AADSTS65001` / need admin approval | Рабочий аккаунт закрыт админом. Попробуй личный outlook.com. |
| `invalid_client` (Microsoft) | В `.env` вставлен Secret ID вместо **Value** секрета. |

# Clearday — AI chief of staff for your email

Clearday подключается к настоящим ящикам Gmail и Outlook, читает новые письма через официальные API, анализирует их через Claude и показывает:

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

## 2. Ключ AI: Gemini (рекомендуется) или Claude

Нужен **один** ключ.

**Gemini** — включает всё, в том числе **живого голосового ассистента** (Gemini Live: говоришь с почтой голосом, он отвечает голосом, читает письма, пишет черновики в Drafts и запоминает факты о тебе).
1. Зайди на https://aistudio.google.com/apikey → **Create API key**.
2. Вставь в `.env`: `GEMINI_API_KEY=...`

**Claude** — если `GEMINI_API_KEY` пустой, используется `ANTHROPIC_API_KEY` (https://console.anthropic.com). Всё работает, кроме живого голоса: голос тогда идёт через распознавание речи браузера.

Модели можно переопределить через `AI_MODEL` / `AI_SMART_MODEL`, голос — `GEMINI_LIVE_MODEL` и `GEMINI_VOICE`.

**Память ассистента** хранится только на этом сервере в `data/memory.json`. Её видно и можно очистить в Settings → Memory.

Clearday читает последние 50 писем в каждом ящике (`MAX_PER_ACCOUNT`).

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

## 4б. Yahoo и Mail.ru (работают сразу, без регистрации приложения)

На экране подключения нажми **Yahoo** или **Mail.ru**, введи адрес и **пароль приложения** (не обычный пароль):
- **Yahoo:** Yahoo account → Account security → Generate app password (инструкция: https://help.yahoo.com/kb/SLN15241.html).
- **Mail.ru:** Настройки → Безопасность → Пароли для внешних приложений → Добавить.

Clearday подключается по IMAP (imap.mail.yahoo.com / imap.mail.ru, порт 993), читает последние 50 писем и сохраняет черновики в папку «Черновики». Пароль приложения хранится на сервере в зашифрованном виде; удалить доступ можно в любой момент, отозвав пароль приложения у почтового сервиса.

> Файл настроек должен называться `.env`. Если он остался `clearday.env` или `.env.txt`, сервер теперь тоже его найдёт и напишет об этом в консоли.

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
server/ai.js             Gemini или Claude: классификация, приоритеты, действия, саммари, черновики, чат
server/live.js           Gemini Live: инструменты голосового ассистента (брифинг, письма, черновики, память)
server/memory.js         локальная память ассистента (data/memory.json)
server/store.js          JSON-хранилище; OAuth-токены зашифрованы AES-256-GCM
```

**Как идёт синхронизация:**
1. Сервер забирает письма за последние `SYNC_HOURS` (до `MAX_PER_ACCOUNT` на ящик).
2. Нормализует Gmail и Outlook в одну модель.
3. Определяет, ответила ли ты: в Gmail проверяет отправленные письма в треде, в Outlook — Sent Items в той же беседе.
4. Отправляет в Claude только новые письма, по 8 за запрос. Промо и соцсети, которые Gmail уже отфильтровал, разбираются без AI.
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

## v3: returning users, many users, newsletters, spam memory, calendar

- **Your mailbox is your login.** Connect (or "Continue with Google/Microsoft") and you get your folders, memory and last mails back, even after clearing cookies or on another device. Mail text from your last sync (trimmed to ~2000 characters per mail) is kept **encrypted** on the server so the app opens instantly; "Delete my data" in Settings wipes it.
- **Per-user data.** Memory, folders, spam digest and snapshot all live in each user's own record (`DATA_DIR/db.json`). Back up that folder; on a host use a persistent disk.
- **Category pages** have two tabs: *Needs attention* (waiting on your reply, has an action/deadline, or rated critical/important) and *All*.
- **Newsletters** collect in their own folder, grouped by sender, with Read and Unsubscribe.
- **Spam memory.** Clearday reads your 30 latest spam mails (summaries only, no links, kept 30 days; switch off in Settings). It flags real-looking mail that got filtered and can answer "did X end up in spam?". Spam text is treated as untrusted.
- **Calendar, always asked first.** Meetings found in mail show a card; nothing is added until you press **Add** (or say "yes" to the voice assistant). Gmail and Outlook use their calendar APIs; other providers (Yahoo, iCloud, ...) give you a `.ics` file.
  - Google: add the scope `https://www.googleapis.com/auth/calendar.events` under *Data access* on the OAuth consent screen, and enable the **Google Calendar API** in the project.
  - Microsoft: add the delegated permission `Calendars.ReadWrite`.
  - People who connected earlier see "Allow calendar access" once and reconnect.
- **More IMAP providers** (app password): Yahoo, iCloud, GMX, AOL, Zoho, Mail.ru.

### Opening it to other people (hosting checklist)
1. Deploy somewhere with a persistent disk and HTTPS (Render, Railway, Fly.io or a VPS). Set `APP_URL=https://your-domain`, a long `SESSION_SECRET`, `DATA_DIR` on the disk, and your Gemini key.
2. Add `https://your-domain/auth/google/callback` and `https://your-domain/auth/microsoft/callback` as redirect URIs.
3. **Google:** OAuth consent screen → set Publishing status to **In production** so anyone can sign in (no test-user list). Gmail read/compose are *restricted* scopes: until Google verifies the app people see an "unverified app" warning and you are limited to 100 users. Verification needs a privacy policy URL, a homepage and a demo video.
4. **Microsoft:** supported account types must include personal and organisational accounts (`MICROSOFT_TENANT=common`). Some company tenants need an admin to approve the app.
5. Protect your bill: `AI_DAILY_CAP` limits analysed emails per user per day; `MAX_USERS` caps sign-ups.
6. The JSON file store suits a demo-sized host. For real scale move `server/store.js` to Postgres or SQLite.

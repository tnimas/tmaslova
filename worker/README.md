# Quick Form Worker

Cloudflare Worker принимает заявку из `landing.html` и пересылает ее в Telegram-бота.

## 1) Логин в Cloudflare

```bash
npm install
```

```bash
npx wrangler login
```

## 2) Настройка секретов

Выполнять из папки `worker/`:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_IDS
```

- `TELEGRAM_CHAT_IDS` можно указать один id или несколько через запятую.
- Для теста укажите только ваш id, например: `YOUR_TEST_CHAT_ID`.
- Для боевого режима можно указать несколько id, например: `123456789,987654321`.

Как получить chat id:

1. Напишите вашему боту в Telegram (`/start`).
2. Откройте `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`.
3. Возьмите `chat.id` из ответа.

## 3) Деплой

Если это первый Worker в аккаунте, сначала зарегистрируйте `workers.dev` subdomain:

Cloudflare Dashboard -> Workers & Pages -> Create / Onboarding

```bash
npx wrangler deploy
```

После деплоя получите URL вида:

`https://<your-worker-name>.<your-subdomain>.workers.dev`

Endpoint формы:

`https://<your-worker-name>.<your-subdomain>.workers.dev/lead`

## 4) Подключение на лендинге

В `landing.html` у тега `<body>` есть атрибут:

```html
<body data-lead-endpoint="">
```

Вставьте туда URL endpoint, например:

```html
<body data-lead-endpoint="https://<your-worker-name>.<your-subdomain>.workers.dev/lead">
```

## 5) Проверка логов

```bash
npx wrangler tail
```

# Operations

## Что Делается Автоматически

Через GitHub Actions workflow `deploy`:

1. `npm install`
2. `npm run check`
3. `npm run d1:migrate:remote`
4. `npm run deploy`
5. `npm run telegram:webhook:set`
6. `npm run postdeploy:smoke`

Это работает только если в GitHub заданы нужные secrets и vars.

## Что Требует Secrets

Cloudflare:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Telegram и health:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `HEALTH_TOKEN`

Локально для ручной настройки webhook и smoke:

- `POST_DEPLOY_BASE_URL`

## Что Делается Вручную

Если deploy workflow не используется, оператор выполняет:

1. `npm install`
2. `npm run check`
3. `npm run d1:migrate:remote`
4. `npm run deploy`
5. `npm run telegram:webhook:set`
6. `npm run postdeploy:smoke`

## Первый Запуск

1. `wrangler login`
2. `npm install`
3. `npm run d1:create`
4. обновить `database_id` в `wrangler.jsonc`
5. задать Cloudflare secrets:
   - `wrangler secret put TELEGRAM_BOT_TOKEN`
   - `wrangler secret put TELEGRAM_WEBHOOK_SECRET`
   - `wrangler secret put HEALTH_TOKEN`
6. `npm run d1:migrate:remote`
7. `npm run deploy`
8. `npm run telegram:webhook:set`
9. `npm run postdeploy:smoke`

## Webhook

Worker route:

- `POST /webhook/telegram/:secret`

Автоматическая установка webhook делается скриптом:

- `npm run telegram:webhook:set`

Скрипт требует:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `POST_DEPLOY_BASE_URL`

Он:

- вызывает `setWebhook`;
- затем проверяет `getWebhookInfo`;
- падает, если Telegram вернул другой URL.

## Health И Diagnostics

`GET /health`

- публичный endpoint;
- проверяет, что Worker жив и D1 отвечает.

`GET /diagnostics`

- требует `Authorization: Bearer <HEALTH_TOKEN>`;
- возвращает счётчики и последние `cron_runs`.

## Cron

Текущие cron schedules в `wrangler.jsonc`:

- `*/10 * * * *`
- `0 4 * * *`

Они запускают housekeeping, а не продуктовые напоминания.

## Миграции

Локально:

- `npm run d1:migrate:local`

Remote:

- `npm run d1:migrate:remote`

Перед production deploy миграции должны быть применены отдельно и успешно.

## Post-Deploy Checks

Автоматический smoke:

- `npm run postdeploy:smoke`

Проверяет:

- `GET /health`
- `GET /diagnostics`
- доступность webhook path

### Ограничение

Автоматический smoke не подтверждает, что Telegram прислал живой update и пользовательский сценарий дошёл до конца внутри чата. Это остаётся ручной проверкой.

## Backup И Restore

### Для Этого Бота

- экспорт: JSON-файл полной копии;
- импорт: preview и подтверждение полной замены текущих данных.

### В Другие Приложения

- экспорт: CSV;
- импорт: CSV или JSON с preview;
- колонки CSV:
  - `date`
  - `time`
  - `amount`
  - `type`
  - `category`
  - `subcategory`
  - `description`

## Аварийные Сценарии

### Проблема С Deploy

1. проверить `health`
2. проверить `diagnostics`
3. перепроверить миграции
4. при необходимости задеплоить предыдущий commit

### Проблема С Webhook

1. заново выполнить `npm run telegram:webhook:set`
2. проверить `getWebhookInfo`
3. проверить `POST_DEPLOY_BASE_URL`
4. проверить, что `TELEGRAM_WEBHOOK_SECRET` совпадает с route

### Проблема С Cron

1. проверить `wrangler.jsonc`
2. проверить последние `cron_runs` через `/diagnostics`
3. проверить, что scheduled handler не падает в логах Worker

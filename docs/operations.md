# Operations

## Секреты

Секреты задаются только через Cloudflare:

- `wrangler secret put TELEGRAM_BOT_TOKEN`
- `wrangler secret put TELEGRAM_WEBHOOK_SECRET`
- `wrangler secret put HEALTH_TOKEN`
- `wrangler secret put BACKUP_SIGNING_KEY`

Они не должны попадать в git, код или README как реальные значения.

## Первый запуск

1. `npm install`
2. `wrangler login`
3. `wrangler d1 create finance-bot-db`
4. Вставить выданный `database_id` в [wrangler.jsonc](/home/abihsgelo/Документы/dorashod/wrangler.jsonc)
5. Задать secrets
6. `npm run d1:migrate:remote`
7. `npm run deploy`
8. Установить webhook:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<worker-domain>/webhook/telegram/<webhook-secret>"
  }'
```

Фактическое прод-состояние:

- GitHub repo: `https://github.com/lavshiba/dorashod`
- Worker URL: `https://finance-bot.shiaboi.workers.dev`
- Health: `https://finance-bot.shiaboi.workers.dev/health`
- D1 database id: `0ce605f9-e138-4f30-8c1a-cf8073cc2bbe`
- Telegram bot username: `@dorashodbot`
- Webhook установлен на production URL

## Миграции

- Все миграции лежат в `migrations/`.
- После каждой миграции нужно прогонять schema checks.
- Повторный деплой не должен ломать базу.

Команды:

- `npm run d1:migrate:local`
- `npm run d1:migrate:remote`

## Cron

Используются только реальные полезные задачи:

- `*/10 * * * *`: лёгкая обработка очередей и напоминаний
- `0 4 * * *`: ежедневная диагностика и housekeeping

Обе cron schedule зарегистрированы в production.

## Health / diagnostics / observability

### `GET /health`

Отвечает кратким JSON:

- статус worker
- статус базы
- версия приложения
- текущее время

### `GET /diagnostics`

Требует `Authorization: Bearer <HEALTH_TOKEN>`. Возвращает:

- worker status
- D1 check
- cron registration summary
- базовую статистику по пользователям, записям и очередям

### Логи

- ошибки логируются через `console.error`
- cron runs пишутся в таблицу `cron_runs`
- критические исключения не должны падать молча

## Backup / restore

### Полная копия

Включает:

- записи
- категории
- подкатегории
- настройки
- черновик
- новые записи

Поток:

1. `сохранить в файл`
2. получить JSON-файл
3. хранить файл вне Telegram дополнительно
4. для восстановления использовать `загрузить из файла`
5. посмотреть предварительный просмотр
6. подтвердить замену текущих данных

### Записи для других приложений

Включают только записи:

- дата
- время
- сумма
- тип
- категория
- подкатегория
- описание

После `загрузить из файла` доступны:

- `[объединить]`
- `[добавить всё]`

## Минимизация риска потери данных

- D1 как основной storage
- SQL-миграции под версионным контролем
- ограничения целостности и индексы
- экспорт полной копии из интерфейса
- возможности D1 restore использовать при реальном проде
- аккуратный rollout с post-deploy checks

Абсолютную гарантию `никогда не потерять ничего` дать нельзя. Это ограничение нужно честно учитывать.

## Аварийные сценарии

### Проблемный деплой

1. Проверить `health`
2. Проверить `diagnostics`
3. При необходимости откатить код на предыдущий git commit
4. Задеплоить предыдущую версию Worker
5. Если проблема в миграции, остановить rollout и восстановить данные из полной копии / инструментов D1 restore

### Проблема с webhook

1. Проверить `getWebhookInfo`
2. Проверить, что secret path совпадает
3. Проверить доступность Worker URL
4. Проверить логи Worker

### Проблема с cron

1. Проверить наличие cron в `wrangler.jsonc`
2. Проверить deployed configuration
3. Проверить записи в `cron_runs`

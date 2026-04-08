# Architecture

## Runtime

Проект разворачивается как один Cloudflare Worker.

Входы:

- `POST /webhook/telegram/:secret`
- `GET /health`
- `GET /diagnostics`
- `scheduled()`

Webhook защищён в два слоя:

- секретный path;
- заголовок `X-Telegram-Bot-Api-Secret-Token`.

## Реальный Layout Исходников

- `src/index.ts`
  Точка входа Worker. Подключает `fetch` и `scheduled`.
- `src/app/create-app.ts`
  Hono routes для health, diagnostics и Telegram webhook.
- `src/config/env.ts`
  Валидация и типизация окружения.
- `src/db/repository.ts`
  D1 access layer и SQL-операции.
- `src/domain/types.ts`
  Доменные типы.
- `src/services/bot-service.ts`
  Основная продуктовая логика Telegram-бота и cron housekeeping orchestration.
- `src/services/data-import.ts`
  Разбор full backup и импорт записей из CSV/JSON, включая preview, fix-flow и dedup helpers.
- `src/telegram/api.ts`
  Тонкий клиент к Telegram Bot API.
- `src/ui/text.ts`
  Кнопки, заголовок и onboarding-тексты, которые используются кодом.
- `src/ui/keyboard.ts`
  Сборка inline keyboard.
- `src/utils/callback.ts`
  Кодирование и декодирование callback payload.
- `src/utils/csv.ts`
  Сериализация CSV для экспорта записей.
- `src/utils/dates.ts`
  Парсинг и вычисление дат и периодов.
- `src/utils/entry-parser.ts`
  Разбор пользовательского ввода записи.
- `src/utils/money.ts`
  Форматирование и работа с суммами.
- `src/utils/normalize.ts`
  Нормализация строк и безопасный вывод.
- `src/utils/telegram-text.ts`
  Форматирование экранного текста под Telegram.
- `src/utils/timezone.ts`
  Работа с timezone через город и геопозицию.

## Данные В D1

Основные таблицы:

- `users`
- `categories`
- `subcategories`
- `entries`
- `drafts`
- `intake_queue`
- `ui_sessions`
- `saved_views`
- `imports`
- `import_rows`
- `callback_locks`
- `user_update_locks`
- `cron_runs`

## Что Хранится

### `users`

- onboarding state;
- timezone;
- currency;
- настройки подкатегорий;
- режимы быстрого доступа;
- режимы сортировки.

### `entries`

- тип записи;
- сумма в minor units;
- категория и подкатегория;
- описание;
- дата и время;
- признаки `is_time_auto` и `is_date_missing`;
- источник записи.

### `drafts` и `intake_queue`

- незавершённый пошаговый ввод;
- очередь `новые записи`.

### `ui_sessions`

- активный режим;
- стек;
- контекст текущего экрана, включая `screenMessageId`.

### `imports`

- preview данных перед импортом;
- промежуточные результаты исправления проблемных строк.

### `callback_locks` и `user_update_locks`

- дедупликация повторных callback;
- последовательная обработка update одного пользователя.

### `cron_runs`

- журнал результатов cron housekeeping.

## Bindings И Secrets

Bindings:

- `DB`

Secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `TELEGRAM_WEBHOOK_TOKEN`
- `HEALTH_TOKEN`

Vars:

- `APP_ENV`
- `BOT_NAME`

## Cron

Cron больше не является заглушкой.

Текущая полезная работа scheduled handler:

- чистит старые `callback_locks`;
- чистит старые `user_update_locks`;
- удаляет застаревшие import preview;
- удаляет старые записи `cron_runs`;
- пишет итог в `cron_runs`.

## Free-Plan Подход

- без ORM;
- SQL под прямым контролем;
- пагинация списков;
- минимизация лишних Telegram-сообщений через редактирование экрана;
- cron только для лёгкого housekeeping;
- публичный `/health` отдаёт только безопасный минимум, а подробности остаются в защищённом `/diagnostics`.

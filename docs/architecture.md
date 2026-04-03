# Architecture

## Общая схема

Проект построен как один Cloudflare Worker с несколькими HTTP-входами и scheduled handler:

- `POST /webhook/telegram/:secret` для Telegram webhook updates
- `GET /health` для health check
- `GET /diagnostics` для защищённой диагностики
- `scheduled()` для cron jobs

## Слои приложения

- `src/app`: сборка приложения и маршрутов
- `src/bot`: orchestration Telegram use cases
- `src/config`: типизация окружения и feature flags
- `src/db`: D1 access, SQL helpers, migrations checks
- `src/domain`: доменные типы и инварианты
- `src/infra`: cron, logging, diagnostics, backup hooks
- `src/services`: сценарии продукта
- `src/telegram`: Telegram API client и helpers
- `src/ui`: экраны, кнопки, frozen dictionary
- `src/utils`: парсинг, даты, нормализация, ids

## Data model

### `users`

- telegram_user_id
- chat_id
- onboarding_step
- onboarding_completed_at
- timezone_name
- timezone_source
- currency_code
- currency_label
- subcategories_enabled
- created_at
- updated_at

### `categories`

- user_id
- type: income / expense
- name
- normalized_name
- hidden_at
- sort_mode_override
- quick_access_slot
- usage_count_cache

### `subcategories`

- category_id
- name
- normalized_name
- hidden_at
- quick_access_slot
- usage_count_cache

### `entries`

- user_id
- type
- amount_minor
- currency_label
- category_id
- subcategory_id nullable
- description nullable
- entry_date nullable
- entry_time nullable
- entry_datetime_sort nullable
- is_time_auto
- is_date_missing
- source
- external_hash nullable
- created_at
- updated_at

### `drafts`

- user_id
- payload_json
- current_step
- created_at
- updated_at

### `intake_queue`

- user_id
- source
- raw_text
- parsed_json
- missing_fields_json
- status
- created_at
- updated_at

### `ui_sessions`

- user_id
- mode
- stack_json
- context_json
- updated_at

### `saved_views`

- user_id
- view_type
- params_json
- result_ids_json
- cursor
- updated_at

### `imports`

- user_id
- import_type
- status
- preview_json
- created_at
- updated_at

### `import_rows`

- import_id
- raw_json
- parsed_json
- status
- failure_reason

### `cron_runs`

- job_name
- status
- summary
- created_at

## Bindings и secrets

Bindings:

- `DB: D1Database`

Secrets:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `HEALTH_TOKEN`
- `BACKUP_SIGNING_KEY`

Vars:

- `APP_ENV`
- `BOT_NAME`

## Почему без ORM

- меньше runtime overhead
- проще контролировать SQL и индексы под free-план
- легче проверять миграции и rollback strategy
- прозрачнее поддержка через Codex

## Free-plan стратегия

- 1-2 D1 запроса на быстрые экраны там, где возможно
- пагинация по 6 элементов
- кешированные usage counters для категорий и подкатегорий
- queue-like обработка `новые записи` и импорта без тяжёлых циклов
- cron только для полезных задач: диагностика, напоминания, housekeeping

## Точки расширения

### Картинка графика для отчётов

Под это зарезервирован сервисный слой `reports renderer`. Сейчас отчёты текстовые, позже можно добавить отдельный renderer, который получает уже готовый агрегированный report snapshot.

### Backup provider

Под это зарезервирован интерфейс `backup sink`. Сейчас backup/restore работает через файлы Telegram и D1, позже можно добавить внешний provider без переписывания доменной логики.

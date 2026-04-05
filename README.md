# Финансы

Telegram-бот для учёта доходов и расходов. Runtime живёт в Cloudflare Workers, данные хранятся в Cloudflare D1, входящие update от Telegram приходят только через webhook.

Единственный source of truth по пользовательским текстам и экранной логике живёт внутри репозитория:

- [`docs/frozen/ui-texts.txt`](docs/frozen/ui-texts.txt)

Этот repo-local frozen source of truth покрывает весь ключевой интерфейс бота:

- onboarding;
- главную;
- добавление записи;
- черновик и `новые записи`;
- операции, карточку записи и редактирование;
- поиск и результаты поиска;
- отчёты;
- категории и подкатегории;
- настройки;
- данные;
- подтверждения опасных действий;
- импорт, исправление строк и итоговые экраны.

## Что умеет

- onboarding с frozen-текстами;
- главная, операции, поиск, отчёты, категории, настройки;
- добавление записей кнопками и текстом;
- черновик и очередь `новые записи`;
- полная копия `для этого бота`;
- обмен записями `в другие приложения`;
- экспорт записей в CSV;
- импорт записей из CSV и JSON;
- health, diagnostics, webhook и cron housekeeping.

## Стек

- TypeScript
- Cloudflare Workers
- Cloudflare D1
- Hono
- grammY helpers через собственный Telegram API client
- Vitest
- ESLint
- Wrangler

## Инфраструктура

- runtime: один Worker;
- база: один D1 binding `DB`;
- webhook: `POST /webhook/telegram/:secret`;
- health: `GET /health`;
- diagnostics: `GET /diagnostics` c заголовком `Authorization: Bearer YOUR_HEALTH_TOKEN`;
- cron: scheduled handler для housekeeping.

Подробности по структуре лежат в [`docs/architecture.md`](docs/architecture.md).

## Как запускать локально

1. `npm install`
2. заполнить `.dev.vars` на основе `.dev.vars.example`
3. `npm run d1:migrate:local`
4. `npm run dev`

Локальная обязательная проверка перед любой значимой задачей:

- `npm run lint`
- `npm run build`
- `npm run test`

## Как деплоить

Базовый порядок:

1. `npm install`
2. `npm run check`
3. `npm run d1:migrate:remote`
4. `npm run deploy`
5. `npm run telegram:webhook:set`
6. `npm run postdeploy:smoke`

GitHub Actions workflow `deploy` делает шаги 1-6 автоматически, если заданы нужные secrets и vars.

Подробная операционная инструкция лежит в [`docs/operations.md`](docs/operations.md).
Там отдельно разделено, что выполняется автоматически через GitHub Actions, а что остаётся ручным шагом.

## Как обновлять

- сначала читать `README.md`, `AGENTS.md`, `docs/*`, `PLANS.md`;
- после изменения логики, схемы данных, деплоя, команд или пользовательских сценариев обновлять документацию в этом репозитории;
- после изменения frozen-текстов обновлять [`docs/frozen/ui-texts.txt`](docs/frozen/ui-texts.txt) и связанные тесты.

## Как проверять

Локально:

- `npm run lint`
- `npm run build`
- `npm run test`
- `npm run d1:migrate:local`

После деплоя:

- `npm run telegram:webhook:set`
- `npm run postdeploy:smoke`

Автоматический smoke сейчас проверяет:

- `GET /health`
- `GET /diagnostics`
- доступность webhook path

## Как восстанавливать

Полная копия:

1. открыть `данные -> для этого бота`
2. `сохранить в файл`
3. для восстановления выбрать `загрузить из файла`
4. подтвердить замену текущих данных

Записи для других приложений:

1. открыть `данные -> в другие приложения`
2. `сохранить в файл`
3. бот отдаст CSV c колонками `date,time,amount,type,category,subcategory,description`
4. этот же CSV можно вернуть через `загрузить из файла`

## Ограничения free-плана

- нужно экономить D1-запросы и не плодить тяжёлые фоновые задачи;
- cron используется только для housekeeping, а не для тяжёлой бизнес-логики;
- post-deploy smoke проверяет HTTP-слой, но не заменяет живой ручной проход сценариев в Telegram;
- часть продуктовых сценариев всё ещё требует ручной проверки на реальном боте после деплоя.

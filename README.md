# Финансы

Production-ready Telegram-бот для учёта доходов и расходов прямо в Telegram. Проект рассчитан на автономную работу 24/7 без включённого компьютера владельца: весь runtime живёт в Cloudflare Workers, данные хранятся в Cloudflare D1, входящие обновления Telegram принимаются через webhook, а периодические проверки и напоминания запускаются через Cloudflare Cron Triggers.

## Текущий статус

Сейчас в проекте уже есть:

- GitHub-репозиторий: `https://github.com/lavshiba/dorashod`
- production Worker: `https://finance-bot.shiaboi.workers.dev`
- health endpoint: `https://finance-bot.shiaboi.workers.dev/health`
- webhook Telegram: `https://finance-bot.shiaboi.workers.dev/webhook/telegram/<secret>`
- D1 database `finance-bot-db`
- активные cron triggers `*/10 * * * *` и `0 4 * * *`
- GitHub CI и GitHub deploy workflow

Подтверждено автоматически:

- локальные `lint`, `build`, `test`, `check`
- GitHub Actions `ci`
- remote миграции D1
- прод-ответ `health`
- прод-ответ `diagnostics`
- регистрация cron schedules
- установка webhook

Пока не доведены до полного `definition of done`:

- полный охват всех продуктовых сценариев из ТЗ
- полный import/export flow
- массовые действия уже умеют базовый перенос, удаление и снятие подкатегории, но ещё не покрывают все крайние случаи ТЗ
- часть категорийного, подкатегорийного и карточечного flow ещё не доведена до конца
- часть крайних случаев custom period parsing и импорта ещё не доведены до полного соответствия ТЗ
- живой ручной чек реального ответа бота в вашем Telegram-чате

## Что умеет бот

- Пошагово и текстом добавлять доходы и расходы.
- Продолжать onboarding с того же шага после прерывания.
- Сохранять неполную запись как черновик.
- Складывать пачки записей и проблемные строки импорта в очередь `новые записи`.
- Показывать `операции`, `поиск`, `отчёт`, `категории`, `настройки`, `данные`.
- Показывать breakdown отчётов по расходам и доходам, карточки категорий и подкатегорий и списки `все записи` внутри отчёта.
- Поддерживать режим выбора нескольких записей в `операции`, `поиск` и списках отчёта.
- Выполнять базовые массовые действия: `перенести`, `удалить`, `снять подкатегорию`.
- Показывать стрелки перехода между записями внутри текущего списка и базовые карточки подкатегорий в разделе `категории`.
- Принимать файл в разделе `данные`, показывать preview полной копии и загружать записи из файла через `объединить` и `добавить всё`.
- Открывать `исправить n` по проблемным строкам импорта и разбирать их по одной.
- Понимать `свой период` заметно лучше: день, месяц, год, относительные периоды и часть диапазонов, с подтверждением для двусмысленных вариантов.
- Показывать скрытые подкатегории внутри категории и честно запрещать удаление непустых категорий и подкатегорий.
- В `изменить` спрашивать подтверждение перед уходом без сохранения, если есть несохранённые изменения.
- Поддерживать `выбрать несколько` в списках записей категории и подкатегории.
- Делать резервную копию для этого бота и обмен файлами записей с другими приложениями.

## Важный текущий риск

Локальные проверки проекта зелёные, но последние GitHub `deploy` workflow временно падают на шаге Cloudflare authentication: в `CLOUDFLARE_API_TOKEN` репозитория сейчас невалидный токен. Код и документация продолжают обновляться, однако для устойчивого автодеплоя через GitHub Actions этот секрет нужно заменить на рабочий Cloudflare API token с нужными правами.
- Работать с webhook, cron, health check, миграциями и диагностикой в проде.

## Стек

- Node.js: latest stable LTS в CI и локальной разработке.
- TypeScript `6.0.2`
- Wrangler `4.80.0`
- Cloudflare Workers
- Cloudflare D1
- Hono `4.12.10`
- grammY `1.42.0`
- Vitest `4.1.2`
- ESLint `10.2.0`

## Где хостится

- Код: `https://github.com/lavshiba/dorashod`
- Runtime: `https://finance-bot.shiaboi.workers.dev`
- База данных: Cloudflare D1 `finance-bot-db`
- Webhook Telegram: `POST /webhook/telegram/:secret`
- Health check: `GET /health`

## Данные

Основные данные хранятся в D1. Схема построена вокруг:

- пользователей и их настроек
- категорий и подкатегорий
- записей
- onboarding-состояния
- UI-сессии
- черновика
- очереди `новые записи`
- контекстов поиска, отчётов и импорта
- журнала cron/диагностики

Подробности лежат в [docs/architecture.md](/home/abihsgelo/Документы/dorashod/docs/architecture.md).

## Деплой

Основной поток:

1. `npm install`
2. `npm run check`
3. `wrangler login`
4. `wrangler d1 create finance-bot-db`
5. Обновить `database_id` в [wrangler.jsonc](/home/abihsgelo/Документы/dorashod/wrangler.jsonc)
6. Задать секреты через `wrangler secret put`
7. `npm run d1:migrate:remote`
8. `npm run deploy`
9. Поставить webhook и прогнать post-deploy checks

Подробная операционная инструкция находится в [docs/operations.md](/home/abihsgelo/Документы/dorashod/docs/operations.md).

## Как обновлять проект через Codex

Будущая поддержка проекта предполагается только через Codex. Перед любой новой задачей нужно читать:

- [README.md](/home/abihsgelo/Документы/dorashod/README.md)
- [AGENTS.md](/home/abihsgelo/Документы/dorashod/AGENTS.md)
- [docs/product-spec.md](/home/abihsgelo/Документы/dorashod/docs/product-spec.md)
- [docs/architecture.md](/home/abihsgelo/Документы/dorashod/docs/architecture.md)
- [docs/operations.md](/home/abihsgelo/Документы/dorashod/docs/operations.md)
- [docs/testing.md](/home/abihsgelo/Документы/dorashod/docs/testing.md)
- [PLANS.md](/home/abihsgelo/Документы/dorashod/PLANS.md)

Любое значимое изменение обязано сопровождаться актуализацией документации.

## Проверки

- `npm run lint`
- `npm run build`
- `npm run test`
- `npm run check`
- `npm run d1:migrate:local`
- `npm run postdeploy:smoke`

Полный план проверок лежит в [docs/testing.md](/home/abihsgelo/Документы/dorashod/docs/testing.md).

## Восстановление данных

Есть два пути:

- Полная копия `для этого бота`: включает записи, категории, подкатегории, настройки, черновик и `новые записи`.
- Обмен файлами `в другие приложения`: включает только записи.

Сценарии backup/restore и аварийного отката описаны в [docs/operations.md](/home/abihsgelo/Документы/dorashod/docs/operations.md).

## Ограничения free-плана

- Нужно экономить D1-запросы и cron-выполнения.
- Нельзя держать тяжёлые постоянные фоновые циклы.
- Нельзя делать бессмысленные пинги для “поддержания жизни”.
- Важно аккуратно проектировать SQL, индексы и пагинацию.

Проект учитывает это так:

- минимизирует количество запросов на обычные пользовательские действия
- хранит компактные UI-состояния
- использует paginated list views
- выносит периодические задачи в редкие cron-проверки
- избегает ORM-магии и лишних запросов

Компромиссы и риски описаны в [docs/architecture.md](/home/abihsgelo/Документы/dorashod/docs/architecture.md) и [docs/operations.md](/home/abihsgelo/Документы/dorashod/docs/operations.md).

## Важные файлы

- [src/index.ts](/home/abihsgelo/Документы/dorashod/src/index.ts)
- [wrangler.jsonc](/home/abihsgelo/Документы/dorashod/wrangler.jsonc)
- [migrations/0001_init.sql](/home/abihsgelo/Документы/dorashod/migrations/0001_init.sql)
- [docs/product-spec.md](/home/abihsgelo/Документы/dorashod/docs/product-spec.md)
- [docs/architecture.md](/home/abihsgelo/Документы/dorashod/docs/architecture.md)
- [docs/operations.md](/home/abihsgelo/Документы/dorashod/docs/operations.md)
- [docs/testing.md](/home/abihsgelo/Документы/dorashod/docs/testing.md)
- [AGENTS.md](/home/abihsgelo/Документы/dorashod/AGENTS.md)
- [PLANS.md](/home/abihsgelo/Документы/dorashod/PLANS.md)

## Секреты

Секреты не лежат в репозитории. Токен Telegram-бота, webhook secret, health token и другие секреты задаются только через Cloudflare Workers secrets. Пример структуры переменных есть в [.dev.vars.example](/home/abihsgelo/Документы/dorashod/.dev.vars.example), но без реальных значений.

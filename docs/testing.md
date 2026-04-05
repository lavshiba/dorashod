# Testing

## Обязательные Локальные Проверки

- `npm run lint`
- `npm run build`
- `npm run test`
- `npm run d1:migrate:local`

## Что Проверяется Автоматически

Unit и integration tests сейчас покрывают:

- валидацию env;
- health endpoint;
- callback encoding;
- category transfer planning;
- custom period parsing;
- parsing одиночной записи;
- parsing CSV/JSON импорта;
- исправление проблемных строк импорта;
- repo-local frozen source file и ключевые frozen-тексты;
- CSV export serialization;
- round-trip `CSV export -> CSV import`;
- housekeeping queries для cron;
- reset настроек как часть `очистить всё`.

## Post-Deploy Smoke

Автоматический smoke запускается командой:

- `npm run postdeploy:smoke`

Он использует:

- `POST_DEPLOY_BASE_URL`
- `POST_DEPLOY_WEBHOOK_SECRET`
- `POST_DEPLOY_HEALTH_TOKEN`

Smoke проверяет:

- `health`;
- `diagnostics`;
- доступность webhook path.

## Что Пока Не Автоматизировано Полностью

Остаются ручные живые проверки в Telegram:

- onboarding на реальном боте;
- пошаговое добавление записи;
- работа очереди `новые записи`;
- карточки записи и редактирование;
- импорт и экспорт через реальные Telegram documents;
- реальный delivery update после production deploy.

Эти проверки нужно честно проходить отдельно после крупных релизов.

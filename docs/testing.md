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
- single-screen helpers: сохранение `screenMessageId`, inline edit вместо лишнего нового сообщения, сброс session без потери экрана.

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

## Manual Telegram Checklist

Короткий живой чек после крупных релизов:

- onboarding: пройти 7 экранов, `пропустить`, `перенести данные`, возвраты `назад`
- add flow: расход и доход кнопками, полноценная строка, неполная строка
- queue: пачка записей, сохранение, изменение, пропуск
- edit card: открыть карточку записи, изменить запись, удалить запись
- search: обычный поиск, конфликт поиска с новой строкой, конфликт с пачкой строк
- import/export documents: полная копия и CSV для других приложений
- settings/data: `сбросить настройки` и `очистить всё`
- webhook/prod: отправить реальное сообщение в Telegram после deploy и убедиться, что отвечает свежая версия бота

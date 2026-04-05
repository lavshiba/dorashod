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
- полное frozen coverage по 12 главным разделам интерфейса;
- CSV export serialization;
- round-trip `CSV export -> CSV import`;
- housekeeping queries для cron;
- reset настроек как часть `очистить всё`.
- single-screen helpers: сохранение `screenMessageId`, inline edit вместо лишнего нового сообщения, сброс session без потери экрана.
- search conflicts: `новая запись` и `пачка новых записей` не перехватываются как поисковый запрос.

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

Живой чек, который остаётся обязательным после крупных релизов:

- onboarding: пройти 7 экранов, `пропустить`, `перенести данные`, возвраты `назад`
- старт после пропуска onboarding
- пустая главная
- рабочая главная
- добавление записи кнопками
- добавление записи текстом
- неполная текстовая запись
- черновик
- новые записи
- операции
- карточка записи
- редактирование записи
- поиск
- конфликт поиска с новой записью
- конфликт поиска с пачкой новых записей
- отчёты
- категории
- подкатегории
- настройки
- данные
- полная копия
- CSV для других приложений
- `сбросить настройки`
- `очистить всё`
- webhook/prod: отправить реальное сообщение в Telegram после deploy и убедиться, что отвечает свежая версия бота
- реальный delivery update после deploy

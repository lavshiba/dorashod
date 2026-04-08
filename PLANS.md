# PLANS

## Текущий Этап

Стабилизация production-ready версии Telegram-бота `финансы` на Cloudflare Workers + D1 после аудита логики, документации и деплойного сценария.

## Уже Закрыто

- repo-local frozen source of truth перенесён в `docs/frozen/ui-texts.txt`;
- repo-local frozen source of truth выровнен с согласованным внешним frozen-файлом и покрывает весь ключевой интерфейс бота;
- экспорт `в другие приложения` переведён на CSV;
- `очистить всё` теперь сбрасывает и данные, и пользовательские настройки;
- cron больше не заглушка и делает housekeeping;
- deploy workflow теперь настраивает webhook и запускает post-deploy smoke;
- webhook защищён вторым слоем через `X-Telegram-Bot-Api-Secret-Token`, а deploy/smoke учитывают это;
- импорт `в другие приложения` стал терпимее к внешним CSV-шапкам, `null` и датам с секундами;
- import/data helpers вынесены из giant `bot-service` в отдельный модуль;
- мёртвый секрет `BACKUP_SIGNING_KEY` удалён из env/schema/examples;
- README и `docs/*` переписаны под фактическое состояние проекта.

## Ближайшие Задачи

- Пройти живой ручной check production-бота в Telegram после следующего deploy.
- Проверить вживую:
  - экспорт CSV и повторный импорт через реальный Telegram document;
  - import preview при неполной или частично распознанной внешней CSV-шапке;
  - `очистить всё` на production-копии;
  - webhook после реального deploy;
  - cron housekeeping по данным `/diagnostics`.

## Следующие Продуктовые Улучшения

- усилить сценарные тесты для крупных Telegram flow;
- расширить ручную smoke-карту под импорт, поиск и отчёты;
- при необходимости добавить новые продуктовые cron-задачи, если у них появится реальная ценность для текущего продукта.

# tg-bot-dsh — правила работы агента

Telegram-пульт для DeepSeek Harness: плагин `dsh-telegram-channel-ru` (пакет на
npm; ответвление `hi-wenw/dsh-telegram-channel`, репозиторий тоже переименован в
`danilinao/dsh-telegram-channel-ru`, старые адреса редиректятся).
Плагин живёт **внутри процесса `dsh web`**. В профиле `web` он установлен
онлайн — `github:danilinao/dsh-telegram-channel-ru` (снимок `main`), поэтому правки
в этой папке в бота сами не попадают: для разработки переключить на
`link:/home/alexey/projects/tg-bot-dsh`, после — вернуть `github:` и переустановить.
Помнить: `id` плагина в профиле равен имени пакета (`dsh-telegram-channel-ru`),
поэтому строка с токеном в `cordis.patch.yml` должна быть с этим `id`.

## Сначала — память

1. `/home/alexey/agent-memory/projects/tg-bot-dsh/MEMORY.md` — архитектура,
   грабли, решения (читать первым делом);
2. `state.md` — где мы сейчас;
3. `NOW.md` — последние компакты (пишется автоматически).

## Код и сборка

- **`src/` — источник истины, `lib/` — результат сборки.** DSH исполняет
  `lib/index.js`, поэтому после правки `src/` обязательно `npm run build` (или
  `npm run check` целиком). `lib/` коммитится — клон без сборки тоже работает.
- `npm test` — 62 теста по `src/`; `npm run test:lib` проверяет, что `lib/`
  собран из текущего `src/`; `npm run check` = typecheck → build → тесты.
- В `lib/` не должно быть китайских литералов (наследие upstream): они ловятся
  `test:lib`, но лучше сразу переводить строки в `src/commands.ts`.
- Подробно — [BUILD.md](BUILD.md).

## Работа с живым DSH

- **Плагин монтируется только при старте `dsh`.** Правки в `lib/` без рестарта
  не видны.
- **Рестарт `dsh` — только по разрешению владельца.** Он просил спрашивать.
  Безопасный способ: `sudo systemd-run --on-active=45
  --unit=dsh-tg-reload-$(date +%H%M%S) /home/alexey/dsh-tg-reload.sh` — таймер
  срабатывает после доставки сообщения, скрипт откатывает плагин из профиля,
  если Web не поднялся. Лог: `/var/log/dsh-tg-reload.log`, успех —
  `OK - telegram channel plugin mounted, no rollback`.
- Версия в `package.json` участвует в проверке совместимости: peer-диапазоны
  `@deepseek-ai/dsh*` рассчитаны на рантайм хоста. Если хост обновится до
  несовместимой версии — либо правим диапазоны, либо выдаём исключение
  `dsh plugin --profile web allow-version ... --accept-risk`.

## Релизы и публикация

- **Пуш и релизы делает агент сам**, без отдельного запроса.
- **Релиз — только на крупное изменение** (новая возможность, смена модели
  работы, крупный рефакторинг). Мелкие правки — обычные коммиты в `main`.
- Порядок: `npm run check` → `npm version <major|minor|patch>
  --no-git-tag-version` → запись в `CHANGELOG.md` → коммит → `git tag vX.Y.Z` →
  `git push origin main --tags` (или `./PUBLISH.sh`, он берёт токен из хранилища
  DSH) → GitHub Release с описанием из `CHANGELOG.md`.
- npm-публикация: пакет `dsh-telegram-channel-ru` на npm (владелец
  `lex1133`). **Основной путь — CI без токенов:** толчок тега `v*` запускает
  `.github/workflows/publish.yml` (Trusted Publishing по OIDC, `--provenance`).
  Доверие к workflow настраивается один раз владельцем через `npm trust github`
  или страницу пакета на npmjs.com (требует 2FA и сессии — granular-токен не
  подходит). Запасной путь — `./PUBLISH-npm.sh` с токеном `NPM_TOKEN` из
  `~/.dsh/.credentials.yaml` (`--dry-run` — только состав). Загвоздки ручной
  публикации (staged publishing, заглушка `0.0.0-stage`, «cannot publish over»)
  разобраны в [BUILD.md](BUILD.md).

## Секреты

Токен бота, `GITHUB_TOKEN` и `NPM_TOKEN` живут только в
`~/.dsh/profiles/web/cordis.patch.yml` и `~/.dsh/.credentials.yaml`.
В репозиторий, README, `CHANGELOG` и память их не писать.

## Проверка вживую

Боту пишет владелец (у агента второй поллер даёт `409 Conflict`). После
рестарта просить у него `/status` и одно сообщение в привязанную сессию.

# tg-bot-dsh — правила работы агента

Telegram-пульт для DeepSeek Harness: плагин `dsh-telegram-channel` (ответвление
`hi-wenw/dsh-telegram-channel`). Плагин живёт **внутри процесса `dsh web`** и
подключён к профилю `web` как `link:`-зависимость из этой папки.

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
- npm-публикация пока не настроена: на хосте нет npm-токена (`npm whoami` →
  `ENEEDAUTH`). Пакет к ней готов (`npm pack`, `prepublishOnly`).

## Секреты

Токен бота и `GITHUB_TOKEN` живут только в
`~/.dsh/profiles/web/cordis.patch.yml` и `~/.dsh/.credentials.yaml`.
В репозиторий, README, `CHANGELOG` и память их не писать.

## Проверка вживую

Боту пишет владелец (у агента второй поллер даёт `409 Conflict`). После
рестарта просить у него `/status` и одно сообщение в привязанную сессию.

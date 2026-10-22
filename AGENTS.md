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
- `npm test` — 99 тестов по `src/`; `npm run test:lib` проверяет, что `lib/`
  собран из текущего `src/`; `npm run check` = typecheck → build → тесты.
- **`client/client.js` — браузерная половина (страница настроек), без сборки.**
  Это классический скрипт для `window.__ModuleLoader__`, его не трогает `tsc`;
  правится и коммитится как есть. `npm run test:browser` рендерит его с
  настоящим React в headless Chrome (в `npm run check` не входит).
- Подробно — [BUILD.md](BUILD.md).

## Страница настроек в Web (контракт DSH 0.2)

- Поля Config помечены `.volatile()` — иначе DSH не строит форму, а запись
  отклоняется (`isVolatilePath`). Плагин получает их как боксы (`Volatile`) и
  читает через `readVolatile` (`src/config.ts`).
- `token` помечен `.role('secret')`: DSH вырезает его из документа настроек,
  поэтому страница показывает только «сохранён» + `getMe`-статус.
- Форма регистрируется в слот `plugins.bundle.config` с ключом, равным **имени
  пакета** (у нас `id` строки в профиле совпадает с именем пакета).
- Сохранение = `scope.mutate(ops)` (атомарно, только изменённые поля). Плагин
  ловит `loader/volatile-update`, останавливает мост (`AbortSignal` в
  `getUpdates`!) и поднимает новый; смещение `getUpdates` переносят, при смене
  токена — сбрасывают.
- Несекретные факты (кто владелец токена, имена из `getChat`, кто писал боту)
  отдаются двумя маршрутами `/plugins/dsh-telegram-channel-ru/settings/{info,resolve}`
  (`src/settings-api.ts`); токен по ним не ходит.
- Не добавлять в клиент импорты пакетов Harness: только `require('react')`
  (иначе нужен `dsh.client.external` и сборка бандла).
- В `lib/` не должно быть китайских литералов (наследие upstream): они ловятся
  `test:lib`, но лучше сразу переводить строки в `src/commands.ts`.

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
  `lex1133`). **Основной путь — CI без токенов и работает:** толчок тега `v*`
  запускает `.github/workflows/publish.yml` (Trusted Publishing по OIDC,
  `--provenance`); первый прогон — `v0.8.2`, success, provenance ушла в
  sigstore. Доверие привязано к `danilinao/dsh-telegram-channel-ru` +
  `publish.yml` (настраивается владельцем через `npm trust github` или страницу
  пакета — granular-токену оба запроса отвечают 403). Пуш правок в
  `.github/workflows/*` требует scope `workflow` у `GITHUB_TOKEN`. Запасной
  путь — `./PUBLISH-npm.sh` с токеном `NPM_TOKEN` (`--dry-run` — только
  состав). Загвоздки ручной публикации (staged publishing, заглушка
  `0.0.0-stage`, «cannot publish over») — в [BUILD.md](BUILD.md).

## Секреты

Токен бота, `GITHUB_TOKEN` и `NPM_TOKEN` живут только в
`~/.dsh/profiles/web/cordis.patch.yml` и `~/.dsh/.credentials.yaml`.
В репозиторий, README, `CHANGELOG` и память их не писать.

## Проверка вживую

Боту пишет владелец (у агента второй поллер даёт `409 Conflict`). После
рестарта просить у него `/status` и одно сообщение в привязанную сессию.

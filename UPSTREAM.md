# Происхождение, сборка, синхронизация

`dsh-telegram-channel` — **русский клон
[hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
с доработками** (оригинал — MIT). База — коммит `7af6cef` (версия `0.3.5`);
наши коммиты лежат сверху, поэтому в истории видны и авторы оригинала, и наши
изменения. `upstream` — обычный remote для синхронизации с оригиналом.

```
origin    https://github.com/danilinao/dsh-telegram-channel.git
upstream  https://github.com/hi-wenw/dsh-telegram-channel.git
```

## Что сделано поверх базы

1. **Русский интерфейс.** Все пользовательские строки: `/start`, `/help`, меню
   команд Telegram, `/status`, `/compact`, `/model`, `/rich`, пикеры, уведомления,
   тексты ошибок. Плюс карточка бота (`setMyDescription`, `setMyShortDescription`) —
   раньше она была пустой.
2. **Архивные сессии скрыты из меню выбора.** Сравниваются оба написания id
   (`session-<uuid>` и `<uuid>`), учитываются проекционные флаги
   `archived`/`archivedAt` и `archivedSessionIds`. Рабочие области без живых
   сессий тоже исчезают.
3. **На кнопке сессии — её наименование:** `N. <имя> ▶/▷`, где имя берётся из
   заголовка сессии → первого сообщения (`titleInput.first.text`) → `область · дата`.
   Для холодных сессий имя дотягивается через проекции хоста (кэш по `updatedAt`).
4. **Работа с DSH 0.2.x.** Плагин 0.3.5 обращался к сервису `apiProxy`, которого в
   0.2 больше нет: меню падало в режим «только запущенные сессии». Теперь каталог,
   модели и создание сессий идут через хост-сервисы, которыми пользуется сам Web UI:
   `workspaceRegistry` (порядок областей + архив), `sessionController.list()` (все
   сессии с проекциями), `sessionController.modelCatalog()` /
   `selectModel()` (модели), `create()` (`/new`) и `prompt()` (картинки). Путь
   через `apiProxy` сохранён для старых хостов и используется, если сервис доступен.
5. **Управление проектами и сессиями с телефона.** Список областей показывает все
   проекты, включая пустые; в пустой области создаётся сессия. `/newproject`
   добавляет папку через `workspaceRegistry.create`, 🗄/`/archive` убирают сессию
   через `workspaceRegistry.archiveSession(id, { stopActivity: true })`.
6. **Вывод с спойлерами и история.** Вызовы инструментов уходят с полными
   аргументами, рассуждения — отдельным блоком, и то и другое в
   `<blockquote expandable>` (свёрнуто до тапа). При привязке показывается
   последняя страница истории через `sessionController.page` (реплики, ответы,
   вызовы инструментов спойлером), кнопка «⬅ Раньше» листает по `beforeSeq`,
   `/history` — вручную.
7. **Архив с восстановлением.** `/archived` + кнопка «↩» →
   `workspaceRegistry.unarchiveSession(id)`.
8. **Уведомления о состоянии.** `turn/end` разбирается по причине: `completed`
   (✅), `error` (текст + подсказка по коду/тексту), `max-tokens`, `blocked`,
   `aborted`, `interrupted`; вопрос агента приходит как «❓ Сессия задала вопрос и
   ждёт ответа» + название сессии и проекта (проект — из реестра областей, иначе
   basename cwd). Канал уведомлений не привязан к привязке: по
   умолчанию бот следит за всеми сессиями (`/notify every`), `/notify bound`
   сужает до привязанной, `/notify on | errors | off` — набор событий. Состояние
   хранится в `telegram-channel-bindings.json` (`notifyPrefs`, `notifyScope`,
   `knownChats`); чат запоминается при любом обращении к боту.

Код: `src/catalog.ts` (`normalizeSessionId`, `isArchived`, `loadCatalogFromHost`,
`resolveSessionTitle`), `src/bridge.ts` (`sessionButtonText`, `ensureSessionNames`),
`src/client.ts` + `src/bridge.ts` (профиль бота).

## Сборка

`src/` — источник истины, `lib/` — результат сборки (`npm run build`, tsc).
До 0.8.0 toolchain на хосте не собирался и `lib/` правился руками параллельно с
`src/`; это дало расхождение (например, `lib/*.d.ts` оставались китайскими).
Теперь сборка работает, и дублировать код вручную не нужно:

```bash
npm install      # tsc, tsx, @types/node + peer-пакеты DSH для типов
npm run check    # typecheck → build → 62 теста → проверка свежести lib/
```

Подробности и публикация — в [BUILD.md](BUILD.md).

## Установка и версия

```bash
dsh plugin --profile web add link:/home/alexey/projects/tg-bot-dsh
systemctl restart dsh        # плагин монтируется только при старте
```

> Переезд 2026-10-21: код лежит в `/home/alexey/projects/tg-bot-dsh`, а на
> старом месте `/home/alexey/dsh-plugins/dsh-telegram-channel` оставлен симлинк
> на него — профиль `web` по-прежнему ссылается на старый путь.

С 0.8.0 peer-диапазоны `@deepseek-ai/dsh*` рассчитаны на текущий рантайм
(`^0.2.1-alpha.2`), поэтому исключение `allow-version` больше не требуется.
Если хост обновится до несовместимой версии, DSH откажется грузить плагин —
тогда выдаётся исключение:

```bash
dsh plugin --profile web allow-version dsh-telegram-channel@<версия> \
  --dsh-version <версия dsh> --accept-risk
```

Исключения копятся в `~/.dsh/profiles/web/compatibility.json`. Плагин
подключается как `link:` — правки в репозитории применяются после перезапуска
`dsh`.

## Синхронизация с оригиналом

```bash
git fetch upstream
git log --oneline upstream/master..HEAD        # что у нас сверху
git rebase upstream/master                     # перенести наши коммиты на свежий оригинал
```

После ребейза обязательно: `npm run check` и перевод новых строк
(`python3 -c "import re,sys;..."` или `git grep -nP '[\x{4e00}-\x{9fff}]' src/`
на ripgrep). Русские тексты живут в `src/commands.ts`, в `lib/` они попадают
сборкой.

## Публикация

```bash
./PUBLISH.sh              # push main + теги
./PUBLISH.sh --dry-run    # что уйдёт
```

Токен читается из `~/.dsh/.credentials.yaml` (`refs.GITHUB_TOKEN`) и передаётся
git через `GIT_ASKPASS` — в `.git/config`, в истории shell и в репозитории его нет.
Нужны права `Contents: write`; для правки описания и тем репозитория через API
нужно ещё `Administration: write` (иначе — вручную в веб-интерфейсе).

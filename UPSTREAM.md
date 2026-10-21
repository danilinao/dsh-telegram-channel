# Ответвление: происхождение, сборка, синхронизация

`dsh-telegram-channel` — самостоятельный проект, ответвление от
[hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
(лицензия MIT). База — коммит `7af6cef` (версия `0.3.5`); наши коммиты лежат
сверху, поэтому в истории видны и авторы оригинала, и наши изменения. Отдельного
GitHub-fork-отношения нет: репозиторий создан независимо, а `upstream` — обычный
remote для синхронизации.

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
   0.2 больше нет: меню падало в режим «только запущенные сессии». Теперь каталог
   читается из хост-сервисов, которыми пользуется сам Web UI:
   `workspaceRegistry` (порядок областей + архив) и `sessionController.list()`
   (все сессии с проекциями). Путь через `apiProxy` сохранён для старых хостов и
   используется, если сервис доступен.

Код: `src/catalog.ts` (`normalizeSessionId`, `isArchived`, `loadCatalogFromHost`,
`resolveSessionTitle`), `src/bridge.ts` (`sessionButtonText`, `ensureSessionNames`),
`src/client.ts` + `src/bridge.ts` (профиль бота).

## Сборка: `lib/` — исполняемый код

DSH грузит пакет через `main: lib/index.js`, поэтому правки вносятся **в `src/*.ts`
и в `lib/*.js` параллельно**. На хосте, где велась работа, не было toolchain:

- `pnpm add -D typescript` падает: peer-зависимости тянут
  `@deepseek-ai/dsh-type-meta`, которого нет в npm (404);
- `npm install` отваливается по таймауту.

Проверки без сборки:

```bash
# синтаксис TypeScript (Node 26 умеет strip-types); ERR_MODULE_NOT_FOUND ожидаем —
# это резолв peer-пакетов вне рантайма DSH
node --experimental-strip-types -e "import('file://$PWD/src/bridge.ts')"

# синтаксис исполняемого JS
for f in lib/*.js; do node --check "$f"; done

# паритет: все русские литералы из src должны быть и в lib
# и ни одного китайского литерала в lib (кроме комментариев)
```

Когда появится машина с доступным npm: `pnpm add -D typescript @types/node && pnpm build`
перезапишет `lib/` из `src/` — ручное дублирование тогда можно прекратить.

## Установка и версия

```bash
dsh plugin --profile web add link:/home/alexey/dsh-plugins/dsh-telegram-channel
systemctl restart dsh        # плагин монтируется только при старте
```

DSH проверяет совместимость по **точной** версии пакета, поэтому для `0.4.0`
выдано исключение:

```bash
dsh plugin --profile web allow-version dsh-telegram-channel@0.4.0 \
  --dsh-version 0.2.1-alpha.2 --accept-risk
```

Исключение хранится в профиле, рядом с `package.json`; при смене версии пакета
его нужно выдать заново. Плагин подключается как `link:` — правки в репозитории
применяются после перезапуска `dsh`, без пересборки из npm.

## Синхронизация с оригиналом

```bash
git fetch upstream
git log --oneline upstream/master..HEAD        # что у нас сверху
git rebase upstream/master                     # перенести наши коммиты на свежий оригинал
```

После ребейза обязательно: прогнать проверки из раздела «Сборка», перевести новые
строки (`git grep -n '[一-龥]' src/`), продублировать их в `lib/` и убедиться, что
китайских литералов в `lib/` не осталось.

## Публикация

```bash
./PUBLISH.sh              # push main + теги
./PUBLISH.sh --dry-run    # что уйдёт
```

Токен читается из `~/.dsh/.credentials.yaml` (`refs.GITHUB_TOKEN`) и передаётся
git через `GIT_ASKPASS` — в `.git/config`, в истории shell и в репозитории его нет.
Нужны права `Contents: write`; для правки описания и тем репозитория через API
нужно ещё `Administration: write` (иначе — вручную в веб-интерфейсе).

## Требование к сети

`api.telegram.org` доступен не везде: в РФ он режется по IP. Маршрут до Telegram
DC (`149.154.160.0/20`, `91.108.4.0/22`) заводится в тоннель (в этом хозяйстве —
AmneziaWG: `sudo tunnel-route add 149.154.160.0/20`, записи в
`/etc/tunnel-route/extras.txt`). Без маршрута long-poll молча таймаутит.

# dsh-telegram-channel

> **Русский клон [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
> с доработками.** Взята база `0.3.5` (коммит `7af6cef`) и добавлено: полностью
> русский интерфейс, скрытие архивных сессий в меню выбора, наименование сессии на
> кнопке, чтение каталога через хост-сервисы DSH 0.2 (там, где оригинал ждал
> удалённый `apiProxy`), и русская карточка бота. Репозиторий:
> <https://github.com/danilinao/dsh-telegram-channel>. Что именно изменено и как
> синхронизироваться с оригиналом — в [UPSTREAM.md](UPSTREAM.md).

Telegram-пульт для **DeepSeek Harness**: телефон подключается к уже идущей сессии
на компьютере и продолжает её — **один диалог, две стороны**. Компьютер остаётся
источником истины: плагин не запускает второй агент и не дублирует контекст, а
работает с теми же сессиями, что открыты в Web. Плагин живёт внутри процесса
`dsh web` и подключается в профиль как `link:`.

## Что умеет

- **Пульт к живой сессии.** `/sessions` → рабочая область → сессия → привязка.
  Дальше всё, что вы пишете в Telegram, попадает в эту же сессию; ответы и работа
  инструментов видны и на компьютере.
- **Русский интерфейс.** Команды, меню бота, пикеры, `/status`, `/compact`,
  уведомления и карточка бота — по-русски.
- **Архивные сессии скрыты.** Меню показывает только живые сессии: учитываются
  оба написания id (`session-<uuid>` и `<uuid>`), проекционные флаги архива и
  список `archivedSessionIds`. Области, где не осталось ничего живого, из меню
  тоже исчезают.
- **На кнопке — имя сессии.** `N. <наименование> ▶/▷`; имя берётся из заголовка
  сессии, иначе из первого сообщения, иначе `рабочая область · дата`.
  `▶` — сессия в памяти, `▷` — поднимется при привязке.
- **Не только текст.** Картинки (png/jpeg/webp/gif, в том числе с подписью;
  альбомы склеиваются в одно сообщение).
- **Двусторонние вопросы и подтверждения.** Когда агент спрашивает «какой
  вариант?» или просит разрешение на инструмент, ответить можно из Telegram;
  ответ из Web закрывает канал в TG.
- **Модель, контекст, сжатие.** `/model`, `/status`, `/compact`, `/mission`,
  `/stop`, `/new` — из телефона.
- **Проекты и сессии целиком с телефона.** В списке видны все рабочие области,
  включая пустые; в пустой области кнопка создаёт сессию. `/newproject <путь>` (или
  кнопка «➕ Новый проект») добавляет в реестр новую папку, `/new` создаёт диалог в
  текущей области, 🗄 у сессии или `/archive` убирают её в архив (работа
  останавливается, из меню и Web сессия исчезает).
- **Уведомления о состоянии сессии.** В чат приходит: успешное завершение хода,
  падение с текстом ошибки и подсказкой (кончились токены/квота, лимит запросов,
  модель недоступна, переполнен контекст, сеть, ключ), достижение лимита выходных
  токенов, аварийный обрыв, и вопрос агента («❓ Сессия задала вопрос и ждёт
  ответа»). Режим переключается: `/notify on | errors | off`.

## Установка

```bash
dsh plugin --profile web add link:/путь/к/dsh-telegram-channel
systemctl restart dsh           # плагин монтируется при старте
```

Конфигурация — строка `- id: dsh-telegram-channel` в `~/.dsh/profiles/web/cordis.patch.yml`
(именно `id`-оверрайд, а не `insert`: id уже вставлен бандлом плагина):

```yaml
- id: dsh-telegram-channel
  name: dsh-telegram-channel
  config:
    token: "<токен от @BotFather>"
    allowedUserIds: [<ваш числовой id из @userinfobot>]
```

| Ключ | Смысл |
|---|---|
| `token` / `DSH_TELEGRAM_TOKEN` | токен бота |
| `allowedUserIds` / `DSH_TELEGRAM_ALLOWED_USER_IDS` | белый список; пусто — бот не отвечает никому |
| `allowAllUsers` | `true` только для отладки |
| `maxMessageLength` | по умолчанию 4096 |
| `pollingTimeoutSec` | по умолчанию 30 |
| `rendering` | `html` (по умолчанию, любой клиент) или `rich` |

## Команды

| Команда | Что делает |
|---|---|
| `/sessions` | рабочие области → сессии → привязка (архив и пустые скрыты) |
| `/last` | последний вопрос-ответ привязанной сессии |
| `/model` | сменить модель (действует со следующего хода) |
| `/status` | модель, глубина размышлений, контекст, TTFT, токены |
| `/compact` | сжать историю сессии (когда она свободна) |
| `/rich` | `on` — rich-рендер, `off` — HTML (для этого чата) |
| `/stop` | прервать текущий ход |
| `/mission` | список задач и прогресс |
| `/new` | новый диалог в текущей области и привязка |
| `/newproject <путь> [\| Название]` | добавить папку как проект (рабочую область) |
| `/archive` | убрать привязанную сессию в архив |
| `/notify on\|errors\|off` | какие уведомления присылать |
| `/projects` | список проектов и сессий (то же, что `/sessions`) |
| `/unbind` | отвязать телефон (сессия на компьютере остаётся) |
| `/cancel` | закрыть ответы/подтверждения в Telegram |
| `/help` | помощь |

## Совместимость

Плагин работает с **DSH 0.2.x**: каталог сессий, список моделей и создание
сессий читаются напрямую из хост-сервисов (`sessionController.list`,
`workspaceRegistry`, `sessionController.modelCatalog` / `selectModel` / `create`),
потому что сервис `apiProxy`, на который опирался оригинал 0.3.5, в 0.2 удалён.
Старый путь через `apiProxy` сохранён и используется, если сервис доступен.
Отправка изображений тоже портирована: на 0.2 вложение уходит через
`sessionController.prompt`.
Проекты и архив — через `workspaceRegistry.create` / `archiveSession`.

Версия `0.4.0`. Проверка совместимости DSH привязана к точной версии пакета,
поэтому для неё выдано исключение — см. [UPSTREAM.md](UPSTREAM.md).

## Происхождение и лицензия

Клон [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
(MIT, база — коммит `7af6cef`). История коммитов сохранена: в ней видны авторы
оригинала, сверху — наши доработки. Как синхронизироваться с оригиналом и как
публиковать — в [UPSTREAM.md](UPSTREAM.md).

Лицензия — MIT ([LICENSE](LICENSE)); уведомление об авторских правах оригинала
сохранено.

---

# English

## About

A Telegram remote for **DeepSeek Harness** (`dsh`): attach a live web session from
your phone and keep working in the *same* conversation — one trajectory, two
sides, in the spirit of Codex-style remote control.

The desktop session is the source of truth. The plugin runs inside the `dsh web`
process, never spawns a second agent and never forks the context: whatever you
send from the phone lands in the session that is already open on the computer,
and both sides see the same messages, tool calls and answers.

This is a **Russian clone of [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
with additions**, built on the `0.3.5` base (commit `7af6cef`). See
[UPSTREAM.md](UPSTREAM.md) for the exact diff against the original and for the
sync/publish workflow.

## Features

- **Attach to a live session.** `/sessions` walks workspace → session → attach.
  After attaching, plain text (and images) go straight into that session.
- **Russian UI.** Every user-facing string — commands, Telegram command menu,
  pickers, `/status`, `/compact`, notifications, errors — is Russian, and the bot
  carries a Russian profile card (`setMyDescription` / `setMyShortDescription`).
- **Archived sessions hidden.** The picker only lists live sessions. Archived ids
  are matched in both spellings (`session-<uuid>` and `<uuid>`), the per-item
  `archived` / `archivedAt` flags are honoured, and `archivedSessionIds` from the
  host is merged in. Workspaces left with nothing live disappear from the menu.
- **Session names on the buttons.** A button reads `N. <name> ▶/▷`, where the
  name comes from the session title, else the first user message
  (`titleInput.first.text`), else `workspace · date`. `▶` means the session is
  live in memory, `▷` means it is parked and will be resumed on attach. Cold
  sessions are named through the host's projection API, cached by `updatedAt`.
- **Images, not just text.** PNG/JPEG/WebP/GIF, with or without a caption; album
  photos are merged into a single message. Images go through the host attachment
  service, the same channel the web UI uses.
- **Two-way questions and approvals.** When the agent asks a multiple-choice
  question or requests permission for a tool, you can answer from Telegram; an
  answer given in the web UI closes the Telegram channel for that request.
- **Model, context and compaction from the phone.** `/model`, `/status`,
  `/compact`, `/mission`, `/stop`, `/new`.
- **Projects and sessions, fully managed from the phone.** The workspace list
  shows every registered project including empty ones; an empty project offers a
  "create session here" button. `/newproject <path> [ | Title]` (or the
  "➕ Новый проект" button) registers a new folder, `/new` creates a session in
  the current workspace, and 🗄 next to a session (or `/archive`) moves it to the
  archive — the session is stopped and disappears from both the menu and the web
  UI.
- **Session state notifications.** The chat receives a ✅ when a turn completes,
  a ⚠️ with the error text plus a hint when it fails (quota/tokens exhausted,
  rate limit, model unavailable, context overflow, network, credentials), a
  warning for the output-token ceiling and for crash-orphaned turns, and
  "❓ the session asked a question and is waiting". Per-chat mode:
  `/notify on | errors | off`.

## Requirements

- A working DeepSeek Harness with the `web` profile (`dsh web`).
- Node.js as shipped with Harness.
- A Telegram bot token from [@BotFather](https://t.me/BotFather) and your own
  numeric user id from [@userinfobot](https://t.me/userinfobot) — the allowlist is
  a hard gate: with it empty, the bot answers nobody.
- Outbound HTTPS to `api.telegram.org`. If your network needs a proxy or a VPN,
  set `HTTP(S)_PROXY` for the harness process or route it at the OS level — the
  plugin itself knows nothing about tunnels and just uses an ordinary HTTPS
  client (with environment proxy support).
- No Python, no extra services.

## Installation

```bash
git clone https://github.com/danilinao/dsh-telegram-channel /path/to/dsh-telegram-channel
dsh plugin --profile web add link:/path/to/dsh-telegram-channel
systemctl restart dsh        # the plugin is mounted at startup only
```

The plugin runs from the checkout through a `link:` dependency, so edits apply
after a `dsh` restart — no npm publish or rebuild is needed.

### Configuration

Put an **id-targeted override** in `~/.dsh/profiles/web/cordis.patch.yml` (the
row id is already inserted by the plugin bundle, so re-`insert` would create a
duplicate and the loader would reject it):

```yaml
- id: dsh-telegram-channel
  name: dsh-telegram-channel
  config:
    token: "<BotFather token>"
    allowedUserIds: [123456789]
    allowAllUsers: false
    maxMessageLength: 4096
    pollingTimeoutSec: 30
    rendering: html
```

| Key | Environment variable | Meaning |
|---|---|---|
| `token` | `DSH_TELEGRAM_TOKEN` | bot token; without it polling never starts |
| `allowedUserIds` | `DSH_TELEGRAM_ALLOWED_USER_IDS` | numeric user ids allowed to talk to the bot; empty = nobody |
| `allowAllUsers` | — | accept anyone; debugging only |
| `maxMessageLength` | — | outgoing message chunk size, default 4096 |
| `pollingTimeoutSec` | — | long-poll timeout, default 30 |
| `rendering` | — | `html` (default, works in every client) or `rich` (Telegram native rich messages) |

`name` is required on an id-targeted row: without it the plugin manager cannot map
the row back to its loader entry and the settings form becomes read-only.

## Commands

| Command | What it does |
|---|---|
| `/start` | welcome text and short usage hint |
| `/sessions` | workspace list → session list → attach (archive and blank sessions hidden) |
| `/last` | last question/answer of the attached session |
| `/model` | switch the session's model (takes effect on the next turn) |
| `/status` | model, reasoning effort, context pressure, TTFT, input/output tokens, cache hit |
| `/compact` | compact the attached session's history (only while it is idle) |
| `/rich` | `on` — rich rendering, `off` — HTML (this chat only, remembered) |
| `/stop` | abort the current turn |
| `/mission` | todo list and progress |
| `/new` | create a new session in the current workspace and attach to it |
| `/newproject <path> [\| Title]` | register a folder as a project (workspace) |
| `/archive` | move the attached session to the archive |
| `/notify on\|errors\|off` | which notifications this chat receives |
| `/projects` | project/session list (alias of `/sessions`) |
| `/unbind` | detach the phone; the desktop session keeps running |
| `/cancel` | close Telegram-side questions/approvals (they stay answerable in the web UI) |
| `/help` | help |

## How it works

1. The bot long-polls `getUpdates` and answers only users from the allowlist.
2. `/sessions` builds a catalog of workspaces and sessions and remembers it against
   your chat, so button callbacks stay consistent even if the list is refreshed.
3. Attaching resolves the session: a live agent is used as-is, a cold session is
   resumed through the host's `agents.resume`.
4. Messages are delivered through the host's session pipeline — the same one the
   web UI uses — so streaming, tool calls, questions and approvals reach the phone
   while they happen.
5. Bindings survive restarts: the chat → session map is persisted, and the plugin
   logs how many bindings it restored.

Nothing leaves the machine except the Telegram Bot API traffic.

## Implementation notes for DSH 0.2.x

The original 0.3.5 talked to a host service named `apiProxy`, which no longer
exists in DSH 0.2 — the menu silently degraded to "running sessions only". This
clone reads the same data the web UI reads, from host services:

- `workspaceRegistry.list()` — workspace ordering, titles, session ids;
  `workspaceRegistry.archivedSessionIds` — the archive set;
- `sessionController.list()` — every stored session with its projections
  (`title`, `titleInput`, `sessionListMetadata` for `blank`/`running`);
- `sessionController.projections({ sessionId })` — names for cold sessions.

The model list and model switching go through the same service
(`sessionController.modelCatalog()` and
`sessionController.selectModel({ sessionId, provider, model, reasoningEffort })`),
and `/new` uses `sessionController.create({ workspaceId | cwd })`.

The old `apiProxy` route is still attempted first, so the plugin also works on
0.1.x hosts. Session ids are normalised before the archive check, because the
host registry mixes both spellings.

Image sending is ported as well: on 0.2 the attachment goes through
`sessionController.prompt({ requestId, sessionId, mode: 'queue', content })` with
the same content parts the web UI sends. Projects and archiving use
`workspaceRegistry.create(path, title)` and
`workspaceRegistry.archiveSession(id, { stopActivity: true })`, so an archived
session is stopped rather than left burning tokens.

The package version is `0.4.0`. DSH checks compatibility against an **exact**
package version, so an exemption is required:

```bash
dsh plugin --profile web allow-version dsh-telegram-channel@0.4.0 \
  --dsh-version 0.2.1-alpha.2 --accept-risk
```

The exemption is stored per profile; bump the version and you must grant it again.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Bot never answers | no `token`, or `allowedUserIds` is empty / does not contain your numeric id |
| "long polling" errors, silence | `api.telegram.org` unreachable from the host — check proxy/VPN, not the plugin |
| Menu says only running sessions | host neither exposes `apiProxy` nor `sessionController` — check your DSH version |
| `duplicate loader entry id` | the profile patch used `insert` for an id the bundle already inserts; use an id-targeted row |
| `/model` unavailable | session not attached, or the host has neither `apiProxy` nor `sessionController.modelCatalog` |
| Old bot menu in a Telegram client | the client caches the command list; reopen the chat (or restart the app) |
| Plugin does not load after an upgrade | version exemption missing for the new exact version |

## Origin and license

Clone of [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
(MIT), base commit `7af6cef`. DSH runs the package through `main: lib/index.js`,
so `lib/` is the executed output and `src/` is the TypeScript source that has to
be kept in step with it. Upstream authorship is preserved in the git history; our
changes sit on top. See [UPSTREAM.md](UPSTREAM.md).

MIT — see [LICENSE](LICENSE). The original copyright notice is preserved.

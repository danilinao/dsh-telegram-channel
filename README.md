# dsh-telegram-channel-ru

> **Русский клон [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
> с доработками.** Взята база `0.3.5` (коммит `7af6cef`) и добавлено: полностью
> русский интерфейс, скрытие архивных сессий в меню выбора, наименование сессии на
> кнопке, чтение каталога через хост-сервисы DSH 0.2 (там, где оригинал ждал
> удалённый `apiProxy`), и русская карточка бота. Репозиторий:
> <https://github.com/danilinao/dsh-telegram-channel-ru>. Что именно изменено и как
> синхронизироваться с оригиналом — в [UPSTREAM.md](UPSTREAM.md).
>
> **Имя пакета и имя репозитория — `dsh-telegram-channel-ru`** (суффикс `-ru`
> отделяет русское ответвление от оригинала в общем пространстве имён; на npm
> пакет с 0.8.1). Плагин в профиле DSH тоже называется `dsh-telegram-channel-ru`.
> Старые адреса `danilinao/dsh-telegram-channel` продолжают работать — GitHub
> редиректит их на новое имя.

Telegram-пульт для **DeepSeek Harness**: телефон подключается к уже идущей сессии
на компьютере и продолжает её — **один диалог, две стороны**. Компьютер остаётся
источником истины: плагин не запускает второй агент и не дублирует контекст, а
работает с теми же сессиями, что открыты в Web. Плагин живёт внутри процесса
`dsh web` и подключается в профиль как `link:`.

## Что умеет

- **Настройки в Web-интерфейсе: вкладка «Telegram» в «Настройках».** Токен,
  список пользователей, доступ и формат сообщений — как у cost-meter и
  plugin-market, без перезапуска `dsh` и без ручной правки YAML. Та же форма
  открывается и с карточки плагина (**Plugins → dsh-telegram-channel-ru**).
  Несколько человек в белом списке, добавление по `@username` и по id.
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
  вариант?» или просит разрешение на инструмент, ответить можно из Telegram:
  варианты приходят **inline-кнопками**, есть «✏️ Свой ответ» для свободного
  текста и «✅ Готово» для мультивыбора; разрешение — кнопками
  «✅ Разрешить» / «⛔ Отклонить». Буквы (`A`, `B`) и обычный текст тоже
  принимаются; ответ из Web закрывает канал в TG.
- **Модель, контекст, сжатие.** `/model`, `/status`, `/compact`, `/mission`,
  `/stop`, `/new` — из телефона.
- **Проекты и сессии целиком с телефона.** В списке видны все рабочие области,
  включая пустые; в пустой области кнопка создаёт сессию. `/newproject <путь>` (или
  кнопка «➕ Новый проект») добавляет в реестр новую папку, `/new` создаёт диалог в
  текущей области, 🗄 у сессии или `/archive` убирают её в архив (работа
  останавливается, из меню и Web сессия исчезает).
- **Команды и рассуждения — целиком, но под спойлером.** Вызовы инструментов
  приходят с полными аргументами, а рассуждения модели — отдельным блоком
  «🧠 Рассуждения» перед каждым ответом. И то и другое свёрнуто в
  «раскрывающуюся цитату» Telegram (`<blockquote expandable>`) и разворачивается
  одним тапом; `/reasoning off` отключает рассуждения для конкретного чата
  (по умолчанию они включены).
- **История при открытии сессии.** При привязке сразу показываются последние
  сообщения диалога; кнопка «⬅ Раньше» листает глубже, `/history [seq]` — тоже
  вручную. В истории видны реплики пользователя, ответы ассистента и вызовы
  инструментов (спойлером).
- **Архив отдельно от списка.** В списке сессий области только неархивные; ниже
  кнопка «🗂 Архивные (N)» — она открывает архив **этой области** с кнопкой «↩»
  (вернуть) и «← К сессиям». Глобальный архив тоже доступен: `/archived`.
- **Осмысленные имена сессий.** Если у сессии нет заголовка и проекций, имя
  берётся из её журнала на диске — первое сообщение пользователя. Поэтому в
  списке видно «Проект: … Synthriders — Beatmap Studio…», а не один и тот же
  «Synthriders» на все одиннадцать строк; рядом дата и хвост id. Пустые сессии
  (в журнале нет ни одного сообщения) не показываются — внизу приписка
  «Скрыто пустых сессий: N».
- **Уведомления о состоянии сессии.** В чат приходит: успешное завершение хода,
  падение с текстом ошибки и подсказкой (кончились токены/квота, лимит запросов,
  модель недоступна, переполнен контекст, сеть, ключ), достижение лимита выходных
  токенов, аварийный обрыв, и вопрос агента («❓ Сессия задала вопрос и ждёт
  ответа») — с названием сессии **и проекта**. По умолчанию бот **следит за всеми сессиями**,
  включая запущенные с компьютера; `/notify bound` сужает до привязанной,
  `/notify on | errors | off` задаёт набор событий.

## Установка

Из npm — [`dsh-telegram-channel-ru`](https://www.npmjs.com/package/dsh-telegram-channel-ru):

```bash
dsh plugin --profile web add dsh-telegram-channel-ru
systemctl restart dsh           # плагин монтируется при старте
```

Из репозитория (разработка) — плагин подключается как `link:` и исполняется
прямо из папки проекта:

```bash
git clone https://github.com/danilinao/dsh-telegram-channel-ru
dsh plugin --profile web add link:$PWD/dsh-telegram-channel
systemctl restart dsh
```

В репозитории лежит уже собранный `lib/`, так что клон работает без сборки.
Если правите код — соберите заново (`src/` → `lib/`): см.
[BUILD.md](BUILD.md) (`npm install && npm run check`).

Конфигурация — строка `- id: dsh-telegram-channel-ru` в `~/.dsh/profiles/web/cordis.patch.yml`
(именно `id`-оверрайд, а не `insert`: id уже вставлен бандлом плагина):

```yaml
- id: dsh-telegram-channel-ru
  name: dsh-telegram-channel-ru
  config:
    token: "<токен от @BotFather>"
    allowedUserIds: [<ваш числовой id из @userinfobot>]
```

> **Переезд с 0.8.0 на 0.8.1.** Пакет переименован в `dsh-telegram-channel-ru`,
> и вместе с ним изменился `id` плагина в профиле: старая строка
> `- id: dsh-telegram-channel` больше не совпадает с именем пакета, а значит
> конфиг (токен и белый список) не применится. Порядок: добавить в
> `cordis.patch.yml` строку с новым `id` (и `name: dsh-telegram-channel-ru`) с тем
> же `config`, затем удалить старую строку и сделать
> `dsh plugin --profile web remove dsh-telegram-channel`; перезапуск — после этого.

| Ключ | Смысл |
|---|---|
| `token` / `DSH_TELEGRAM_TOKEN` | токен бота |
| `allowedUserIds` / `DSH_TELEGRAM_ALLOWED_USER_IDS` | белый список; пусто — бот не отвечает никому |
| `allowAllUsers` | `true` только для отладки |
| `maxMessageLength` | по умолчанию 4096 |
| `pollingTimeoutSec` | по умолчанию 30 |
| `rendering` | `html` (по умолчанию, любой клиент) или `rich` |
| `users` | список людей из GUI: `id`, подпись (`name`), `enabled`; главнее плоского списка |

## Настройки в Web-интерфейсе

Всё, что раньше правили руками в `cordis.patch.yml`, теперь есть в GUI —
**Настройки → Telegram** (вкладка рядом с «Расходами» и «Plugins»): форма
регистрируется в слот `settings.section` под id плагина, а заголовок вкладки
берётся из локали (`ru`/`en`) и следует за активным языком. Та же самая форма
по-прежнему открывается на карточке плагина (**Plugins →
dsh-telegram-channel-ru**): обе стороны — один компонент и один `configForms`-
скоуп, поэтому настройки не могут разойтись.

- **Токен бота** — поле «только для записи»: DSH не отдаёт секрет в браузер
  (`.role('secret')`), поэтому страница показывает лишь «сохранён» и строку
  статуса «Бот подключён: @имя». Пустое поле = «оставить как есть», кнопка
  «Проверить» заново спрашивает Telegram (`getMe`).
- **Пользователи** — несколько человек сразу: id, подпись, галочка «Отвечать».
  Добавление по числовому id или по `@username` (бот резолвит его через
  `getChat`), плюс чипсы «недавно писали боту» — один клик на того, кто уже
  постучался. Снятая галочка оставляет человека в списке, но бот не отвечает.
- **Доступ** — «Разрешить всем» (опасно, только для отладки).
- **Оформление** — `html` / `rich`.
- **Дополнительно** — максимальная длина сообщения и таймаут long-poll.

Сохранение — одна атомарная запись в профиль: страница отправляет только
изменённые поля, поэтому токен не переписывается заново при каждой правке.
**Перезапуск `dsh` не нужен:** плагин слушает `loader/volatile-update`,
останавливает старый мост и поднимает новый с новыми значениями; смещение
`getUpdates` при этом сохраняется, так что уже обработанные сообщения не
обрабатываются дважды.

То же самое в `cordis.patch.yml` (страница пишет именно это):

```yaml
- id: dsh-telegram-channel-ru
  name: dsh-telegram-channel-ru
  config:
    token: "<токен>"
    users:
      - id: 333041652
        name: Алексей
        enabled: true
      - id: 777000888
        enabled: false
    allowAllUsers: false
    rendering: html
```

`allowedUserIds` (плоский список из 0.8.x) продолжает работать — он читается,
пока `users` пуст. Первое сохранение из GUI пишет `users` и убирает
`allowedUserIds`, чтобы не осталось второго, невидимого белого списка.

> **Важно про несколько человек.** Бот не разделяет доступ к сессиям: каждый из
> списка видит все рабочие области и может привязаться к любой сессии — ровно
> так, как это делал единственный владелец. Если это не подходит, добавляйте
> людей точечно и держите `allowAllUsers` выключенным.

Страница берёт с хоста только несекретные сведения (`getMe`, имена из
`getChat`) через два маршрута под `/plugins/dsh-telegram-channel-ru/settings/`
(`info` и `resolve`); токен по ним не ходит. Нужен DSH 0.2.x: в 0.1.x у Plugins
нет форм, и раздел просто не появится.

## Команды

| Команда | Что делает |
|---|---|
| `/sessions` | рабочие области → сессии → привязка (архив и пустые скрыты) |
| `/last` | последний вопрос-ответ привязанной сессии |
| `/model` | сменить модель (действует со следующего хода) |
| `/status` | модель, глубина размышлений, контекст, TTFT, токены |
| `/compact` | сжать историю сессии (когда она свободна) |
| `/rich` | `on` — rich-рендер, `off` — HTML (для этого чата) |
| `/reasoning` | `on`/`off` — присылать рассуждения модели спойлером (по умолчанию `on`, запоминается для чата) |
| `/stop` | прервать текущий ход |
| `/mission` | список задач и прогресс |
| `/new` | новый диалог в текущей области и привязка |
| `/newproject <путь> [\| Название]` | добавить папку как проект (рабочую область) |
| `/archive` | убрать привязанную сессию в архив |
| `/archived` | список архива, кнопка «↩» возвращает сессию |
| `/history [seq]` | предыдущие сообщения сессии (листается «⬅ Раньше») |
| `/notify on\|errors\|off` | какие события присылать (всё / только ошибки / ничего) |
| `/notify every\|bound` | за какими сессиями следить (всеми / только привязанной) |
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

Начиная с `0.8.0` peer-зависимости `@deepseek-ai/dsh*` рассчитаны на рантайм
`0.2.1-alpha.2` (`^0.2.1-alpha.2`), поэтому исключение `allow-version` **не
нужно**. Если хост обновится до несовместимой версии, DSH откажется грузить
плагин — тогда либо правятся диапазоны, либо выдаётся исключение (см.
[BUILD.md](BUILD.md)).

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
- **Reasoning and tool calls, collapsed.** Each answer arrives after a
  «🧠 Рассуждения» blockquote holding the model's thinking, and every tool call
  arrives with its full arguments; both are Telegram expandable quotes
  (`<blockquote expandable>`) that open with one tap. `/reasoning off` silences
  the reasoning for one chat.
- **Two-way questions and approvals.** When the agent asks a multiple-choice
  question or requests permission for a tool, you can answer from Telegram:
  options arrive as **inline buttons**, alongside «✏️ Свой ответ» for free-form
  text and «✅ Готово» for multi-select; approvals get
  «✅ Разрешить» / «⛔ Отклонить» buttons. Letters (`A`, `B`) and plain text
  still work. An answer given in the web UI closes the Telegram channel.
- **Model, context and compaction from the phone.** `/model`, `/status`,
  `/compact`, `/mission`, `/stop`, `/new`.
- **Projects and sessions, fully managed from the phone.** The workspace list
  shows every registered project including empty ones; an empty project offers a
  "create session here" button. `/newproject <path> [ | Title]` (or the
  "➕ Новый проект" button) registers a new folder, `/new` creates a session in
  the current workspace, and 🗄 next to a session (or `/archive`) moves it to the
  archive — the session is stopped and disappears from both the menu and the web
  UI.
- **Commands and reasoning, in full but collapsed.** Tool calls arrive with
  their complete arguments and the model's reasoning as its own block; both are
  wrapped in a Telegram expandable quote (`<blockquote expandable>`), so they stay
  out of the way until tapped.
- **Conversation history on attach.** Binding a session immediately shows the last
  messages; the "⬅ Earlier" button pages further back, and `/history [seq]` does
  it manually. User prompts, assistant replies and tool calls (as spoilers) are
  all included.
- **Archive kept apart.** The session list shows only non-archived sessions; a
  "🗂 Архивные (N)" button opens the archive of **that workspace** with "↩"
  (restore) and "← К сессиям" (back). The global archive is `/archived`.
- **Meaningful session names.** When a session has neither title nor projections,
  the name is read from its session log on disk (the first user message), so the
  list reads "Проект: … Synthriders — Beatmap Studio…" instead of the same
  project name on every row; the date and id tail follow.
- **Session state notifications.** The chat receives a ✅ when a turn completes,
  a ⚠️ with the error text plus a hint when it fails (quota/tokens exhausted,
  rate limit, model unavailable, context overflow, network, credentials), a
  warning for the output-token ceiling and for crash-orphaned turns, and
  "❓ the session asked a question and is waiting" — each with the session name
  and its project.
  By default the bot **follows every session**, including turns started on the
  desktop; `/notify bound` narrows it to the attached session, and
  `/notify on | errors | off` picks the event set.

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
git clone https://github.com/danilinao/dsh-telegram-channel-ru /path/to/dsh-telegram-channel
dsh plugin --profile web add link:/path/to/dsh-telegram-channel
systemctl restart dsh        # the plugin is mounted at startup only
```

Or install the published package instead of the checkout:
`dsh plugin --profile web add dsh-telegram-channel-ru`.

The repository ships a built `lib/`, so a clone runs as-is. If you edit `src/`,
rebuild it (`npm install && npm run check`) — DSH executes `lib/index.js`, never
the TypeScript sources. See [BUILD.md](BUILD.md).

### Configuration

Put an **id-targeted override** in `~/.dsh/profiles/web/cordis.patch.yml` (the
row id is already inserted by the plugin bundle, so re-`insert` would create a
duplicate and the loader would reject it):

```yaml
- id: dsh-telegram-channel-ru
  name: dsh-telegram-channel-ru
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
| `users` | — | list of people edited in the GUI: `id`, optional `name`, `enabled`; wins over the flat list |

`name` is required on an id-targeted row: without it the plugin manager cannot map
the row back to its loader entry and the settings form becomes read-only.

### Settings in the Web UI

Open **Plugins → dsh-telegram-channel-ru** in the sidebar: the plugin card carries
the same settings as a page, so no YAML editing and no `systemctl restart dsh`.

- **Bot token** — write-only. DSH strips `.role('secret')` fields from the settings
  document, so the page only shows "saved" plus a live status line ("Connected as
  @bot"); leaving the field empty keeps the current token. **Check** asks Telegram
  again (`getMe`).
- **Users** — several people with an id, an optional label and an "Answers" toggle.
  Add by numeric id or by `@username` (resolved server-side through `getChat`), or
  click one of the "recently wrote to the bot" chips. A muted user stays listed but
  is refused by the bot.
- **Access** — "Allow everyone" (dangerous, debugging only).
- **Appearance** — `html` / `rich`.
- **Advanced** — maximum message length and the long-poll timeout.

Saving is one atomic profile write that restates only the changed fields, so the
token is not rewritten on every edit. The plugin listens for
`loader/volatile-update`, stops the old bridge and starts a new one with the new
values — carrying the `getUpdates` offset over, so nothing is answered twice.

The page reads only non-secret facts from the host (`getMe`, names from `getChat`)
through two routes under `/plugins/dsh-telegram-channel-ru/settings/` (`info`,
`resolve`); the token never travels through them. This needs DSH 0.2.x — 0.1.x has
no settings forms, and the section simply does not appear.

**Everyone in the list shares the sessions.** The bot does not separate access
between users: each allowlisted person sees every workspace and may attach to any
session, exactly as the single owner could. Add people deliberately and keep
`allowAllUsers` off.

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
| `/reasoning` | `on`/`off` — mirror the model's reasoning as a spoiler (default `on`, per chat) |
| `/stop` | abort the current turn |
| `/mission` | todo list and progress |
| `/new` | create a new session in the current workspace and attach to it |
| `/newproject <path> [\| Title]` | register a folder as a project (workspace) |
| `/archive` | move the attached session to the archive |
| `/archived` | archived sessions, "↩" restores one |
| `/history [seq]` | earlier messages of the session ("⬅ Earlier" pages back) |
| `/notify on\|errors\|off` | which events this chat receives (all / errors only / none) |
| `/notify every\|bound` | which sessions to follow (all / attached only) |
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

Since `0.8.0` the `@deepseek-ai/dsh*` peer ranges target the current runtime
(`^0.2.1-alpha.2`), so **no `allow-version` exemption is needed**. If the host
moves to an incompatible version, DSH refuses to load the plugin — either widen
the ranges or grant the exemption:

```bash
dsh plugin --profile web allow-version dsh-telegram-channel-ru@<version> \
  --dsh-version <dsh version> --accept-risk
```

Exemptions are stored per profile in `~/.dsh/profiles/web/compatibility.json`.

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

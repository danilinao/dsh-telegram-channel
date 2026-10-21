# dsh-telegram-channel

Telegram-пульт для **DeepSeek Harness**: телефон подключается к уже идущей сессии
на компьютере и продолжает её — **один диалог, две стороны**. Компьютер остаётся
источником истины: плагин не запускает второй агент и не дублирует контекст, а
работает с теми же сессиями, что открыты в Web.

Плагин живёт внутри процесса `dsh web` (`link:`-подключение к профилю),
самостоятельный репозиторий: <https://github.com/danilinao/dsh-telegram-channel>.

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
| `/unbind` | отвязать телефон (сессия на компьютере остаётся) |
| `/cancel` | закрыть ответы/подтверждения в Telegram |
| `/help` | помощь |

## Совместимость

Плагин работает с **DSH 0.2.x**: каталог сессий читается напрямую из хост-сервисов
(`sessionController.list`, `workspaceRegistry`), потому что сервис `apiProxy`, на
который опирались версии 0.1.x, в 0.2 удалён. Для старых хостов остаётся путь
через `apiProxy` — он используется, если доступен.

Версия `0.4.0`. Проверка совместимости DSH привязана к точной версии пакета,
поэтому для неё выдано исключение — см. [UPSTREAM.md](UPSTREAM.md).


## Происхождение, лицензия, участие

Проект — самостоятельное ответвление от
[hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
(MIT, база — коммит `7af6cef`). История коммитов сохранена: в ней видны авторы
оригинала, а сверху — наши изменения. Как синхронизироваться с оригиналом и как
публиковать — в [UPSTREAM.md](UPSTREAM.md).

Лицензия — MIT ([LICENSE](LICENSE)); уведомление об авторских правах оригинала
сохранено.

---

## English

A Telegram remote for **DeepSeek Harness**: attach a live web session from your
phone and keep working in the same conversation. Independent derivative of
[hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
(MIT), with a Russian UI, an archive-aware session picker (archived sessions are
hidden) and session names on the picker buttons.

```bash
dsh plugin --profile web add link:/path/to/dsh-telegram-channel
systemctl restart dsh
```

Config lives under `- id: dsh-telegram-channel` in
`~/.dsh/profiles/web/cordis.patch.yml` (`token`, `allowedUserIds`);
`allowedUserIds` is a hard gate — an empty list means the bot answers nobody.

# Заметки по проекту tg-bot-dsh

Проект для разработки Telegram-бота DeepSeek Harness — ответвления
`dsh-telegram-channel`.

- Код плагина: `/home/alexey/projects/tg-bot-dsh` (эта папка, git-репозиторий)
- Публикация: <https://github.com/danilinao/dsh-telegram-channel-ru>
- Подключение в DSH: профиль `web`, зависимость
  `github:danilinao/dsh-telegram-channel-ru` (онлайн-установка с GitHub),
  строка `- id: dsh-telegram-channel` в `~/.dsh/profiles/web/cordis.patch.yml`

Память по проекту (архитектура, грабли, решения):
`/home/alexey/agent-memory/projects/tg-bot-dsh/` — `MEMORY.md`, `state.md`,
`NOW.md`.

## Переезд 2026-10-21

Раньше код лежал в `/home/alexey/dsh-plugins/dsh-telegram-channel`. Папка
перенесена в проект целиком (вместе с `.git`, `lib/`, `tests/`,
`node_modules/`), а на старом месте остался симлинк:

```bash
/home/alexey/dsh-plugins/dsh-telegram-channel -> /home/alexey/projects/tg-bot-dsh
```

Симлинк нужен, чтобы не править профиль DSH: в
`~/.dsh/profiles/web/package.json` зависимость записана как
`link:/home/alexey/dsh-plugins/dsh-telegram-channel`, и Node/pnpm разрешают её
через симлинк на новую папку. Проверено после переноса:

```bash
readlink -f ~/.dsh/profiles/web/node_modules/dsh-telegram-channel
# → /home/alexey/projects/tg-bot-dsh
```

Если когда-нибудь понадобится убрать симлинк — сначала переписать `link:` в
`package.json` профиля на `/home/alexey/projects/tg-bot-dsh` и переустановить
(`pnpm install` в `~/.dsh/profiles/web`), иначе плагин не смонтируется и Web
останется без пульта.

## Онлайн-установка (2026-10-21, вечер)

Плагин переведён с `link:` на установку **с GitHub**:

```bash
dsh plugin --profile web remove dsh-telegram-channel
dsh plugin --profile web add github:danilinao/dsh-telegram-channel-ru
```

pnpm сам заменил `link:` на `github:` (одна команда `add` достаточно), в профиле
теперь `"dsh-telegram-channel": "github:danilinao/dsh-telegram-channel-ru"`,
установленная копия — `0.8.0` из `main` (вместе с собранным `lib/`).
Строка конфига с токеном в `cordis.patch.yml` не тронута: id-оверрайд живёт
отдельно от источника пакета.

Что это меняет:

- правки в этой папке больше **не** попадают в бота автоматически — установлена
  копия из git. Для разработки вернуть `link:`:
  `dsh plugin --profile web add link:/home/alexey/projects/tg-bot-dsh`
  (старый симлинк `/home/alexey/dsh-plugins/dsh-telegram-channel` для этого
  больше не нужен, но оставлен);
- обновление: `dsh plugin --profile web add github:danilinao/dsh-telegram-channel-ru`
  после пуша (или пин на тег/коммит: `github:danilinao/dsh-telegram-channel-ru#v0.9.0`);
- после любой смены зависимости нужен рестарт `dsh` — плагин монтируется при
  старте.

## Витрина (plugin-market)

Каталог, который показывает `dshmarket`, — это список
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
(6254 записи, `https://awesome-dsh-plugin.com/plugins.json`). Своя запись
добавляется одним YAML-файлом в `data/plugins/<owner>__<repo>.yml` через PR;
заготовка лежит в `docs/market/danilinao__dsh-telegram-channel.yml`.

Требования каталога (из `contributing.md`):

- в `package.json` объявлен `dsh.bundle` — у нас есть (`cordis.patch.yml`);
- репозиторий старше 1 дня, с реальным кодом и активной поддержкой;
- на репозитории стоит GitHub-topic `dsh-plugin`;
- категория из списка — у нас `remote`;
- описание — одна строка по делу, без маркетинга.

PR-у нужен доступ к чужому репозиторию (форк/PR): fine-grained токен, лежащий в
`~/.dsh/.credentials.yaml` (`refs.GITHUB_TOKEN`), выдан только на
`danilinao/dsh-telegram-channel-ru` — ни форк, ни topics, ни PR он не открывает
(проверено: `403 Resource not accessible by personal access token`). Нужен токен
с `public_repo` (классический) либо ручной PR.

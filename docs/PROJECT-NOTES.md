# Заметки по проекту tg-bot-dsh

Проект для разработки Telegram-бота DeepSeek Harness — ответвления
`dsh-telegram-channel`.

- Код плагина: `/home/alexey/projects/tg-bot-dsh` (эта папка, git-репозиторий)
- Публикация: <https://github.com/danilinao/dsh-telegram-channel>
- Подключение в DSH: профиль `web`, зависимость
  `link:/home/alexey/dsh-plugins/dsh-telegram-channel`, строка
  `- id: dsh-telegram-channel` в `~/.dsh/profiles/web/cordis.patch.yml`

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

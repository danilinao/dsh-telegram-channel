# tg-bot-dsh — правила работы агента

Telegram-пульт для DeepSeek Harness: плагин `dsh-telegram-channel` (русское
ответвление `hi-wenw/dsh-telegram-channel`). Плагин живёт **внутри процесса
`dsh web`** и грузится как `link:`-зависимость профиля `web` из этой папки.

## Сначала — память

1. `/home/alexey/agent-memory/projects/tg-bot-dsh/MEMORY.md` — архитектура,
   грабли, решения (читать первым делом);
2. `state.md` — где мы сейчас;
3. `NOW.md` — последние компакты (пишется автоматически).

## Жёсткие правила

- **DSH исполняет `lib/`, а не `src/`.** Правка в `src/*.ts` без такой же
  правки в `lib/*.js` до бота не доедет. Дублировать вручную, затем
  `for f in lib/*.js; do node --check "$f"; done`.
- **В `lib/` не должно оставаться китайских литералов** (наследие upstream).
  Русские строки — в `src/commands.ts`, дублируются в `lib/commands.js`.
- **Плагин монтируется только при старте `dsh`.** Рестарт — через
  `/home/alexey/dsh-tg-reload.sh` (root), поставленный таймером, чтобы не
  оборвать текущий ход:
  `sudo systemd-run --on-active=45 --unit=dsh-tg-reload-$(date +%H%M%S) /home/alexey/dsh-tg-reload.sh`.
  Скрипт сам откатывает плагин из профиля, если Web не поднялся за ~2 минуты;
  лог — `/var/log/dsh-tg-reload.log`. Итог: `OK - telegram channel plugin mounted, no rollback`.
- **Секреты** (токен бота, `GITHUB_TOKEN`) живут только в
  `~/.dsh/profiles/web/cordis.patch.yml` и `~/.dsh/.credentials.yaml`.
  В репозиторий, README и память их не писать.
- **Версия пакета:** DSH сверяет точную версию, поэтому после смены `version`
  в `package.json` нужно исключение:
  `dsh plugin --profile web allow-version dsh-telegram-channel@<версия> --dsh-version 0.2.1-alpha.2 --accept-risk`.
  Накопленные исключения — `~/.dsh/profiles/web/compatibility.json`.
- **Конфиг-строка в профиле — id-оверрайд** (`- id: dsh-telegram-channel`),
  не `insert`: иначе `duplicate loader entry id`.

## Проверки

```bash
node --test tests/                          # сейчас 22/28 (см. MEMORY.md, почему 6 падают)
for f in lib/*.js; do node --check "$f"; done
```

Смоук в Telegram: `/status`, `/sessions`, сообщение в привязанную сессию.

## Публикация

```bash
./PUBLISH.sh            # push main + теги, токен через GIT_ASKPASS
./PUBLISH.sh --dry-run
```

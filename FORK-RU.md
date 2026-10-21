# Форк: русская локализация `dsh-telegram-channel`

Локальный форк плагина **Telegram-пульта для DeepSeek Harness**:
[github.com/hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel)
(upstream-коммит `7af6cef`, версия `0.3.5`).

Живёт на этом хосте: `/home/alexey/dsh-plugins/dsh-telegram-channel`, подключён в
профиль `web` как `link:` — правки применяются после перезапуска `dsh`, без
пересборки из npm.

```bash
git remote -v          # upstream → github:hi-wenw/dsh-telegram-channel
git log --oneline      # верхний коммит — русская локализация
```

## Что изменено относительно upstream

1. **Русский интерфейс.** Переведены все пользовательские строки: `/start`,
   `/help`, описания команд в меню Telegram (`setMyCommands`), `/status`,
   `/compact`, `/model`, `/rich`, пикеры рабочих областей и сессий, уведомления
   (очередь, ошибки хода, прогресс todo, подтверждения инструментов), ошибки
   вида «Не удалось привязать / Подробности: …».
2. **Архивные сессии скрыты из меню выбора.** Сравнение id терпит оба написания
   (`session-<uuid>` и `<uuid>` — в реестре хоста встречаются оба), учитываются
   проекционные флаги `archived` / `archivedAt` и `archivedSessionIds` из
   `sessions.list`. Рабочие области, где не осталось ни одной живой сессии, из
   списка тоже исчезают.
3. **На кнопке — наименование сессии.** Кнопка = `N. <наименование> ▶/▷`
   (▶ — сессия в памяти, ▷ — спит, поднимется при привязке). Наименование:
   проекция `title` → `titleInput.first.text` (первое сообщение) →
   `рабочая область · дата`. Для холодных сессий, у которых нет проекционного
   блока в `sessions.list`, имя дотягивается через `sessions.projections`
   (кэш по `updatedAt`, чтобы не дёргать хост на каждый рендер).

Логика — в `src/catalog.ts` (`normalizeSessionId`, `isArchived`,
`resolveSessionTitle`, `titleOf`) и `src/bridge.ts` (`sessionButtonText`,
`ensureSessionNames`).

## Важно: `lib/` — это то, что реально исполняется

DSH грузит пакет через `main: lib/index.js`, поэтому **правки вносятся
параллельно в `src/*.ts` и `lib/*.js`**. На этом хосте нет toolchain для сборки:

- `pnpm add -D typescript` падает — peer-зависимости плагина тянут
  `@deepseek-ai/dsh-type-meta`, которого нет в npm (404);
- `npm install` отваливается по таймауту сети.

Поэтому `tsc` не запускался. Вместо него — проверки, доступные без сборки:

```bash
# синтаксис TypeScript (Node 26 умеет strip-types): ошибка разбора видна сразу,
# ERR_MODULE_NOT_FOUND ожидаем — это резолв peer-пакетов вне рантайма DSH
node --experimental-strip-types -e "import('file://$PWD/src/bridge.ts')"

# синтаксис собранного JS
for f in lib/*.js; do node --check "$f"; done

# паритет строк: все русские литералы из src должны быть и в lib
```

Когда toolchain появится (другая машина/контейнер с доступным npm):
`pnpm add -D typescript @types/node && pnpm build` перезапишет `lib/` из `src/`
— тогда ручное дублирование можно прекратить.

## Установка / переустановка

```bash
dsh plugin --profile web add link:/home/alexey/dsh-plugins/dsh-telegram-channel
systemctl restart dsh        # плагин монтируется только при старте
```

Версия пакета **намеренно оставлена `0.3.5`**: проверка совместимости DSH
(`allow-version`) привязана к точной версии, и для `0.3.5` исключение уже выдано:

```bash
dsh plugin --profile web allow-version dsh-telegram-channel@0.3.5 \
  --dsh-version 0.2.1-alpha.2 --accept-risk
```

Если версию поднять, исключение нужно выдавать заново.

Конфигурация (токен, белый список) — в
`~/.dsh/profiles/web/cordis.patch.yml`, строка `- id: dsh-telegram-channel`
(не `insert`: id уже вставлен бандлом плагина).

## Обновление из upstream

```bash
git fetch upstream
git rebase upstream/main          # русский коммит ляжет поверх
# перевести новые строки (git grep -n '[一-龥]' src/), продублировать в lib/
git commit --amend
```

После ребейза обязательно пере-проверить `lib/` на паритет и на остатки
китайских строк:

```bash
grep -rnP '[\x{4e00}-\x{9fff}]' lib/*.js | grep -v '^\S*: *\*'   # должно быть пусто
```

## Требование к сети

`api.telegram.org` на этом хосте доступен только через тоннель AmneziaWG:
Telegram DC (`149.154.160.0/20`, `91.108.4.0/22`) маршрутизируются через `awg0`
(`sudo tunnel-route add …`, записи в `/etc/tunnel-route/extras.txt`).
Без тоннеля long-poll молча таймаутит.

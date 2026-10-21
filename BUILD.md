# Сборка, проверки, публикация

Проект самодостаточен: после `npm install` собирается, проверяется и пакуется
без внешней машины и без ручного дублирования кода.

## Что где

| Путь | Роль |
|---|---|
| `src/*.ts` | **источник истины**, правим только здесь |
| `lib/*.js`, `lib/*.d.ts` | результат `npm run build` (tsc); DSH грузит `main: lib/index.js` |
| `tests/` | `node:test` по исходникам (`src/`), плюс `tests/lib/` — проверка свежести сборки |
| `tsconfig.json` | `target ES2022`, `module NodeNext`, `strict`, `rootDir src`, `outDir lib` |

`lib/` коммитится в git намеренно: DSH подключает плагин как `link:`-зависимость
и исполняет файлы из репозитория, поэтому клон без сборки тоже должен работать.
Правило простое: **поменял `src/` — пересобери `lib/` тем же коммитом.**

## Требования

- Node.js ≥ 22 (в репозитории проверено на 26.x: тесты идут через `tsx`).
- npm (или pnpm) для установки dev-зависимостей.
- Сеть до `registry.npmjs.org` — только на `npm install`.

## Установка зависимостей

```bash
npm install          # ставит tsc, tsx, @types/node и peer-пакеты DSH для типов
```

`@deepseek-ai/dsh-*` стоят и в `peerDependencies` (их даёт рантайм DSH), и в
`devDependencies` — точными версиями, с которыми работает хост
(`0.2.1-alpha.2`). Так `tsc` проверяет код против настоящих типов, а не против
заглушек.

## Сборка

```bash
npm run build        # tsc: src/ → lib/ (js + .d.ts)
npm run clean        # удалить lib/ (перед чистым релизом)
npm run typecheck    # только проверка типов, без записи файлов
```

## Проверки

```bash
npm test             # 62 теста по src/ (tsx + node:test)
npm run test:lib     # 2 теста: lib/ собран из текущего src/ (паритет и тексты)
npm run check        # typecheck → build → test → test:lib (то, что гоняем перед коммитом)
```

Тесты не требуют ни бота, ни сети: Telegram-клиент замокан, а каталог
изолирован через `DSH_HOME` (иначе в тесты протекают реальные сессии хоста) и
`DSH_TELEGRAM_BINDINGS_FILE`.

## Пакет

```bash
npm pack             # собрать tarball, проверить состав без публикации
npm pack --dry-run   # только список файлов
```

В пакет попадают `lib/`, `src/`, `scripts/`, `cordis.patch.yml`, `README.md`,
`UPSTREAM.md`, `BUILD.md`, `LICENSE` (поле `files`). `prepublishOnly` делает
`clean → build → test → test:lib`, поэтому опубликовать несобранный пакет
нельзя.

## Установка плагина в DSH

Из репозитория (разработка):

```bash
dsh plugin --profile web add link:/home/alexey/projects/tg-bot-dsh
systemctl restart dsh          # плагин монтируется только при старте
```

Из npm (когда пакет опубликован):

```bash
dsh plugin --profile web add dsh-telegram-channel
```

Конфиг — id-оверрайд в `~/.dsh/profiles/web/cordis.patch.yml` (токен, белый
список); подробности в `README.md`.

## Версия и совместимость

DSH сверяет peer-зависимости `@deepseek-ai/dsh*` с версией рантайма. С 0.8.0
диапазоны рассчитаны на текущий хост (`^0.2.1-alpha.2`), поэтому **исключение
`allow-version` не нужно**. Если хост обновится до несовместимой версии, DSH
откажется грузить плагин — тогда либо правим диапазоны, либо выдаём исключение:

```bash
dsh plugin --profile web allow-version dsh-telegram-channel@<версия> \
  --dsh-version <версия dsh> --accept-risk
```

Исключения копятся в `~/.dsh/profiles/web/compatibility.json`.

## Публикация

```bash
npm version minor --no-git-tag-version   # или major/patch — поднимает версию
npm run check                            # всё зелёное
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z && git push origin main --tags
./PUBLISH.sh                             # то же самое, но с токеном из хранилища DSH
```

Релиз (GitHub) делается на каждое **крупное** изменение: заголовок — версия,
описание — из `CHANGELOG.md`. Мелкие правки едут обычными коммитами.

## English (short)

`src/` is the source of truth; `lib/` is its build output and is committed
because DSH runs the package from the checkout. `npm install && npm run check`
(or `npm run build`) is the whole toolchain; `npm run test:lib` fails when
`lib/` is stale. Publishing runs `clean → build → test → test:lib` via
`prepublishOnly`.

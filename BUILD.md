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

Из npm:

```bash
dsh plugin --profile web add dsh-telegram-channel-ru
```

Конфиг — id-оверрайд в `~/.dsh/profiles/web/cordis.patch.yml` (токен, белый
список); подробности в `README.md`. `id` строки равен имени пакета, поэтому при
переименовании пакета меняется и `id` — старую строку с конфигом нужно перенести
(см. раздел про переезд в `README.md`).

## Версия и совместимость

DSH сверяет peer-зависимости `@deepseek-ai/dsh*` с версией рантайма. С 0.8.0
диапазоны рассчитаны на текущий хост (`^0.2.1-alpha.2`), поэтому **исключение
`allow-version` не нужно**. Если хост обновится до несовместимой версии, DSH
откажется грузить плагин — тогда либо правим диапазоны, либо выдаём исключение:

```bash
dsh plugin --profile web allow-version dsh-telegram-channel-ru@<версия> \
  --dsh-version <версия dsh> --accept-risk
```

Исключения копятся в `~/.dsh/profiles/web/compatibility.json`.

## Публикация

```bash
npm version minor --no-git-tag-version   # или major/patch — поднимает версию
npm run check                            # всё зелёное
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z
./PUBLISH.sh                             # GitHub: push main + теги (токен из хранилища DSH)
```
Толчок тега `vX.Y.Z` запускает GitHub Actions и **публикацию в npm** (см. ниже).

Релиз (GitHub) делается на каждое **крупное** изменение: заголовок — версия,
описание — из `CHANGELOG.md`. Мелкие правки едут обычными коммитами.

### npm: публикация из GitHub Actions (основной путь)

Пакет — `dsh-telegram-channel-ru` (владелец `lex1133`). Публикует workflow
[`.github/workflows/publish.yml`](.github/workflows/publish.yml) через **Trusted
Publishing** (OIDC): в `package.json` нет токенов, в настройках репозитория нет
секретов — npm выдаёт короткоживущий токен за доверие к конкретному workflow
этого репозитория (`npm trust github`, он же Trusted Publisher на сайте).
Provenance (`--provenance`) прикрепляется автоматически, и версия на npm
получает провенанс-аттестацию: видно, из какого коммита и какого workflow она
собрана.

```bash
git tag v0.9.0 && git push origin v0.9.0   # → Actions: npm ci, npm run check, npm publish
```

Первый прогон — `v0.8.2` (2026-10-22), `conclusion: success`, в логе
`publish Signed provenance statement with source and build information from
GitHub Actions`; версия стала публичной примерно через полторы минуты
(`Your package is being processed and may take a few minutes to become
available` — это нормально, повторно публиковать не надо).

Доверие привязано к паре «репозиторий + файл workflow» —
`danilinao/dsh-telegram-channel-ru` + `publish.yml`. **Переименование репозитория
или файла workflow ломает публикацию:** OIDC-claims перестают совпадать с
настроенным доверием. Тогда `npm trust revoke` + повторный `npm trust github`
(или правка на странице пакета). То же — при переносе пакета в организацию.

Workflow идемпотентен: если версия из `package.json` уже есть в реестре, шаг
публикации пропускается, а при расхождении тега и версии сборка падает.

Состояние доверия (нужна 2FA-сессия; granular-токену с bypass 2FA оба запроса
отвечают 403, поэтому `trust list` из скрипта часто не читается):

```bash
npm trust list dsh-telegram-channel-ru       # что настроено
npm trust revoke dsh-telegram-channel-ru --id=<id>
```

Ещё одна грабля токена: **пуш изменений в `.github/workflows/*` требует scope
`workflow`** (fine-grained: `Workflows: Read and write`, classic: `workflow`).
Без него `git push` отвечает `refusing to allow a Personal Access Token to create
or update workflow .github/workflows/publish.yml without workflow scope` — сам
файл при этом уже в коммите, достаточно расширить scope и повторить `./PUBLISH.sh`.

Правка доверия требует 2FA и сессии npm (granular-токен с bypass 2FA для
`npm trust` не годится) — это делает владелец аккаунта на
<https://www.npmjs.com/package/dsh-telegram-channel-ru/access>.

### npm: локальная публикация (запасной путь)

```bash
./PUBLISH-npm.sh            # npm publish, токен NPM_TOKEN из хранилища DSH
./PUBLISH-npm.sh --dry-run  # только состав пакета
```

Скрипт берёт токен из `~/.dsh/.credentials.yaml`, кладёт его во временный
`npmrc` (0600, удаляется по выходу) и вызывает `npm publish`; в `~/.npmrc`,
`.git/config` и историю shell токен не попадает. Локальная публикация идёт **без
provenance** — это нормально для запасного пути, но основная дорога — CI.

Что стоит знать, если публикация ведёт себя странно:

- **У аккаунта включено staged publishing + 2FA.** Ручной `npm publish` может
  не упасть, а создать в реестре версию-заглушку `0.0.0-stage` («Temporary
  Holding Version») и держать настоящую версию до подтверждения 2FA.
  `npm stage list` при этом может показывать пусто — надёжнее смотреть
  авторизованный packument:
  `curl -H "Authorization: Bearer $NPM_TOKEN" https://registry.npmjs.org/dsh-telegram-channel-ru`
  — в нём видно и заглушку, и ожидающую версию (`dist-tags.latest`).
- **Повторная отправка той же версии.** `npm publish` уже существующую версию не
  отправит: `You cannot publish over the previously published versions: X.Y.Z` —
  это значит, что версия уже принята, и надо просто проверить реестр.
- **Заглушка `0.0.0-stage`** остаётся в списке версий, если версия ушла вторым
  заходом. Удалить её может только владелец на сайте npm (или токен с правом
  bypass 2FA): `npm unpublish` из-под granular-токена отвечает
  `403 Granular access tokens that bypass two-factor authentication may not
  perform this action`. На установку она не влияет — `dist-tags.latest`
  указывает на настоящую версию.

Проверка после публикации:

```bash
curl -s https://registry.npmjs.org/dsh-telegram-channel-ru | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(d['dist-tags'],list(d['versions']))"
cd /tmp && npm i dsh-telegram-channel-ru@<версия> && node -p \
  "require('/tmp/node_modules/dsh-telegram-channel-ru/package.json').version"
```

## English (short)

`src/` is the source of truth; `lib/` is its build output and is committed
because DSH runs the package from the checkout. `npm install && npm run check`
(or `npm run build`) is the whole toolchain; `npm run test:lib` fails when
`lib/` is stale. Publishing runs `clean → build → test → test:lib` via
`prepublishOnly`. Releases are published to npm from GitHub Actions on a `v*` tag
using npm Trusted Publishing (OIDC, no tokens in the repo).

/**
 * dsh-telegram-channel-ru — browser half (DSH web client).
 *
 * The host half declares every Config field `.volatile()` (the token as a
 * `secret`), so DSH 0.2 serves a settings document for the entry and accepts
 * live edits. A form for it exists only if a browser half registers one of the
 * Plugins page's configuration slots; this file registers the **bundle's** one,
 * `plugins.bundle.config` keyed by the package name, so the whole settings page
 * (token, users, access, extras) sits on the plugin's card, one click from the
 * Plugins list.
 *
 * Data flow:
 *   - the form values and the atomic write queue come from `ctx.configForms`
 *     (`get(entryId)`), i.e. exactly the service the host's own settings pages
 *     bind, and a save is one `mutate(ops)` — a batch that the host applies
 *     live (the plugin rebuilds its bridge on `loader/volatile-update`, so a new
 *     token starts polling immediately, without restarting dsh);
 *   - the few facts that are not configuration (who the token belongs to, the
 *     Telegram name behind an id, who has written to the bot) come from the
 *     host routes the plugin registers under `/plugins/<package>/settings/*`.
 *     Those are advisory only: the form works when they are unavailable.
 *
 * The token is write-only end to end: DSH strips `role('secret')` fields from
 * the settings document, so this code never receives it, only a "saved" flag
 * from the info route.
 *
 * Conventions this file must keep (dsh-client-modules):
 *   - loaded as a classic script through `window.__ModuleLoader__.load()`;
 *   - `id` equals the package name, and the module table seeds React;
 *   - only platform-seed specifiers are required (react), so the bundle has no
 *     `dsh.client.external` requests and no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-telegram-channel-ru',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace this browser half owns. */
    const LOCALE_NS = 'telegramChannelRu'
    /** Loader entry id of the plugin row — the settings namespace of the form. */
    const ENTRY_ID = 'dsh-telegram-channel-ru'
    /** Host routes registered by `src/settings-api.ts`. */
    const INFO_URL = '/plugins/dsh-telegram-channel-ru/settings/info'
    const RESOLVE_URL = '/plugins/dsh-telegram-channel-ru/settings/resolve'

    const ru = {
      token: 'Токен бота',
      tokenSet: 'сохранён',
      tokenMissing: 'не задан',
      tokenPlaceholder: 'Вставьте токен из @BotFather, чтобы задать или заменить',
      tokenHint:
        'Токен хранится в профиле DSH и в браузер не передаётся. Пустое поле оставляет текущий токен без изменений.',
      statusConnected: 'Бот подключён: @{username}',
      statusConnectedNoName: 'Бот подключён (id {id})',
      statusNotRunning: 'Токен принят, но опрос не запущен — проверьте строку плагина в профиле.',
      statusInvalid: 'Telegram не принял токен: {error}',
      statusNoToken: 'Токен не задан — бот не отвечает.',
      statusNoInfo: 'Сведения о боте недоступны (маршрут плагина не отвечает).',
      statusLoading: 'Проверяю токен…',
      check: 'Проверить',
      users: 'Пользователи',
      usersHint:
        'Кому бот отвечает. Каждый человек видит те же сессии, что и остальные: бот не разделяет доступ между пользователями.',
      emptyUsers: 'Пока никого. Добавьте свой Telegram ID — тогда бот начнёт отвечать вам.',
      add: 'Добавить',
      addPlaceholder: 'ID или @username',
      addNamePlaceholder: 'Подпись (необязательно)',
      adding: 'Ищу…',
      addError: 'Не удалось добавить: {error}',
      already: 'Этот пользователь уже в списке.',
      needId: 'Укажите числовой ID или @username.',
      enabledOn: 'Отвечать',
      enabledOff: 'Не отвечать',
      remove: 'Удалить',
      unknownName: 'Пользователь {id}',
      noNameYet: 'имя появится, когда человек напишет боту',
      recent: 'Недавно писали боту:',
      bound: 'привязан',
      access: 'Доступ',
      allowAll: 'Разрешить всем',
      allowAllHint:
        'Опасно: любой, кто найдёт бота, получит доступ к вашим сессиям. Оставьте выключенным, если не уверены.',
      appearance: 'Оформление',
      rendering: 'Формат сообщений',
      renderingHtml: 'HTML — работает в любом клиенте Telegram',
      renderingRich: 'Rich — нативные Rich Messages (нужен свежий клиент)',
      renderingHint: 'Отдельный чат может переопределить это командой /rich on|off.',
      advanced: 'Дополнительно',
      maxLength: 'Максимальная длина сообщения',
      maxLengthHint: 'Telegram принимает не больше 4096 символов; длинные ответы режутся на части.',
      pollingTimeout: 'Таймаут long-poll, секунды',
      pollingHint: '0 — обычный опрос без ожидания. Большие значения экономят запросы, но замедляют остановку.',
      save: 'Сохранить',
      saving: 'Сохраняю…',
      saved: 'Сохранено. Новые настройки уже применяются.',
      failed: 'Профиль не принял изменения — сохранённые значения остались прежними.',
      reset: 'Отменить правки',
      readOnly: 'Эта страница не может сохранять настройки (профиль только для чтения).',
      unavailable: 'Плагин не загружен, поэтому его настройки сейчас недоступны.',
      invalidNumber: 'Длина и таймаут должны быть числами.',
    }

    const en = {
      token: 'Bot token',
      tokenSet: 'saved',
      tokenMissing: 'not set',
      tokenPlaceholder: 'Paste a @BotFather token to set or replace it',
      tokenHint:
        'The token lives in the DSH profile and never reaches the browser. Leaving the field empty keeps the current token.',
      statusConnected: 'Connected as @{username}',
      statusConnectedNoName: 'Connected (id {id})',
      statusNotRunning: 'Token accepted, but polling is not running — check the plugin row in the profile.',
      statusInvalid: 'Telegram rejected the token: {error}',
      statusNoToken: 'No token — the bot answers nobody.',
      statusNoInfo: 'Bot details are unavailable (the plugin route does not answer).',
      statusLoading: 'Checking the token…',
      check: 'Check',
      users: 'Users',
      usersHint:
        'Who the bot answers. Everyone in this list sees the same sessions: the bot does not separate access between users.',
      emptyUsers: 'Nobody yet. Add your Telegram id and the bot will start answering you.',
      add: 'Add',
      addPlaceholder: 'id or @username',
      addNamePlaceholder: 'Label (optional)',
      adding: 'Resolving…',
      addError: 'Could not add: {error}',
      already: 'That user is already in the list.',
      needId: 'Type a numeric id or an @username.',
      enabledOn: 'Answers',
      enabledOff: 'Muted',
      remove: 'Remove',
      unknownName: 'User {id}',
      noNameYet: 'the name appears once they message the bot',
      recent: 'Recently wrote to the bot:',
      bound: 'bound',
      access: 'Access',
      allowAll: 'Allow everyone',
      allowAllHint:
        'Dangerous: anyone who finds the bot gets access to your sessions. Leave it off unless you mean it.',
      appearance: 'Appearance',
      rendering: 'Message format',
      renderingHtml: 'HTML — renders in any Telegram client',
      renderingRich: 'Rich — native Rich Messages (needs a recent client)',
      renderingHint: 'A single chat can override this with /rich on|off.',
      advanced: 'Advanced',
      maxLength: 'Maximum message length',
      maxLengthHint: 'Telegram accepts at most 4096 characters; longer answers are split.',
      pollingTimeout: 'Long-poll timeout, seconds',
      pollingHint: '0 polls without waiting. Larger values save requests but slow down stopping.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. The new settings are already in effect.',
      failed: 'The profile refused the change — the stored values are unchanged.',
      reset: 'Discard edits',
      readOnly: 'This page cannot save settings (the profile is read-only).',
      unavailable: 'The plugin is not loaded, so its settings are unavailable right now.',
      invalidNumber: 'Length and timeout must be numbers.',
    }

    /**
     * Controls copied from the host's own settings form (dsh-client-ui-primitives
     * `settings-form/*.module.css`, `Input.module.css`, `Button.module.css`) under
     * this plugin's own prefix, keeping only `--dsw-alias-*` token references so a
     * theme change degrades appearance, never rendering.
     */
    const CSS = [
      '.tgch-root{display:flex;flex-direction:column;gap:18px;padding:4px 0 8px}',
      '.tgch-status{display:flex;align-items:center;gap:8px;padding:10px 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3)}',
      '.tgch-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}',
      '.tgch-status[data-state="ok"] .tgch-dot{background:var(--dsw-alias-state-success-primary, #2f9e44)}',
      '.tgch-status[data-state="error"] .tgch-dot{background:var(--dsw-alias-label-error)}',
      '.tgch-status[data-state="warn"] .tgch-dot{background:var(--dsw-alias-state-warning-primary, #f08c00)}',
      '.tgch-status-text{flex:1;min-width:0;margin:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
      '.tgch-section{display:flex;flex-direction:column;gap:10px;padding-top:12px;border-top:0.5px solid var(--dsw-alias-border-l3)}',
      '.tgch-section:first-of-type{border-top:none;padding-top:0}',
      '.tgch-title{display:flex;align-items:center;gap:8px;margin:0;font-size:13px;font-weight:600;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.tgch-count{font-size:11px;font-weight:400;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}',
      '.tgch-label{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary)}',
      '.tgch-badge{font-size:11px;line-height:1.5;padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-secondary)}',
      '.tgch-input,.tgch-select{height:32px;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);min-width:0}',
      '.tgch-input:focus-visible,.tgch-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}',
      '.tgch-input:disabled,.tgch-select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.tgch-input-narrow{max-width:180px}',
      '.tgch-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.tgch-warn{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-error)}',
      '.tgch-rows{display:flex;flex-direction:column;gap:6px}',
      '.tgch-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}',
      '.tgch-row[data-off="true"]{opacity:.55}',
      '.tgch-row-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}',
      '.tgch-row-name{font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tgch-row-meta{font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.tgch-toggle{display:flex;align-items:center;gap:6px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
      '.tgch-mini{appearance:none;border:none;background:none;padding:2px 6px;border-radius:var(--dsw-radius-sm);font:inherit;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none}',
      '.tgch-mini:hover:not(:disabled){background:var(--dsw-alias-bg-layer-4);color:var(--dsw-alias-label-primary)}',
      '.tgch-mini:disabled{opacity:.4;cursor:default}',
      '.tgch-add{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding-top:2px}',
      '.tgch-add .tgch-input{flex:1 1 180px}',
      '.tgch-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}',
      '.tgch-chip{appearance:none;border:0.5px dashed var(--dsw-alias-border-l4);background:none;padding:3px 8px;border-radius:var(--dsw-radius-sm);font:inherit;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.tgch-chip:hover:not(:disabled){border-style:solid;color:var(--dsw-alias-label-primary)}',
      '.tgch-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.tgch-check input{margin:2px 0 0}',
      '.tgch-field{display:flex;flex-direction:column;gap:6px}',
      '.tgch-details{display:flex;flex-direction:column;gap:10px}',
      '.tgch-summary{font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.tgch-footer{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding-top:4px}',
      '.tgch-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3)}',
      '.tgch-save:disabled{opacity:.4;cursor:default}',
      '.tgch-save:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.tgch-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.tgch-reset:disabled{opacity:.4;cursor:default}',
      '.tgch-message{flex:1;min-width:0;margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
      '.tgch-message[data-failed="true"]{color:var(--dsw-alias-label-error)}',
      '.tgch-notice{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}',
    ].join('')

    /** Trimmed text from whatever shape the host projected. */
    function textOf(value) {
      return typeof value === 'string' ? value : ''
    }

    /** A positive integer id, or 0 when the value is unusable. */
    function idOf(value) {
      const n = typeof value === 'string' ? Number(value.trim()) : value
      return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
    }

    /** The editable user list: the GUI list, else the legacy flat ids. */
    function usersOf(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const users = Array.isArray(source.users) ? source.users : []
      if (users.length > 0) {
        return users
          .map((user) => {
            const record = user !== null && typeof user === 'object' ? user : {}
            const id = idOf(record.id)
            if (id === 0) return null
            return { id, name: textOf(record.name), enabled: record.enabled !== false }
          })
          .filter(Boolean)
      }
      const legacy = Array.isArray(source.allowedUserIds) ? source.allowedUserIds : []
      return legacy
        .map((id) => idOf(id))
        .filter((id) => id > 0)
        .map((id) => ({ id, name: '', enabled: true }))
    }

    /** The stored values the form starts from. */
    function baselineOf(snapshot) {
      const value = snapshot !== null && snapshot !== undefined && snapshot.value !== null && typeof snapshot.value === 'object'
        ? snapshot.value
        : {}
      return {
        token: '',
        users: usersOf(value),
        allowAllUsers: value.allowAllUsers === true,
        rendering: value.rendering === 'rich' ? 'rich' : 'html',
        maxMessageLength: String(value.maxMessageLength === undefined ? 4096 : value.maxMessageLength),
        pollingTimeoutSec: String(value.pollingTimeoutSec === undefined ? 30 : value.pollingTimeoutSec),
      }
    }

    /** The settings form for one settings scope. */
    function formFor(scope) {
      return function TelegramChannelSettings(props) {
        const { t } = props
        const [draft, setDraft] = React.useState(null)
        const [info, setInfo] = React.useState(null)
        const [infoError, setInfoError] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [outcome, setOutcome] = React.useState(null)
        const [addQuery, setAddQuery] = React.useState('')
        const [addName, setAddName] = React.useState('')
        const [adding, setAdding] = React.useState(false)
        const [addError, setAddError] = React.useState('')

        const subscribe = React.useMemo(() => (listener) => scope.subscribe(listener), [scope])
        const read = React.useMemo(() => () => scope.getSnapshot(), [scope])
        const state = React.useSyncExternalStore(subscribe, read, read)
        const revision = state === undefined || state === null ? undefined : state.revision

        /** Ask the host routes who the bot is and which people it knows. */
        const loadInfo = React.useCallback(async () => {
          try {
            const response = await fetch(INFO_URL, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
              credentials: 'same-origin',
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
              throw new Error(textOf(payload && payload.error) || 'bad payload')
            }
            setInfo(payload)
            setInfoError('')
          } catch (err) {
            setInfo(null)
            setInfoError(err instanceof Error ? err.message : String(err))
          }
        }, [])

        React.useEffect(() => {
          void loadInfo()
        }, [loadInfo])

        // A host revision means the document moved under us: start again from
        // the stored values, dropping staged edits.
        React.useEffect(() => {
          if (state === undefined || state === null || state.status !== 'ready') return
          setDraft(baselineOf(state))
        }, [revision, state === undefined || state === null ? 'none' : state.status])

        if (props.view !== undefined && props.view !== 'page') return null
        if (state === undefined || state === null || state.status === 'unavailable') {
          return h('p', { className: 'tgch-notice', role: 'status' }, t('unavailable'))
        }
        if (state.status !== 'ready' || draft === null) return null

        const writable = state.writable === true
        const baseline = baselineOf(state)
        const token = textOf(draft.token)
        const dirty = token.trim().length > 0
          || JSON.stringify(draft.users) !== JSON.stringify(baseline.users)
          || draft.allowAllUsers !== baseline.allowAllUsers
          || draft.rendering !== baseline.rendering
          || draft.maxMessageLength !== baseline.maxMessageLength
          || draft.pollingTimeoutSec !== baseline.pollingTimeoutSec

        const known = info !== null && Array.isArray(info.users) ? info.users : []
        const knownById = new globalThis.Map(known.map((row) => [idOf(row.id), row]))

        /** Everything not already allowed, newest first: one click to add. */
        const recent = info !== null && Array.isArray(info.people)
          ? info.people
            .filter((person) => idOf(person.id) > 0)
            .filter((person) => !draft.users.some((user) => user.id === idOf(person.id)))
            .slice(0, 6)
          : []

        /** Label for one user row: own label, then the Telegram name, then the id. */
        function rowTitle(user) {
          const person = knownById.get(user.id)
          const telegramName = textOf(person && person.name) || (textOf(person && person.username) ? `@${textOf(person.username)}` : '')
          return user.name.length > 0 ? user.name : telegramName.length > 0 ? telegramName : t('unknownName', { id: user.id })
        }

        /** Store the draft as one atomic mutation. */
        async function save() {
          if (!writable || busy) return
          const maxLength = Number(draft.maxMessageLength)
          const polling = Number(draft.pollingTimeoutSec)
          if (!Number.isFinite(maxLength) || !Number.isFinite(polling)) {
            setOutcome(t('invalidNumber'))
            return
          }
          const cleanUsers = draft.users
            .filter((user) => user.id > 0)
            .map((user) => ({ id: user.id, name: user.name, enabled: user.enabled !== false }))
          const ops = []
          if (token.trim().length > 0) ops.push({ op: 'set', path: ['token'], value: token.trim() })
          if (JSON.stringify(cleanUsers) !== JSON.stringify(baseline.users)) {
            ops.push({ op: 'set', path: ['users'], value: cleanUsers })
            // The legacy flat list is what the pre-0.9.0 config used; once the
            // user list is written it would be a second, invisible allowlist.
            ops.push({ op: 'unset', path: ['allowedUserIds'] })
          }
          if (draft.allowAllUsers !== baseline.allowAllUsers) {
            ops.push({ op: 'set', path: ['allowAllUsers'], value: draft.allowAllUsers })
          }
          if (draft.rendering !== baseline.rendering) {
            ops.push({ op: 'set', path: ['rendering'], value: draft.rendering })
          }
          if (draft.maxMessageLength !== baseline.maxMessageLength) {
            ops.push({ op: 'set', path: ['maxMessageLength'], value: Math.min(4096, Math.max(100, Math.trunc(maxLength))) })
          }
          if (draft.pollingTimeoutSec !== baseline.pollingTimeoutSec) {
            ops.push({ op: 'set', path: ['pollingTimeoutSec'], value: Math.min(120, Math.max(0, Math.trunc(polling))) })
          }
          if (ops.length === 0) return
          setBusy(true)
          setOutcome(null)
          let accepted = false
          try {
            accepted = (await scope.mutate(ops)) === true
          } catch (err) {
            accepted = false
          }
          setBusy(false)
          setOutcome(accepted ? 'saved' : 'failed')
          if (accepted) {
            // The plugin rebuilds its bridge asynchronously; give it a moment
            // before asking again which bot the token belongs to.
            setTimeout(() => { void loadInfo() }, 1200)
          }
        }

        /** Add one person by numeric id or `@username`. */
        async function addUser(rawQuery, rawName) {
          if (busy || adding) return
          const query = textOf(rawQuery).trim()
          if (query.length === 0) {
            setAddError(t('needId'))
            return
          }
          setAdding(true)
          setAddError('')
          let id = idOf(query)
          if (id === 0) {
            try {
              const response = await fetch(RESOLVE_URL, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({ query }),
              })
              const payload = await response.json().catch(() => ({}))
              if (!payload || payload.ok !== true || !payload.user) {
                throw new Error(textOf(payload && payload.error) || `HTTP ${response.status}`)
              }
              id = idOf(payload.user.id)
            } catch (err) {
              setAdding(false)
              setAddError(t('addError', { error: err instanceof Error ? err.message : String(err) }))
              return
            }
          }
          setAdding(false)
          if (id === 0) {
            setAddError(t('needId'))
            return
          }
          if (draft.users.some((user) => user.id === id)) {
            setAddError(t('already'))
            return
          }
          setDraft({
            ...draft,
            users: draft.users.concat([{ id, name: textOf(rawName).trim(), enabled: true }]),
          })
          setAddQuery('')
          setAddName('')
        }

        const status = (() => {
          if (infoError.length > 0 && info === null) return { state: 'warn', text: t('statusNoInfo') }
          if (info === null) return { state: 'idle', text: t('statusLoading') }
          if (info.error) return { state: 'error', text: t('statusInvalid', { error: info.error }) }
          if (info.bot && info.bot.username) return { state: 'ok', text: t('statusConnected', { username: info.bot.username }) }
          if (info.bot) return { state: 'ok', text: t('statusConnectedNoName', { id: info.bot.id }) }
          if (!info.tokenSet) return { state: 'warn', text: t('statusNoToken') }
          if (!info.running) return { state: 'warn', text: t('statusNotRunning') }
          return { state: 'idle', text: t('statusLoading') }
        })()

        const tokenSet = info !== null && info.tokenSet === true

        return h(
          'div',
          { className: 'tgch-root' },
          // ── live status ──
          h(
            'div',
            { className: 'tgch-status', 'data-state': status.state, role: 'status' },
            h('span', { className: 'tgch-dot', 'aria-hidden': 'true' }),
            h('p', { className: 'tgch-status-text' }, status.text),
            h(
              'button',
              { type: 'button', className: 'tgch-mini', onClick: () => { void loadInfo() }, disabled: busy },
              t('check'),
            ),
          ),
          // ── token ──
          h(
            'div',
            { className: 'tgch-section' },
            h(
              'div',
              { className: 'tgch-label' },
              h('label', { htmlFor: 'tgch-token' }, t('token')),
              h('span', { className: 'tgch-badge' }, tokenSet ? t('tokenSet') : t('tokenMissing')),
            ),
            h('input', {
              id: 'tgch-token',
              className: 'tgch-input',
              type: 'password',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: t('tokenPlaceholder'),
              value: token,
              disabled: !writable || busy,
              onInput: (event) => setDraft({ ...draft, token: event.target.value }),
            }),
            h('p', { className: 'tgch-hint' }, t('tokenHint')),
          ),
          // ── users ──
          h(
            'div',
            { className: 'tgch-section' },
            h(
              'h3',
              { className: 'tgch-title' },
              t('users'),
              h('span', { className: 'tgch-count' }, String(draft.users.length)),
            ),
            h('p', { className: 'tgch-hint' }, t('usersHint')),
            draft.users.length === 0
              ? h('p', { className: 'tgch-hint' }, t('emptyUsers'))
              : h(
                'div',
                { className: 'tgch-rows' },
                draft.users.map((user) => {
                  const person = knownById.get(user.id)
                  const telegramName = textOf(person && person.name)
                    || (textOf(person && person.username) ? `@${textOf(person.username)}` : '')
                  const meta = [
                    String(user.id),
                    telegramName.length > 0 && user.name.length > 0 ? telegramName : trailName(t, telegramName),
                    person && person.bound === true ? t('bound') : '',
                  ].filter((part) => part.length > 0).join(' · ')
                  return h(
                    'div',
                    { className: 'tgch-row', key: `user-${String(user.id)}`, 'data-off': user.enabled ? 'false' : 'true' },
                    h(
                      'label',
                      { className: 'tgch-toggle', title: user.enabled ? t('enabledOn') : t('enabledOff') },
                      h('input', {
                        type: 'checkbox',
                        checked: user.enabled,
                        'aria-label': `${rowTitle(user)} — ${user.enabled ? t('enabledOn') : t('enabledOff')}`,
                        disabled: !writable || busy,
                        onChange: (event) => {
                          const enabled = event.target.checked
                          setDraft({
                            ...draft,
                            users: draft.users.map((row) => (row.id === user.id ? { ...row, enabled } : row)),
                          })
                        },
                      }),
                      h('span', null, user.enabled ? t('enabledOn') : t('enabledOff')),
                    ),
                    h(
                      'div',
                      { className: 'tgch-row-main' },
                      h('span', { className: 'tgch-row-name' }, rowTitle(user)),
                      h('span', { className: 'tgch-row-meta' }, meta),
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'tgch-mini',
                        'aria-label': `${t('remove')}: ${rowTitle(user)}`,
                        disabled: !writable || busy,
                        onClick: () => setDraft({ ...draft, users: draft.users.filter((row) => row.id !== user.id) }),
                      },
                      t('remove'),
                    ),
                  )
                }),
              ),
            h(
              'div',
              { className: 'tgch-add' },
              h('input', {
                id: 'tgch-add-query',
                className: 'tgch-input',
                type: 'text',
                inputMode: 'text',
                'aria-label': t('addPlaceholder'),
                placeholder: t('addPlaceholder'),
                value: addQuery,
                disabled: !writable || busy || adding,
                onInput: (event) => setAddQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    void addUser(addQuery, addName)
                  }
                },
              }),
              h('input', {
                id: 'tgch-add-name',
                className: 'tgch-input',
                type: 'text',
                'aria-label': t('addNamePlaceholder'),
                placeholder: t('addNamePlaceholder'),
                value: addName,
                disabled: !writable || busy || adding,
                onInput: (event) => setAddName(event.target.value),
              }),
              h(
                'button',
                {
                  id: 'tgch-add',
                  type: 'button',
                  className: 'tgch-save',
                  disabled: !writable || busy || adding || addQuery.trim().length === 0,
                  onClick: () => { void addUser(addQuery, addName) },
                },
                adding ? t('adding') : t('add'),
              ),
            ),
            addError.length > 0 ? h('p', { className: 'tgch-warn', role: 'alert' }, addError) : null,
            recent.length > 0
              ? h(
                'div',
                { className: 'tgch-chips' },
                h('span', { className: 'tgch-hint' }, t('recent')),
                recent.map((person) => h(
                  'button',
                  {
                    key: `recent-${String(person.id)}`,
                    type: 'button',
                    className: 'tgch-chip',
                    disabled: !writable || busy || adding,
                    onClick: () => { void addUser(String(person.id), textOf(person.name)) },
                  },
                  `${textOf(person.name) || textOf(person.username) || String(person.id)} · ${String(person.id)}`,
                )),
              )
              : null,
          ),
          // ── access ──
          h(
            'div',
            { className: 'tgch-section' },
            h('h3', { className: 'tgch-title' }, t('access')),
            h(
              'label',
              { className: 'tgch-check' },
              h('input', {
                id: 'tgch-allow-all',
                type: 'checkbox',
                checked: draft.allowAllUsers,
                'aria-label': t('allowAll'),
                disabled: !writable || busy,
                onChange: (event) => setDraft({ ...draft, allowAllUsers: event.target.checked }),
              }),
              h('span', null, t('allowAll')),
            ),
            h('p', { className: draft.allowAllUsers ? 'tgch-warn' : 'tgch-hint' }, t('allowAllHint')),
          ),
          // ── appearance ──
          h(
            'div',
            { className: 'tgch-section' },
            h('h3', { className: 'tgch-title' }, t('appearance')),
            h(
              'div',
              { className: 'tgch-field' },
              h('label', { className: 'tgch-label', htmlFor: 'tgch-rendering' }, t('rendering')),
              h(
                'select',
                {
                  id: 'tgch-rendering',
                  className: 'tgch-select',
                  value: draft.rendering,
                  disabled: !writable || busy,
                  onChange: (event) => setDraft({ ...draft, rendering: event.target.value === 'rich' ? 'rich' : 'html' }),
                },
                h('option', { value: 'html' }, t('renderingHtml')),
                h('option', { value: 'rich' }, t('renderingRich')),
              ),
              h('p', { className: 'tgch-hint' }, t('renderingHint')),
            ),
          ),
          // ── advanced ──
          h(
            'details',
            { className: 'tgch-details' },
            h('summary', { className: 'tgch-summary' }, t('advanced')),
            h(
              'div',
              { className: 'tgch-field' },
              h('label', { className: 'tgch-label', htmlFor: 'tgch-maxlen' }, t('maxLength')),
              h('input', {
                id: 'tgch-maxlen',
                className: 'tgch-input tgch-input-narrow',
                type: 'number',
                min: 100,
                max: 4096,
                step: 1,
                value: draft.maxMessageLength,
                disabled: !writable || busy,
                onInput: (event) => setDraft({ ...draft, maxMessageLength: event.target.value }),
              }),
              h('p', { className: 'tgch-hint' }, t('maxLengthHint')),
            ),
            h(
              'div',
              { className: 'tgch-field' },
              h('label', { className: 'tgch-label', htmlFor: 'tgch-polling' }, t('pollingTimeout')),
              h('input', {
                id: 'tgch-polling',
                className: 'tgch-input tgch-input-narrow',
                type: 'number',
                min: 0,
                max: 120,
                step: 1,
                value: draft.pollingTimeoutSec,
                disabled: !writable || busy,
                onInput: (event) => setDraft({ ...draft, pollingTimeoutSec: event.target.value }),
              }),
              h('p', { className: 'tgch-hint' }, t('pollingHint')),
            ),
          ),
          // ── footer ──
          h(
            'div',
            { className: 'tgch-footer' },
            h(
              'button',
              {
                id: 'tgch-save',
                type: 'button',
                className: 'tgch-save',
                disabled: !writable || busy || !dirty,
                onClick: () => { void save() },
              },
              busy ? t('saving') : t('save'),
            ),
            dirty
              ? h(
                'button',
                {
                  id: 'tgch-reset',
                  type: 'button',
                  className: 'tgch-reset',
                  disabled: !writable || busy,
                  onClick: () => {
                    setDraft(baselineOf(state))
                    setOutcome(null)
                    setAddError('')
                  },
                },
                t('reset'),
              )
              : null,
            outcome === null
              ? null
              : h(
                'p',
                {
                  className: 'tgch-message',
                  'data-failed': outcome === 'failed' ? 'true' : 'false',
                  role: 'status',
                },
                outcome === 'saved' ? t('saved') : outcome === 'failed' ? t('failed') : outcome,
              ),
            writable ? null : h('p', { className: 'tgch-notice' }, t('readOnly')),
          ),
        )
      }
    }

    /**
     * Secondary line for a user row: the Telegram name when the owner's label
     * occupies the title, a reminder when neither is known.
     */
    function trailName(t, telegramName) {
      return telegramName.length > 0 ? telegramName : t('noNameYet')
    }

    return {
      /** Cordis services this browser half needs; `slots` is mandatory here. */
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(LOCALE_NS, { ru, en }), 'dsh-telegram-channel-ru: dictionaries')
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin', 'dsh-telegram-channel-ru')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'dsh-telegram-channel-ru: form styles')
        // `configForms` exists only where the Plugins page can carry a settings
        // form (DSH 0.2+); without it this half stays inert instead of rendering
        // a form that could not save.
        ctx.inject(['configForms'], (forms) => {
          const scope = forms.configForms.get(ENTRY_ID)
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register(
              { name: 'plugins.bundle.config', key: ENTRY_ID, locale: LOCALE_NS },
              formFor(scope),
            ),
          )
        })
      },
    }
  },
})

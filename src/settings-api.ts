/**
 * The two tiny HTTP routes the Web settings page uses.
 *
 * The settings *form* itself is DSH's own (`plugins.bundle.config` slot writing
 * through `ctx.configForms`), but two facts cannot come from the config
 * document: who the token belongs to (`getMe`) and the people Telegram knows
 * (`getChat`). Both live in the running bridge, so the host half exposes them
 * here.
 *
 * Everything is read-only metadata: the bot token never crosses this boundary.
 * The routes are plain host routes (`/plugins/<package>/settings/...`), not
 * `/api`, so they are same-origin but not session-gated — hence the narrow
 * payload, `no-store`, and the same-origin check on the one POST.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

/** Where the settings page asks for bot identity, allowlist and known people. */
export const SETTINGS_INFO_PATH = '/plugins/dsh-telegram-channel-ru/settings/info'
/** Where the settings page resolves `@username` → numeric id when adding a person. */
export const SETTINGS_RESOLVE_PATH = '/plugins/dsh-telegram-channel-ru/settings/resolve'

/** Largest accepted resolve body: a username and a little JSON. */
const MAX_BODY_BYTES = 4096

/** What the info route returns. */
export interface SettingsInfo {
  ok: true
  running: boolean
  tokenSet: boolean
  bot?: { id: number; username?: string; name?: string }
  /** Human-readable reason the token could not be used (bad token, network). */
  error?: string
  allowAllUsers: boolean
  users: Array<{ id: number; name?: string; username?: string; enabled?: boolean; bound?: boolean }>
  people: Array<{ id: number; name?: string; username?: string; at: number }>
  bindings: Array<{ chatId: number; sessionId: string; label: string }>
}

/** What the resolve route answers for one `@username` / id. */
export interface ResolvedPerson {
  id: number
  name?: string
  username?: string
}

export interface SettingsApiDeps {
  /** Everything the page shows; may fail on its own (a dead token is data, not an error). */
  describe: () => Promise<SettingsInfo>
  /** Resolve one person the owner typed. */
  resolve: (query: string) => Promise<ResolvedPerson>
  logger: { warn: (message: string) => void }
}

export interface SettingsApiHandlers {
  info: (req: IncomingMessage, res: ServerResponse) => Promise<void>
  resolve: (req: IncomingMessage, res: ServerResponse) => Promise<void>
}

/** Send one JSON response, never cached. */
function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

/**
 * Reject a cross-site request. The routes carry no session, so a malicious page
 * must not be able to drive them; a same-origin browser always sends `Origin`
 * or `Referer` naming this host. Requests with neither (curl, tests) pass.
 */
function sameOrigin(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined) return true
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  const referer = req.headers.referer
  if (typeof referer === 'string' && referer.length > 0) {
    try {
      return new URL(referer).host === host
    } catch {
      return false
    }
  }
  return true
}

/** Read at most {@link MAX_BODY_BYTES} of a request body and parse it as JSON. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    size += buffer.byteLength
    if (size > MAX_BODY_BYTES) throw new Error('тело запроса слишком большое')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('тело запроса должно быть JSON')
  }
}

/**
 * Build the route handlers over the plugin's current state.
 * @param deps - state readers owned by the host half.
 * @returns the two `webServer.register` handlers.
 */
export function createSettingsApi(deps: SettingsApiDeps): SettingsApiHandlers {
  const info = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('allow', 'GET, HEAD')
      sendJson(res, 405, { ok: false, error: 'только GET' })
      return
    }
    try {
      const payload = await deps.describe()
      if (req.method === 'HEAD') {
        res.statusCode = 200
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('cache-control', 'no-store')
        res.end()
        return
      }
      sendJson(res, 200, payload)
    } catch (err) {
      deps.logger.warn(`dsh-telegram-channel: settings info failed: ${err instanceof Error ? err.message : String(err)}`)
      sendJson(res, 500, { ok: false, error: 'не удалось прочитать состояние бота' })
    }
  }

  const resolve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendJson(res, 405, { ok: false, error: 'только POST' })
      return
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'чужой источник запроса' })
      return
    }
    try {
      const body = await readJson(req)
      const query = typeof (body as { query?: unknown })?.query === 'string'
        ? ((body as { query: string }).query).trim()
        : ''
      if (query.length === 0) {
        sendJson(res, 400, { ok: false, error: 'укажите @username или числовой id' })
        return
      }
      if (query.length > 64) {
        sendJson(res, 400, { ok: false, error: 'слишком длинный запрос' })
        return
      }
      const person = await deps.resolve(query)
      sendJson(res, 200, { ok: true, user: person })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      deps.logger.warn(`dsh-telegram-channel: settings resolve failed: ${message}`)
      sendJson(res, 200, { ok: false, error: message })
    }
  }

  return { info, resolve }
}

import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import * as nodeZlib from 'node:zlib'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { resolveApiProxy } from './apiproxy.js'
import { describeAgent, workspaceName } from './label.js'

export interface WorkspaceRow {
  id: string
  title: string
  path: string
  sessionIds: string[]
}

export interface SessionRow {
  sessionId: string
  title: string
  cwd?: string
  blank: boolean
  running: boolean
  origin?: string
  /** DSH marks a session archived; the picker must hide it. */
  archived?: boolean
  /** true when the name came from DSH projections, false for a local fallback. */
  named?: boolean
  updatedAt: number
}

export interface CatalogSnapshot {
  workspaces: WorkspaceRow[]
  sessionsById: Map<string, SessionRow>
  archivedIds: Set<string>
  /** true when loaded from apiProxy (Web-aligned); false for live-agent fallback. */
  complete: boolean
}

type RpcOk<T> = { result: { ok: true; value: T } }
type ApiFn = (req: { rpcId: string; payload: unknown }) => Promise<unknown>

function rpcCall(fn: ApiFn | undefined, payload: unknown): Promise<unknown> | undefined {
  if (typeof fn !== 'function') return undefined
  return fn({ rpcId: randomUUID(), payload })
}

function unwrap<T>(res: unknown): T | undefined {
  const r = res as RpcOk<T> | undefined
  if (r?.result && (r.result as { ok?: boolean }).ok === true) {
    return (r.result as { value: T }).value
  }
  // Some wrappers may return value directly
  if (res && typeof res === 'object' && 'items' in (res as object)) return res as T
  return undefined
}

/** `session-<uuid>` and `<uuid>` name the same session; compare the bare id. */
export function normalizeSessionId(sessionId: string): string {
  const id = String(sessionId)
  return id.startsWith('session-') ? id.slice('session-'.length) : id
}

/** Is this session archived? Accepts both id spellings, like the Web UI does. */
export function isArchived(archivedIds: Set<string>, sessionId: string): boolean {
  const bare = normalizeSessionId(sessionId)
  return archivedIds.has(sessionId) || archivedIds.has(bare) || archivedIds.has(`session-${bare}`)
}

/** `21.10 14:05` in local time — keeps untitled sessions distinguishable. */
export function shortWhen(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * Session name for buttons/pickers. The Web title wins; when DSH has not
 * generated one, fall back to `workspace · date` (never a bare number), so a
 * button always carries something the owner can recognise.
 */
function titleOf(summary: {
  sessionId: string
  cwd?: string
  updatedAt?: number
  projections?: {
    values?: {
      title?: string | null
      /** First/last human messages DSH keeps for title generation. */
      titleInput?: { first?: { text?: string } | null } | null
    }
  }
}): string {
  const fromHost = projectionTitle(summary)
  if (fromHost) return fromHost
  const when = shortWhen(Number(summary.updatedAt) || 0)
  // No title anywhere: the project is already in the picker header, so the
  // session is better named by its time — never repeat the project name.
  if (when) return `сессия · ${when}`
  const id = String(summary.sessionId)
  const tail = id.length > 12 ? `…${id.slice(-12)}` : id
  return when ? `${when} · ${tail}` : tail
}

/** Cache of names recovered from on-disk session logs (cold sessions have no projections). */
const logTitleCache = new Map<string, string | undefined>()

/** DSH stores sessions under `<home>/sessions/<escaped-cwd>/<bare-id>/session.v4.jsonl.zstd`. */
function escapeCwdForStore(cwd: string): string {
  const trimmed = cwd.replace(/\/+$/, '')
  let out = ''
  for (const ch of trimmed) {
    if (/[a-zA-Z0-9._-]/.test(ch)) out += ch
    else if (ch === '/') out += '-'
    else out += `~${ch.codePointAt(0)!.toString(16).padStart(4, '0')}`
  }
  return `--${out.replace(/^-+/, '')}--`
}

/** Text of a message content payload: string parts joined, other blocks skipped. */
function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const item = block as { type?: string; text?: unknown }
    if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text)
  }
  return parts.join('\n')
}

function firstUserTextFromLog(file: string): string | undefined {
  try {
    const zstd = (nodeZlib as unknown as { zstdDecompressSync?: (buf: Buffer) => Buffer }).zstdDecompressSync
    if (typeof zstd !== 'function') return undefined
    const raw = zstd(readFileSync(file)).toString('utf8')
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      let event: { type?: string; data?: { source?: { kind?: string }; content?: unknown; message?: { content?: unknown } } }
      try {
        event = JSON.parse(line) as typeof event
      } catch {
        continue
      }
      if (event.type !== 'user/message') continue
      if (event.data?.source?.kind !== undefined && event.data.source.kind !== 'user') continue
      const text = textOfContent(event.data?.message?.content ?? event.data?.content)
      const flat = text.replace(/\s+/g, ' ').trim()
      if (flat) {
        const chars = [...flat]
        return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : flat
      }
    }
  } catch {
    // unreadable / unsupported log — the caller falls back further
  }
  return undefined
}

/**
 * Recover a session name from its log on disk. Cold sessions have no
 * projections, so this is what turns "Synthriders" (the project) into the real
 * first message of each session.
 */
export function readTitleFromSessionLog(sessionId: string, cwd?: string): string | undefined {
  const bare = normalizeSessionId(sessionId)
  if (logTitleCache.has(bare)) return logTitleCache.get(bare)
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = join(home, 'sessions')
  const candidates: string[] = []
  if (cwd) candidates.push(join(root, escapeCwdForStore(cwd), bare, 'session.v4.jsonl.zstd'))
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, bare, 'session.v4.jsonl.zstd')
      if (!candidates.includes(file)) candidates.push(file)
    }
  } catch {
    // no sessions dir — nothing to recover
  }
  for (const file of candidates) {
    if (!existsSync(file)) continue
    const title = firstUserTextFromLog(file)
    if (title) {
      logTitleCache.set(bare, title)
      return title
    }
  }
  logTitleCache.set(bare, undefined)
  return undefined
}

/** Name straight out of DSH projections: the title, else the first user message. */
function projectionTitle(summary: {
  projections?: {
    values?: {
      title?: string | null
      titleInput?: { first?: { text?: string } | null } | null
    }
  }
}): string | undefined {
  const t = summary.projections?.values?.title
  if (typeof t === 'string' && t.trim()) return t.trim()
  const firstText = summary.projections?.values?.titleInput?.first?.text
  if (typeof firstText === 'string' && firstText.trim()) {
    const flat = firstText.replace(/\s+/g, ' ').trim()
    const chars = [...flat]
    return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : flat
  }
  return undefined
}

/** Host services that DSH >= 0.2 exposes instead of the old `apiProxy`. */
interface HostServices {
  sessionController?: {
    list?: (signal?: AbortSignal) => Promise<SessionListItem[]>
    projections?: (request: { sessionId: string }, signal?: AbortSignal) => Promise<ProjectionBlock | null>
  }
  workspaceRegistry?: {
    list?: () => Array<{ id: string; path: string; title: string; sessionIds: string[] }>
    archivedSessionIds?: string[]
  }
}

interface ProjectionBlock {
  kind?: string
  values?: {
    title?: string | null
    titleInput?: { first?: { text?: string } | null } | null
  }
}

interface SessionListItem {
  sessionId: string
  updatedAt?: number
  running?: boolean
  blank?: boolean
  origin?: string
  cwd?: string
  projections?: ProjectionBlock
}

/**
 * Diagnostics land in a file: the cordis logger does not reach the journal, so
 * a silent fallback would otherwise be invisible.
 */
export function debugLog(line: string): void {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    const file = join(home, 'telegram-channel-debug.log')
    try {
      if (statSync(file).size > 256_000) return
    } catch {
      mkdirSync(join(file, '..'), { recursive: true })
    }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    // diagnostics must never break the bot
  }
}

type ServiceReader = Context & {
  get?: (service: string, strict?: boolean) => unknown
  root?: { get?: (service: string, strict?: boolean) => unknown }
}

/**
 * Read a host service through every route cordis offers: strict `get`, loose
 * `get(name, false)` (returns services whose providing fiber is not ACTIVE),
 * the plain property, and the root context. Each attempt is logged, so a
 * fallback is explainable after the fact instead of silent.
 */
export function hostService<T>(ctx: Context, name: string): T | undefined {
  const reader = ctx as ServiceReader
  const attempts: Array<[string, () => unknown]> = [
    ['get', () => (typeof reader.get === 'function' ? reader.get.call(ctx, name) : undefined)],
    ['get-loose', () => (typeof reader.get === 'function' ? reader.get.call(ctx, name, false) : undefined)],
    ['property', () => (reader as unknown as Record<string, unknown>)[name]],
    ['root-get-loose', () => {
      const root = reader.root
      return typeof root?.get === 'function' ? root.get.call(root, name, false) : undefined
    }],
  ]
  for (const [label, read] of attempts) {
    let value: unknown
    try {
      value = read()
    } catch (err) {
      debugLog(`hostService ${name} [${label}]: threw ${String(err)}`)
      continue
    }
    if (value !== undefined && value !== null) {
      debugLog(`hostService ${name} [${label}]: ok`)
      return value as T
    }
    debugLog(`hostService ${name} [${label}]: undefined`)
  }
  return undefined
}

/** Host services answer either an array or an envelope; unwrap both. */
function asRows<T>(value: unknown): T[] | undefined {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    const box = value as Record<string, unknown>
    for (const key of ['items', 'records', 'rows', 'sessions', 'workspaces', 'value', 'data']) {
      const inner = box[key]
      if (Array.isArray(inner)) return inner as T[]
    }
  }
  return undefined
}

function describeShape(value: unknown): string {
  if (value === null || value === undefined) return String(value)
  if (Array.isArray(value)) return `array(${value.length})`
  if (typeof value === 'object') {
    const keys = Object.keys(value as object).slice(0, 8).join(',')
    return `object{${keys}}`
  }
  return typeof value
}

function hostServices(ctx: Context): HostServices {
  return {
    sessionController: hostService<HostServices['sessionController']>(ctx, 'sessionController'),
    workspaceRegistry: hostService<HostServices['workspaceRegistry']>(ctx, 'workspaceRegistry'),
  }
}

/**
 * Catalog straight from host services — the 0.2.x path.
 *
 * `dsh` 0.2 removed the `apiProxy` service the 0.1.x plugin talked to, so the
 * old RPC route silently degrades to "только запущенные сессии". The Web UI
 * itself reads `workspaceRegistry` (ordering + archive set) and
 * `sessionController.list()` (every stored session with its projections), and
 * both are plain host services we can call the same way.
 */
async function loadCatalogFromHost(ctx: Context): Promise<CatalogSnapshot | undefined> {
  const { sessionController, workspaceRegistry } = hostServices(ctx)
  const listSessions = sessionController?.list
  const listWorkspaces = workspaceRegistry?.list
  debugLog(
    `loadCatalogFromHost: sessionController=${sessionController ? 'yes' : 'no'} list=${typeof listSessions} ` +
    `workspaceRegistry=${workspaceRegistry ? 'yes' : 'no'} list=${typeof listWorkspaces}`,
  )
  if (typeof listSessions !== 'function' || typeof listWorkspaces !== 'function') return undefined

  let items: SessionListItem[]
  let registry: Array<{ id: string; path: string; title: string; sessionIds: string[] }>
  try {
    const rawSessions: unknown = await listSessions.call(sessionController)
    const rawRegistry: unknown = listWorkspaces.call(workspaceRegistry)
    debugLog(`loadCatalogFromHost: raw sessions=${describeShape(rawSessions)} registry=${describeShape(rawRegistry)}`)
    const unwrappedSessions = asRows<SessionListItem>(rawSessions)
    const unwrappedRegistry = asRows<{ id?: string; workspaceId?: string; path?: string; title?: string; sessionIds?: string[] }>(rawRegistry)
    if (!unwrappedSessions || !unwrappedRegistry) {
      debugLog(`loadCatalogFromHost: cannot unwrap sessions/registry (${describeShape(rawSessions)} / ${describeShape(rawRegistry)})`)
      return undefined
    }
    items = unwrappedSessions
    registry = unwrappedRegistry.map((w) => ({
      id: String(w.id ?? w.workspaceId ?? w.path ?? ''),
      path: String(w.path ?? ''),
      title: String(w.title ?? ''),
      sessionIds: (w.sessionIds ?? []).map(String),
    }))
  } catch (err) {
    debugLog(`loadCatalogFromHost: list() threw ${String(err)}`)
    return undefined
  }

  const archivedIds = new Set<string>()
  for (const id of workspaceRegistry?.archivedSessionIds ?? []) archivedIds.add(String(id))

  const sessionsById = new Map<string, SessionRow>()
  for (const item of items) {
    const sessionId = String(item.sessionId)
    if (!sessionId) continue
    sessionsById.set(sessionId, {
      sessionId,
      title: titleOf({ ...item, sessionId, updatedAt: Number(item.updatedAt) || 0 }),
      named: projectionTitle({ projections: item.projections }) !== undefined,
      cwd: item.cwd,
      blank: Boolean(item.blank),
      running: Boolean(item.running),
      origin: item.origin,
      updatedAt: Number(item.updatedAt) || 0,
    })
  }

  const workspaces: WorkspaceRow[] = registry.map((w) => ({
    id: String(w.id),
    title: w.title || workspaceName(w.path) || String(w.id),
    path: w.path,
    sessionIds: (w.sessionIds ?? []).map(String),
  }))

  debugLog(
    `loadCatalogFromHost: ok sessions=${items.length} workspaces=${registry.length} archived=${archivedIds.size}`,
  )
  return { workspaces, sessionsById, archivedIds, complete: true }
}

/** `sessionController.projections` — the 0.2.x way to name a cold session. */
async function resolveSessionTitleFromHost(
  ctx: Context,
  sessionId: string,
): Promise<string | undefined> {
  const controller = hostServices(ctx).sessionController
  const call = controller?.projections
  if (typeof call !== 'function') return undefined
  try {
    const block = await call.call(controller, { sessionId })
    if (!block) return readTitleFromSessionLog(sessionId, cwd)
    return projectionTitle({ projections: block }) ?? readTitleFromSessionLog(sessionId, cwd)
  } catch {
    return undefined
  }
}

/**
 * Ask the host for one session's projections. Cold sessions often arrive in
 * `sessions.list` without a projection block, so this is what puts a real name
 * on a picker button instead of a date.
 */
export async function resolveSessionTitle(
  ctx: Context,
  sessionId: string,
  cwd?: string,
): Promise<string | undefined> {
  const api = resolveApiProxy(ctx)
  const call = api?.sessions?.projections
  if (typeof call !== 'function') {
    return (await resolveSessionTitleFromHost(ctx, sessionId)) ?? readTitleFromSessionLog(sessionId, cwd)
  }
  try {
    const raw = await call({ rpcId: randomUUID(), payload: { sessionId } })
    const value = unwrap<ProjectionBlock>(raw)
    // Any gap in the old route is answered by the host one.
    if (!value) return await resolveSessionTitleFromHost(ctx, sessionId)
    return projectionTitle({ projections: value }) ?? await resolveSessionTitleFromHost(ctx, sessionId)
  } catch {
    return await resolveSessionTitleFromHost(ctx, sessionId)
  }
}

/**
 * Catalog read straight from the DSH store on disk.
 *
 * Last resort on purpose: it needs no host service, so "покажи все проекты"
 * keeps working even when the service surface changes between DSH versions.
 * Sources: `storages/workspace.json` (registry order, titles, session ids and
 * the archive set) + `storages/session_projcache/sessions/*.json` (cached
 * titles / first messages).
 */
export function loadCatalogFromDisk(ctx: Context): CatalogSnapshot | undefined {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const storeFile = join(home, 'storages', 'workspace.json')
  let store: {
    global?: { workspaceIds?: string[]; archivedSessionIds?: string[] }
    tables?: { workspaces?: Record<string, { path?: string; title?: string; sessionIds?: string[] }> }
  }
  try {
    store = JSON.parse(readFileSync(storeFile, 'utf8')) as typeof store
  } catch (err) {
    debugLog(`loadCatalogFromDisk: cannot read ${storeFile}: ${String(err)}`)
    return undefined
  }
  const table = store.tables?.workspaces ?? {}
  const order = store.global?.workspaceIds ?? Object.keys(table)
  const archivedIds = new Set<string>((store.global?.archivedSessionIds ?? []).map(String))

  // Cached titles / first messages per session.
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  const cached = new Map<string, { title?: string; first?: string; at: number }>()
  try {
    for (const file of readdirSync(cacheDir)) {
      if (!file.endsWith('.json')) continue
      const sessionId = `session-${file.slice(0, -'.json'.length)}`
      try {
        const doc = JSON.parse(readFileSync(join(cacheDir, file), 'utf8')) as {
          record?: { rows?: Record<string, { val?: { title?: string; first?: { text?: string } } | string | null }> }
        }
        const rows = doc.record?.rows ?? {}
        const titleRow = rows.title?.val
        const inputRow = rows.titleInput?.val
        cached.set(sessionId, {
          title: typeof titleRow === 'string' && titleRow.trim() ? titleRow.trim() : undefined,
          first: inputRow && typeof inputRow === 'object' && inputRow.first?.text ? inputRow.first.text : undefined,
          at: statSync(join(cacheDir, file)).mtimeMs,
        })
      } catch {
        // one unreadable cache file must not sink the catalog
      }
    }
  } catch {
    // no cache yet — titles fall back to the projection-less path
  }

  const live = (ctx as Context & { agents?: { get?: (id: string) => { status?: string } | undefined } }).agents
  const sessionsById = new Map<string, SessionRow>()
  const workspaces: WorkspaceRow[] = []
  for (const id of order) {
    const row = table[id]
    if (!row) continue
    const workspaceId = String(id)
    const sessionIds = (row.sessionIds ?? []).map(String)
    for (const sessionId of sessionIds) {
      const hit = cached.get(sessionId)
      let running = false
      try {
        running = live?.get?.(sessionId)?.status === 'running'
      } catch {
        running = false
      }
      sessionsById.set(sessionId, {
        sessionId,
        title: titleOf({
          sessionId,
          cwd: row.path,
          updatedAt: hit?.at,
          projections: {
            values: {
              title: hit?.title ?? null,
              titleInput: hit?.first ? { first: { text: hit.first } } : null,
            },
          },
        }),
        named: Boolean(hit?.title || hit?.first),
        cwd: row.path,
        blank: false,
        running,
        updatedAt: hit?.at ?? 0,
      })
    }
    workspaces.push({
      id: workspaceId,
      title: row.title || workspaceName(row.path) || workspaceId,
      path: row.path ?? '',
      sessionIds,
    })
  }
  if (workspaces.length === 0) {
    debugLog('loadCatalogFromDisk: no workspaces in the registry file')
    return undefined
  }
  debugLog(`loadCatalogFromDisk: ok workspaces=${workspaces.length} sessions=${sessionsById.size} archived=${archivedIds.size}`)
  return { workspaces, sessionsById, archivedIds, complete: true }
}

/** Load workspaces + sessions aligned with Web UI (via apiProxy when available). */
export async function loadCatalog(ctx: Context): Promise<CatalogSnapshot | undefined> {
  const api = resolveApiProxy(ctx)

  const wsPromise = rpcCall(api?.workspace?.list, {})
  const sessPromise = rpcCall(api?.sessions?.list, {})
  // No apiProxy (dsh >= 0.2) → read the same data from host services.
  if (!wsPromise || !sessPromise) {
    debugLog(`loadCatalog: apiProxy unavailable (workspace.list=${typeof api?.workspace?.list}, sessions.list=${typeof api?.sessions?.list}) → host services`)
    const viaHost = await loadCatalogFromHost(ctx)
    if (viaHost) return viaHost
    debugLog('loadCatalog: host services gave nothing → disk store')
    return loadCatalogFromDisk(ctx)
  }

  const [wsRaw, sessRaw] = await Promise.all([wsPromise, sessPromise])
  const wsVal = unwrap<{
    items: Array<{ workspaceId: string; path: string; title: string; sessionIds: string[] }>
    archivedSessionIds: string[]
  }>(wsRaw)
  const sessVal = unwrap<{
    items: Array<{
      sessionId: string
      updatedAt: number
      running: boolean
      blank: boolean
      origin?: string
      cwd?: string
      /** Present on newer hosts; archived sessions must never reach the picker. */
      archived?: boolean
      archivedAt?: number | string | null
      projections?: { values?: { title?: string | null } }
    }>
    /** Some builds echo the archive list with the session listing too. */
    archivedSessionIds?: string[]
  }>(sessRaw)

  if (!wsVal || !sessVal) return undefined

  const archivedIds = new Set<string>()
  for (const id of wsVal.archivedSessionIds ?? []) archivedIds.add(String(id))
  for (const id of sessVal.archivedSessionIds ?? []) archivedIds.add(String(id))
  for (const item of sessVal.items ?? []) {
    if (item.archived === true || item.archivedAt) archivedIds.add(String(item.sessionId))
  }
  const sessionsById = new Map<string, SessionRow>()
  for (const item of sessVal.items ?? []) {
    const sessionId = String(item.sessionId)
    sessionsById.set(sessionId, {
      sessionId,
      title: titleOf({ ...item, sessionId }),
      named: projectionTitle({ ...item, sessionId }) !== undefined,
      cwd: item.cwd,
      blank: Boolean(item.blank),
      running: Boolean(item.running),
      origin: item.origin,
      archived: item.archived === true || Boolean(item.archivedAt),
      updatedAt: Number(item.updatedAt) || 0,
    })
  }

  const workspaces: WorkspaceRow[] = (wsVal.items ?? []).map((w) => ({
    id: String(w.workspaceId),
    title: w.title || workspaceName(w.path) || String(w.workspaceId),
    path: w.path,
    sessionIds: (w.sessionIds ?? []).map(String),
  }))

  return { workspaces, sessionsById, archivedIds, complete: true }
}

/** Sessions visible under one workspace (Web-like filters). */
export function visibleSessionsForWorkspace(
  catalog: CatalogSnapshot,
  workspace: WorkspaceRow,
): SessionRow[] {
  const rows: SessionRow[] = []
  for (const id of workspace.sessionIds) {
    if (isArchived(catalog.archivedIds, id)) continue
    const row = catalog.sessionsById.get(id)
    if (!row) continue
    if (row.archived) continue
    if (row.origin === 'subagent') continue
    if (row.blank) continue
    rows.push(row)
  }
  return rows
}

export function workspacesWithVisibleSessions(catalog: CatalogSnapshot): WorkspaceRow[] {
  return catalog.workspaces.filter((w) => visibleSessionsForWorkspace(catalog, w).length > 0)
}

export function truncateButton(text: string, max = 64): string {
  const chars = [...text]
  if (chars.length <= max) return text
  return `${chars.slice(0, max - 1).join('')}…`
}

/** Fallback when apiProxy is unavailable: group live agents by cwd. */
export function catalogFromLiveAgents(agents: Agent[], ctx?: Context): CatalogSnapshot {
  const sessionsById = new Map<string, SessionRow>()
  const byPath = new Map<string, { title: string; path: string; sessionIds: string[] }>()

  agents.forEach((agent, index) => {
    const parts = describeAgent(agent, index, ctx)
    const sessionId = parts.sessionId
    const cwd = parts.cwd ?? '(неизвестно)'
    sessionsById.set(sessionId, {
      sessionId,
      title: parts.title || parts.workspace || sessionId,
      cwd: parts.cwd,
      blank: false,
      running: true,
      updatedAt: Date.now() - index,
    })
    const bucket = byPath.get(cwd) ?? {
      title: parts.workspace || cwd,
      path: cwd,
      sessionIds: [],
    }
    bucket.sessionIds.push(sessionId)
    byPath.set(cwd, bucket)
  })

  const workspaces: WorkspaceRow[] = [...byPath.entries()].map(([path, bucket], i) => ({
    id: `live:${i}`,
    title: bucket.title,
    path,
    sessionIds: bucket.sessionIds,
  }))

  return { workspaces, sessionsById, archivedIds: new Set(), complete: false }
}

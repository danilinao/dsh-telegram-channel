import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveApiProxy } from './apiproxy.js';
import { describeAgent, workspaceName } from './label.js';
function rpcCall(fn, payload) {
    if (typeof fn !== 'function')
        return undefined;
    return fn({ rpcId: randomUUID(), payload });
}
function unwrap(res) {
    const r = res;
    if (r?.result && r.result.ok === true) {
        return r.result.value;
    }
    // Some wrappers may return value directly
    if (res && typeof res === 'object' && 'items' in res)
        return res;
    return undefined;
}
/** `session-<uuid>` and `<uuid>` name the same session; compare the bare id. */
export function normalizeSessionId(sessionId) {
    const id = String(sessionId);
    return id.startsWith('session-') ? id.slice('session-'.length) : id;
}
/** Is this session archived? Accepts both id spellings, like the Web UI does. */
export function isArchived(archivedIds, sessionId) {
    const bare = normalizeSessionId(sessionId);
    return archivedIds.has(sessionId) || archivedIds.has(bare) || archivedIds.has(`session-${bare}`);
}
/** `21.10 14:05` in local time — keeps untitled sessions distinguishable. */
function shortWhen(ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return undefined;
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/**
 * Session name for buttons/pickers. The Web title wins; when DSH has not
 * generated one, fall back to `workspace · date` (never a bare number).
 */
/** Name straight out of DSH projections: the title, else the first user message. */
function projectionTitle(summary) {
    const t = summary.projections?.values?.title;
    if (typeof t === 'string' && t.trim())
        return t.trim();
    const firstText = summary.projections?.values?.titleInput?.first?.text;
    if (typeof firstText === 'string' && firstText.trim()) {
        const flat = firstText.replace(/\s+/g, ' ').trim();
        const chars = [...flat];
        return chars.length > 60 ? `${chars.slice(0, 59).join('')}…` : flat;
    }
    return undefined;
}
/**
 * Diagnostics land in a file: the cordis logger does not reach the journal, so
 * a silent fallback would otherwise be invisible.
 */
export function debugLog(line) {
    try {
        const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
        const file = join(home, 'telegram-channel-debug.log');
        try {
            if (statSync(file).size > 256_000)
                return;
        }
        catch {
            mkdirSync(join(file, '..'), { recursive: true });
        }
        appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    }
    catch {
        // diagnostics must never break the bot
    }
}
/**
 * Read a host service through every route cordis offers: strict `get`, loose
 * `get(name, false)` (returns services whose providing fiber is not ACTIVE),
 * the plain property, and the root context.
 */
export function hostService(ctx, name) {
    const reader = ctx;
    const attempts = [
        ['get', () => (typeof reader.get === 'function' ? reader.get.call(ctx, name) : undefined)],
        ['get-loose', () => (typeof reader.get === 'function' ? reader.get.call(ctx, name, false) : undefined)],
        ['property', () => reader[name]],
        ['root-get-loose', () => {
                const root = reader.root;
                return typeof root?.get === 'function' ? root.get.call(root, name, false) : undefined;
            }],
    ];
    for (const [label, read] of attempts) {
        let value;
        try {
            value = read();
        }
        catch (err) {
            debugLog(`hostService ${name} [${label}]: threw ${String(err)}`);
            continue;
        }
        if (value !== undefined && value !== null) {
            debugLog(`hostService ${name} [${label}]: ok`);
            return value;
        }
        debugLog(`hostService ${name} [${label}]: undefined`);
    }
    return undefined;
}
function hostServices(ctx) {
    return {
        sessionController: hostService(ctx, 'sessionController'),
        workspaceRegistry: hostService(ctx, 'workspaceRegistry'),
    };
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
async function loadCatalogFromHost(ctx) {
    const { sessionController, workspaceRegistry } = hostServices(ctx);
    const listSessions = sessionController?.list;
    const listWorkspaces = workspaceRegistry?.list;
    debugLog(`loadCatalogFromHost: sessionController=${sessionController ? 'yes' : 'no'} list=${typeof listSessions} ` +
        `workspaceRegistry=${workspaceRegistry ? 'yes' : 'no'} list=${typeof listWorkspaces}`);
    if (typeof listSessions !== 'function' || typeof listWorkspaces !== 'function')
        return undefined;
    let items;
    let registry;
    try {
        items = await listSessions.call(sessionController);
        registry = listWorkspaces.call(workspaceRegistry);
    }
    catch (err) {
        debugLog(`loadCatalogFromHost: list() threw ${String(err)}`);
        return undefined;
    }
    if (!Array.isArray(items) || !Array.isArray(registry)) {
        debugLog(`loadCatalogFromHost: unexpected shapes items=${typeof items} registry=${typeof registry}`);
        return undefined;
    }
    const archivedIds = new Set();
    for (const id of workspaceRegistry?.archivedSessionIds ?? [])
        archivedIds.add(String(id));
    const sessionsById = new Map();
    for (const item of items) {
        const sessionId = String(item.sessionId);
        if (!sessionId)
            continue;
        sessionsById.set(sessionId, {
            sessionId,
            title: titleOf({ ...item, sessionId, updatedAt: Number(item.updatedAt) || 0 }),
            named: projectionTitle({ projections: item.projections }) !== undefined,
            cwd: item.cwd,
            blank: Boolean(item.blank),
            running: Boolean(item.running),
            origin: item.origin,
            updatedAt: Number(item.updatedAt) || 0,
        });
    }
    const workspaces = registry.map((w) => ({
        id: String(w.id),
        title: w.title || workspaceName(w.path) || String(w.id),
        path: w.path,
        sessionIds: (w.sessionIds ?? []).map(String),
    }));
    debugLog(`loadCatalogFromHost: ok sessions=${items.length} workspaces=${registry.length} archived=${archivedIds.size}`);
    return { workspaces, sessionsById, archivedIds, complete: true };
}
/** `sessionController.projections` — the 0.2.x way to name a cold session. */
async function resolveSessionTitleFromHost(ctx, sessionId) {
    const controller = hostServices(ctx).sessionController;
    const call = controller?.projections;
    if (typeof call !== 'function')
        return undefined;
    try {
        const block = await call.call(controller, { sessionId });
        if (!block)
            return undefined;
        return projectionTitle({ projections: block });
    }
    catch {
        return undefined;
    }
}
/**
 * Ask the host for one session's projections. Cold sessions often arrive in
 * `sessions.list` without a projection block, so this is what puts a real name
 * on a picker button instead of a date.
 */
export async function resolveSessionTitle(ctx, sessionId) {
    const api = resolveApiProxy(ctx);
    const call = api?.sessions?.projections;
    if (typeof call !== 'function')
        return await resolveSessionTitleFromHost(ctx, sessionId);
    try {
        const raw = await call({ rpcId: randomUUID(), payload: { sessionId } });
        const value = unwrap(raw);
        if (!value)
            return await resolveSessionTitleFromHost(ctx, sessionId);
        return projectionTitle({ projections: value }) ?? await resolveSessionTitleFromHost(ctx, sessionId);
    }
    catch {
        return await resolveSessionTitleFromHost(ctx, sessionId);
    }
}
function titleOf(summary) {
    const fromHost = projectionTitle(summary);
    if (fromHost)
        return fromHost;
    const ws = workspaceName(summary.cwd);
    const when = shortWhen(Number(summary.updatedAt) || 0);
    if (ws && when)
        return `${ws} · ${when}`;
    if (ws)
        return ws;
    const id = String(summary.sessionId);
    const tail = id.length > 12 ? `…${id.slice(-12)}` : id;
    return when ? `${when} · ${tail}` : tail;
}
/** Load workspaces + sessions aligned with Web UI (via apiProxy when available). */
export async function loadCatalog(ctx) {
    const api = resolveApiProxy(ctx);
    const wsPromise = rpcCall(api?.workspace?.list, {});
    const sessPromise = rpcCall(api?.sessions?.list, {});
    // No apiProxy (dsh >= 0.2) → read the same data from host services.
    if (!wsPromise || !sessPromise) {
        debugLog(`loadCatalog: apiProxy unavailable (workspace.list=${typeof api?.workspace?.list}, sessions.list=${typeof api?.sessions?.list}) → host services`);
        return loadCatalogFromHost(ctx);
    }
    const [wsRaw, sessRaw] = await Promise.all([wsPromise, sessPromise]);
    const wsVal = unwrap(wsRaw);
    const sessVal = unwrap(sessRaw);
    if (!wsVal || !sessVal)
        return undefined;
    const archivedIds = new Set();
    for (const id of wsVal.archivedSessionIds ?? [])
        archivedIds.add(String(id));
    for (const id of sessVal.archivedSessionIds ?? [])
        archivedIds.add(String(id));
    for (const item of sessVal.items ?? []) {
        if (item.archived === true || item.archivedAt)
            archivedIds.add(String(item.sessionId));
    }
    const sessionsById = new Map();
    for (const item of sessVal.items ?? []) {
        const sessionId = String(item.sessionId);
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
        });
    }
    const workspaces = (wsVal.items ?? []).map((w) => ({
        id: String(w.workspaceId),
        title: w.title || workspaceName(w.path) || String(w.workspaceId),
        path: w.path,
        sessionIds: (w.sessionIds ?? []).map(String),
    }));
    return { workspaces, sessionsById, archivedIds, complete: true };
}
/** Sessions visible under one workspace (Web-like filters). */
export function visibleSessionsForWorkspace(catalog, workspace) {
    const rows = [];
    for (const id of workspace.sessionIds) {
        if (isArchived(catalog.archivedIds, id))
            continue;
        const row = catalog.sessionsById.get(id);
        if (!row)
            continue;
        if (row.archived)
            continue;
        if (row.origin === 'subagent')
            continue;
        if (row.blank)
            continue;
        rows.push(row);
    }
    return rows;
}
export function workspacesWithVisibleSessions(catalog) {
    return catalog.workspaces.filter((w) => visibleSessionsForWorkspace(catalog, w).length > 0);
}
export function truncateButton(text, max = 64) {
    const chars = [...text];
    if (chars.length <= max)
        return text;
    return `${chars.slice(0, max - 1).join('')}…`;
}
/** Fallback when apiProxy is unavailable: group live agents by cwd. */
export function catalogFromLiveAgents(agents, ctx) {
    const sessionsById = new Map();
    const byPath = new Map();
    agents.forEach((agent, index) => {
        const parts = describeAgent(agent, index, ctx);
        const sessionId = parts.sessionId;
        const cwd = parts.cwd ?? '(неизвестно)';
        sessionsById.set(sessionId, {
            sessionId,
            title: parts.title || parts.workspace || sessionId,
            cwd: parts.cwd,
            blank: false,
            running: true,
            updatedAt: Date.now() - index,
        });
        const bucket = byPath.get(cwd) ?? {
            title: parts.workspace || cwd,
            path: cwd,
            sessionIds: [],
        };
        bucket.sessionIds.push(sessionId);
        byPath.set(cwd, bucket);
    });
    const workspaces = [...byPath.entries()].map(([path, bucket], i) => ({
        id: `live:${i}`,
        title: bucket.title,
        path,
        sessionIds: bucket.sessionIds,
    }));
    return { workspaces, sessionsById, archivedIds: new Set(), complete: false };
}

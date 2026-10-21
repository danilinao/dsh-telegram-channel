import { randomUUID } from 'node:crypto';
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
 * Ask the host for one session's projections. Cold sessions often arrive in
 * `sessions.list` without a projection block, so this is what puts a real name
 * on a picker button instead of a date.
 */
export async function resolveSessionTitle(ctx, sessionId) {
    const api = resolveApiProxy(ctx);
    const call = api?.sessions?.projections;
    if (typeof call !== 'function')
        return undefined;
    try {
        const raw = await call({ rpcId: randomUUID(), payload: { sessionId } });
        const value = unwrap(raw);
        if (!value)
            return undefined;
        return projectionTitle({ projections: { values: value.values } });
    }
    catch {
        return undefined;
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
    if (!wsPromise || !sessPromise)
        return undefined;
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

import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
export interface WorkspaceRow {
    id: string;
    title: string;
    path: string;
    sessionIds: string[];
}
export interface SessionRow {
    sessionId: string;
    title: string;
    cwd?: string;
    blank: boolean;
    running: boolean;
    origin?: string;
    /** DSH marks a session archived; the picker must hide it. */
    archived?: boolean;
    /** true when the name came from DSH projections, false for a local fallback. */
    named?: boolean;
    updatedAt: number;
}
export interface CatalogSnapshot {
    workspaces: WorkspaceRow[];
    sessionsById: Map<string, SessionRow>;
    archivedIds: Set<string>;
    /** true when loaded from apiProxy (Web-aligned); false for live-agent fallback. */
    complete: boolean;
}
/** `session-<uuid>` and `<uuid>` name the same session; compare the bare id. */
export declare function normalizeSessionId(sessionId: string): string;
/** Is this session archived? Accepts both id spellings, like the Web UI does. */
export declare function isArchived(archivedIds: Set<string>, sessionId: string): boolean;
/** `21.10 14:05` in local time — keeps untitled sessions distinguishable. */
export declare function shortWhen(ms: number): string | undefined;
/**
 * Locate a session log file. Some stores name the directory `<uuid>`, others
 * `session-<uuid>`, so both spellings are probed — this was why half the
 * Synthriders rows had no recoverable name.
 */
export declare function sessionLogFile(sessionId: string, cwd?: string): string | undefined;
interface LogInfo {
    title?: string;
    /** false when the log carries no user message at all — a blank session. */
    hasUserMessage: boolean;
    mtime?: number;
}
/**
 * Recover a session name from its log on disk. Cold sessions have no
 * projections, so this is what turns "Synthriders" (the project) into the real
 * first message of each session.
 */
export declare function sessionLogInfo(sessionId: string, cwd?: string): LogInfo;
export declare function readTitleFromSessionLog(sessionId: string, cwd?: string): string | undefined;
/**
 * Diagnostics land in a file: the cordis logger does not reach the journal, so
 * a silent fallback would otherwise be invisible.
 */
export declare function debugLog(line: string): void;
/**
 * Read a host service through every route cordis offers: strict `get`, loose
 * `get(name, false)` (returns services whose providing fiber is not ACTIVE),
 * the plain property, and the root context. Each attempt is logged, so a
 * fallback is explainable after the fact instead of silent.
 */
export declare function hostService<T>(ctx: Context, name: string): T | undefined;
/**
 * Ask the host for one session's projections. Cold sessions often arrive in
 * `sessions.list` without a projection block, so this is what puts a real name
 * on a picker button instead of a date.
 */
export declare function resolveSessionTitle(ctx: Context, sessionId: string, cwd?: string): Promise<string | undefined>;
/**
 * Catalog read straight from the DSH store on disk.
 *
 * Last resort on purpose: it needs no host service, so "покажи все проекты"
 * keeps working even when the service surface changes between DSH versions.
 * Sources: `storages/workspace.json` (registry order, titles, session ids and
 * the archive set) + `storages/session_projcache/sessions/*.json` (cached
 * titles / first messages).
 */
export declare function loadCatalogFromDisk(ctx: Context): CatalogSnapshot | undefined;
/** Load workspaces + sessions aligned with Web UI (via apiProxy when available). */
export declare function loadCatalog(ctx: Context): Promise<CatalogSnapshot | undefined>;
/** Sessions visible under one workspace (Web-like filters). */
export declare function visibleSessionsForWorkspace(catalog: CatalogSnapshot, workspace: WorkspaceRow): SessionRow[];
export declare function workspacesWithVisibleSessions(catalog: CatalogSnapshot): WorkspaceRow[];
export declare function truncateButton(text: string, max?: number): string;
/** Fallback when apiProxy is unavailable: group live agents by cwd. */
export declare function catalogFromLiveAgents(agents: Agent[], ctx?: Context): CatalogSnapshot;
export {};

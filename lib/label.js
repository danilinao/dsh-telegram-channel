const BUTTON_MAX = 64;
export function readSessionCwd(session) {
    const s = session;
    const cwd = s?.header?.cwd ?? s?.meta?.cwd;
    if (typeof cwd !== 'string')
        return undefined;
    const trimmed = cwd.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}
export function workspaceName(cwd) {
    if (!cwd)
        return undefined;
    const parts = cwd.split(/[/\\]/).filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : undefined;
}
export function readSessionTitle(ctx, session) {
    if (!session)
        return undefined;
    try {
        const svc = ctx
            ?.sessionTitle;
        const snap = svc?.get?.(session);
        if (snap?.title && String(snap.title).trim())
            return String(snap.title).trim();
    }
    catch {
        // optional service
    }
    try {
        const projections = ctx?.sessionProjections;
        const projected = projections?.get?.(session, 'title');
        if (typeof projected === 'string' && projected.trim())
            return projected.trim();
    }
    catch {
        // optional service
    }
    const events = session.events;
    if (Array.isArray(events)) {
        for (let i = events.length - 1; i >= 0; i -= 1) {
            const ev = events[i];
            if (ev?.type === 'session/title' && typeof ev.data?.title === 'string') {
                const t = ev.data.title.trim();
                if (t)
                    return t;
            }
        }
    }
    return undefined;
}
export function describeAgent(agent, index, ctx) {
    const sessionId = String(agent.id);
    const idTail = sessionId.length > 12 ? sessionId.slice(-12) : sessionId;
    const cwd = readSessionCwd(agent.session);
    const title = readSessionTitle(ctx, agent.session);
    return {
        index,
        title,
        cwd,
        workspace: workspaceName(cwd),
        idTail,
        sessionId,
    };
}
/** Compact label for inline keyboard buttons (Telegram ≤64 chars). */
export function buttonLabel(parts) {
    const n = parts.index + 1;
    const primary = parts.title || parts.workspace || `сессия ${n}`;
    let text = `${n}. ${primary}`;
    if (parts.title && parts.workspace) {
        const withWs = `${n}. ${parts.title} · ${parts.workspace}`;
        if ([...withWs].length <= BUTTON_MAX)
            text = withWs;
    }
    if ([...text].length <= BUTTON_MAX)
        return text;
    const chars = [...text];
    return `${chars.slice(0, BUTTON_MAX - 1).join('')}…`;
}
/** Multi-line detail block for the picker message body. */
export function detailLines(parts) {
    const lines = [`${parts.index + 1}. ${parts.title ?? '(без названия)'}`];
    if (parts.cwd) {
        lines.push(`   рабочая область: ${parts.cwd}`);
    }
    else if (parts.workspace) {
        lines.push(`   рабочая область: ${parts.workspace}`);
    }
    else {
        lines.push('   рабочая область: (неизвестно)');
    }
    lines.push(`   ID: …${parts.idTail}`);
    return lines.join('\n');
}
/** Human label stored on bind / status (not length-capped as hard as buttons). */
export function displayLabel(parts) {
    const bits = [];
    if (parts.title)
        bits.push(parts.title);
    if (parts.workspace)
        bits.push(parts.workspace);
    if (bits.length === 0)
        bits.push(`сессия ${parts.index + 1}`);
    bits.push(`…${parts.idTail}`);
    const text = bits.join(' · ');
    return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

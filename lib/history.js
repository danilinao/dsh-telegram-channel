import { randomUUID } from 'node:crypto';
import { resolveApiProxy } from './apiproxy.js';
function unwrap(res) {
    const r = res;
    if (r?.result?.ok === true)
        return r.result.value;
    return undefined;
}
function contentToText(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
        .trim();
}
/** Extract the latest human Q + assistant A from a session event list. */
export function extractLastTurn(events) {
    let lastUser;
    let lastAssistant;
    for (const ev of events) {
        if (ev.type === 'user/message') {
            const sourceKind = ev.data?.source?.kind ?? ev.data?.message?.source?.kind;
            // Prefer real human prompts; skip plugin-injected context noise.
            if (sourceKind && sourceKind !== 'user')
                continue;
            const text = contentToText(ev.data?.content ?? ev.data?.message?.content);
            if (text) {
                lastUser = text;
                // New user turn resets prior assistant for pairing.
                lastAssistant = undefined;
            }
            continue;
        }
        if (ev.type === 'assistant/message') {
            const text = contentToText(ev.data?.message?.content ?? ev.data?.content);
            if (text)
                lastAssistant = text;
            continue;
        }
        if (ev.type === 'compaction/summary') {
            const text = typeof ev.data?.text === 'string' ? ev.data.text.trim() : '';
            if (text && !lastAssistant)
                lastAssistant = `(сводка) ${text}`;
        }
    }
    return { userText: lastUser, assistantText: lastAssistant };
}
export function formatLastTurn(turn, maxEach = 3500) {
    if (!turn.userText && !turn.assistantText) {
        return 'Прошлых вопросов нет (сессия пуста или не было ходов пользователя).';
    }
    const clip = (s) => {
        const chars = [...s];
        if (chars.length <= maxEach)
            return s;
        return `${chars.slice(0, maxEach - 1).join('')}…`;
    };
    const parts = ['— прошлый диалог —'];
    if (turn.userText) {
        parts.push('', '【Вы】', clip(turn.userText));
    }
    if (turn.assistantText) {
        parts.push('', '【Ассистент】', clip(turn.assistantText));
    }
    return parts.join('\n');
}
async function historyViaApi(ctx, sessionId) {
    const api = resolveApiProxy(ctx);
    const history = api?.sessions?.history;
    if (typeof history !== 'function')
        return undefined;
    const raw = await history({
        rpcId: randomUUID(),
        payload: { sessionId, maxMessages: 8 },
    });
    const value = unwrap(raw);
    if (!value?.events)
        return undefined;
    return value.events.map((entry) => {
        if (entry && typeof entry === 'object' && 'event' in entry && entry.event) {
            return entry.event;
        }
        return entry;
    });
}
function historyViaAgent(agent) {
    const events = agent?.session?.events;
    if (!events || events.length === 0)
        return undefined;
    return [...events];
}
/** Load last Q/A for a bound session (apiProxy history, else live agent events). */
export async function loadLastTurn(ctx, sessionId, agent) {
    let events;
    try {
        events = await historyViaApi(ctx, sessionId);
    }
    catch {
        events = undefined;
    }
    if (!events || events.length === 0) {
        events = historyViaAgent(agent);
    }
    if (!events || events.length === 0)
        return {};
    return extractLastTurn(events);
}

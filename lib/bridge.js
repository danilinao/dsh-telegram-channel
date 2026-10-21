import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { isAuthorized } from './auth.js';
import { resolveApiProxy } from './apiproxy.js';
import { catalogFromLiveAgents, loadCatalog, resolveSessionTitle, truncateButton, visibleSessionsForWorkspace, workspacesWithVisibleSessions, } from './catalog.js';
import { TelegramClient, } from './client.js';
import { MSG, LAST_CB, parseCommand } from './commands.js';
import { markdownToHtml, splitMessage } from './format.js';
import { splitRichMarkdown } from './rich-format.js';
import { formatLastTurn, loadLastTurn } from './history.js';
import { describeAgent, displayLabel, workspaceName } from './label.js';
import { formatModel, loadSessionModels, selectSessionModel, } from './models.js';
import { formatStatusText, } from './status.js';
/** Host-admitted raster media types (@deepseek-ai/dsh-attachment). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Album debounce window: TG emits each photo of an album as its own update. */
const MEDIA_GROUP_WINDOW_MS = 1200;
/**
 * 把 command-compact 返回的英文结果翻译成 TG 中文回复。
 * 文案以宿主 @deepseek-ai/dsh-command-compact 的固定输出为准；无法识别时返回
 * undefined，由调用方回退为「压缩失败 + 原文详情」。
 */
function translateCompactResult(result) {
    const kind = result?.kind;
    const text = result?.text ?? '';
    if (kind === 'success') {
        const m = /Compacted (\d+) history items \(~(\d+) tokens\)/.exec(text);
        if (m)
            return MSG.COMPACT_DONE(Number(m[1]), Number(m[2]));
        if (/No compactable history yet/.test(text))
            return MSG.COMPACT_NOTHING;
        return undefined;
    }
    if (kind === 'error') {
        if (/active compaction|not idle/.test(text))
            return MSG.COMPACT_BUSY;
        if (/^Compaction cancelled/.test(text))
            return MSG.COMPACT_CANCELLED;
        if (/history selected for compaction changed/.test(text))
            return MSG.COMPACT_CHANGED;
        if (/could not produce a useful summary/.test(text))
            return MSG.COMPACT_SUMMARY_FAILED;
        if (/did not finish cleanly/.test(text))
            return MSG.COMPACT_COMMIT_FAILED;
        if (/could not be saved/.test(text))
            return MSG.COMPACT_PERSIST_FAILED;
        return undefined;
    }
    return undefined;
}
const WS_CB = 'ws:';
const SID_CB = 'sid:';
const BACK_WS_CB = 'wb';
const MODEL_CB = 'mdl:';
/** Use eff: (not me:) — short prefix, no collision with other callbacks. */
const EFFORT_CB = 'eff:';
const BACK_MODEL_CB = 'mb';
const MAX_BUTTONS = 40;
function lastContextKeyboard() {
    return {
        inline_keyboard: [[{ text: 'Последний диалог', callback_data: LAST_CB }]],
    };
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function contentToText(content) {
    return content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
}
function isRichUnsupportedError(err) {
    const message = err instanceof Error ? err.message : String(err);
    return /method not found|unknown method|not found|404|bad request|can't parse|rich message/i.test(message);
}
function isNoQuestionAnswererError(err) {
    const message = err instanceof Error
        ? err.message
        : String(err?.message ?? err);
    return /NO_PROVIDER|no user-questions answerer/i.test(message);
}
export class TelegramBridge {
    ctx;
    token;
    allowedUserIds;
    allowAllUsers;
    client;
    sleep;
    maxMessageLength;
    /** Global rendering mode: follows config; flipped to 'html' permanently when the
     *  Rich Message API itself is unavailable (a server-wide fact, not per-chat). */
    renderingMode;
    /** Per-chat rendering override (persisted): rich messages need a recent Telegram
     *  client — old ones (e.g. 10.x) cannot render them and show “unsupported”. */
    renderPrefs = new Map();
    bindings = new Map();
    pickers = new Map();
    /** Session names fetched from host projections, keyed by id and updatedAt. */
    titleCache = new Map();
    /** chatId → model awaiting reasoning-effort pick (kept outside picker so list refreshes won't drop it). */
    pendingModels = new Map();
    polling = false;
    offset;
    pollPromise;
    pollAbort;
    disposeSessionListener;
    disposeQuestionHook;
    // ── Stability & interactivity additions ──
    /** sessionIds mid-turn (busy feedback, /stop state) */
    busySessions = new Set();
    /** chatId → typing heartbeat interval handle */
    heartbeats = new Map();
    /** chatId → serialized notice chain (prevents 429 storms) */
    noticeQueue = new Map();
    pendingAsks = new Map();
    pendingApprovalsTG = new Map();
    disposeApprovalHook;
    /** sessionId → thinking indicator state (one notice per reasoning phase) */
    thinkingSessions = new Map();
    /** callId → tool name (tool/result failure notices) */
    callNames = new Map();
    /** sessionId → latest todo snapshot (/mission) */
    lastTodos = new Map();
    /** sessionId → in-flight manual compaction (dedup /compact) */
    compacting = new Set();
    /** sessionId → compaction abort controller (cancelled on bridge stop) */
    compactAborts = new Map();
    /** Album accumulation: chatId:media_group_id → parts buffered into one prompt. */
    mediaGroups = new Map();
    constructor(ctx, options) {
        this.ctx = ctx;
        this.token = options.token;
        this.allowedUserIds = options.allowedUserIds;
        this.allowAllUsers = options.allowAllUsers;
        this.client = options.client ?? new TelegramClient(options.token, {
            pollingTimeoutSec: options.pollingTimeoutSec ?? 30,
        });
        this.sleep = options.sleep ?? defaultSleep;
        this.maxMessageLength = options.maxMessageLength ?? 4096;
        // Compat-first default: only an explicit `rendering: 'rich'` opts into rich
        // messages, because old Telegram clients (10.x) cannot render them at all.
        this.renderingMode = options.rendering === 'rich' ? 'rich' : 'html';
    }
    /** Effective rendering mode for a chat: per-chat override, else the global mode. */
    modeFor(chatId) {
        return this.renderPrefs.get(String(chatId)) ?? this.renderingMode;
    }
    start() {
        this.disposeSessionListener?.();
        this.disposeSessionListener = this.ctx.on('session/event', (session, event) => {
            void this.onSessionEvent(session, event).catch((err) => {
                this.ctx.logger.error(this.redact(err));
            });
        });
        // Restore persisted bindings (survive hot reload / restart) and install
        // the TG answering hooks (ask_user dual-path + approval dual-path).
        this.loadBindings();
        this.disposeQuestionHook?.();
        this.disposeQuestionHook = this.ctx.on('user-questions/request', (request, next) => this.onUserQuestionRequest(request, next));
        this.disposeApprovalHook?.();
        this.disposeApprovalHook = this.ctx.on('approval/request', (req, next) => this.onApprovalRequest(req, next));
        void this.client.setMyCommands([
            { command: 'start', description: 'Приветствие и как пользоваться' },
            { command: 'sessions', description: 'Сессии по рабочим областям и привязка' },
            { command: 'last', description: 'Прошлый вопрос-ответ (контекст)' },
            { command: 'model', description: 'Сменить модель сессии' },
            { command: 'status', description: 'Состояние: модель, контекст, статистика' },
            { command: 'compact', description: 'Сжать историю сессии (сократить контекст)' },
            { command: 'rich', description: 'Рендер: on rich / off HTML (для этого чата)' },
            { command: 'unbind', description: 'Отвязать телефон (сессия остаётся)' },
            { command: 'stop', description: 'Прервать текущую задачу' },
            { command: 'mission', description: 'Список задач и прогресс' },
            { command: 'new', description: 'Новый диалог в этой области и привязка' },
            { command: 'cancel', description: 'Закрыть ответы/подтверждения в TG' },
            { command: 'help', description: 'Помощь' },
        ]).then(() => {
            this.ctx.logger.info('dsh-telegram-channel: bot commands registered');
        }).catch((err) => {
            this.ctx.logger.warn(`dsh-telegram-channel: setMyCommands failed: ${this.redact(err)}`);
        });
        // Bot profile card (what a stranger sees before /start) — empty by default.
        void this.client.setMyShortDescription('Telegram-пульт для DeepSeek Harness: та же сессия, что на компьютере').catch((err) => {
            this.ctx.logger.warn(`dsh-telegram-channel: setMyShortDescription failed: ${this.redact(err)}`);
        });
        void this.client.setMyDescription([
            'Пульт для DeepSeek Harness: телефон подключается к уже идущей сессии на компьютере.',
            'Один диалог, две стороны — Web и Telegram видят одну и ту же переписку.',
            '',
            'Нажмите /sessions, выберите рабочую область и сессию — дальше просто пишите.',
            'Доступ только для пользователей из белого списка.',
        ].join('\n')).catch((err) => {
            this.ctx.logger.warn(`dsh-telegram-channel: setMyDescription failed: ${this.redact(err)}`);
        });
        if (!this.polling) {
            this.polling = true;
            this.pollAbort = new AbortController();
            this.ctx.logger.info('dsh-telegram-channel: long-polling started');
            this.pollPromise = this.pollLoop();
        }
    }
    async stop() {
        this.polling = false;
        this.pollAbort?.abort();
        this.pollAbort = undefined;
        this.disposeSessionListener?.();
        this.disposeSessionListener = undefined;
        this.disposeQuestionHook?.();
        this.disposeQuestionHook = undefined;
        // Never dispose host agents — only clear remote bindings.
        this.bindings.clear();
        this.renderPrefs.clear();
        this.pickers.clear();
        this.pendingModels.clear();
        this.stopAllHeartbeats();
        this.busySessions.clear();
        this.noticeQueue.clear();
        this.pendingAsks.clear();
        this.pendingApprovalsTG.clear();
        this.thinkingSessions.clear();
        this.callNames.clear();
        this.lastTodos.clear();
        for (const controller of this.compactAborts.values())
            controller.abort();
        this.compactAborts.clear();
        this.compacting.clear();
        for (const group of this.mediaGroups.values())
            clearTimeout(group.timer);
        this.mediaGroups.clear();
        this.disposeApprovalHook?.();
        this.disposeApprovalHook = undefined;
        if (this.pollPromise) {
            await this.pollPromise.catch(() => { });
            this.pollPromise = undefined;
        }
    }
    async processUpdate(update) {
        if (update.callback_query) {
            await this.handleCallback(update);
            return;
        }
        const message = update.message;
        if (!message)
            return;
        const chatId = message.chat.id;
        const userId = message.from?.id;
        if (!isAuthorized({ allowAllUsers: this.allowAllUsers, allowedUserIds: this.allowedUserIds, userId })) {
            await this.client.sendMessage(chatId, MSG.DENIED);
            return;
        }
        // Media messages: photos / image documents (optionally with a caption) are
        // admitted into the bound session; other media get an explicit notice.
        // A caption is treated as accompanying text — never parsed as a command.
        const mediaParts = await this.collectMediaParts(chatId, message);
        if (mediaParts !== undefined) {
            if (mediaParts.length > 0) {
                if (message.media_group_id)
                    this.accumulateMediaGroup(chatId, message.media_group_id, mediaParts);
                else
                    await this.sendImageFollowup(chatId, mediaParts);
            }
            return;
        }
        // Non-text messages without recognized media: tell the (authorized) user
        // instead of dropping silently.
        if (!message.text) {
            await this.enqueueNotice(chatId, MSG.MEDIA_UNSUPPORTED);
            return;
        }
        const parsed = parseCommand(message.text);
        switch (parsed.type) {
            case 'start':
                await this.client.sendMessage(chatId, MSG.WELCOME);
                return;
            case 'help':
                await this.client.sendMessage(chatId, MSG.HELP);
                return;
            case 'sessions':
                await this.sendWorkspacePicker(chatId);
                return;
            case 'last':
                await this.sendLastTurn(chatId);
                return;
            case 'model':
                await this.sendModelPicker(chatId);
                return;
            case 'status':
                await this.sendStatus(chatId);
                return;
            case 'compact':
                await this.requestCompact(chatId);
                return;
            case 'rich':
                await this.handleRichCommand(chatId, parsed.arg);
                return;
            case 'unbind':
                this.bindings.delete(String(chatId));
                this.pickers.delete(String(chatId));
                this.pendingAsks.delete(String(chatId));
                this.saveBindings();
                await this.client.sendMessage(chatId, MSG.UNBOUND);
                return;
            case 'stop':
                await this.stopBound(chatId);
                return;
            case 'mission':
                await this.sendMission(chatId);
                return;
            case 'new':
                await this.newSessionHere(chatId);
                return;
            case 'cancel': {
                // /cancel closes the TG-side answer/approval channel; the UI side stays open.
                let cancelled = false;
                if (this.pendingApprovalsTG.delete(String(chatId)))
                    cancelled = true;
                if (this.pendingAsks.delete(String(chatId)))
                    cancelled = true;
                if (cancelled)
                    await this.enqueueNotice(chatId, 'Ответы/подтверждения в Telegram закрыты (в Web вопрос по-прежнему доступен)');
                else
                    await this.client.sendMessage(chatId, 'Сейчас нет вопросов или подтверждений, ждущих ответа');
                return;
            }
            case 'unknown':
                await this.client.sendMessage(chatId, MSG.unknown(parsed.command));
                return;
            case 'plain': {
                // A pending approval/ask on TG consumes the message as an answer.
                const approval = this.pendingApprovalsTG.get(String(chatId));
                if (approval) {
                    await this.handleTgApproval(chatId, approval, parsed.text);
                    return;
                }
                const pending = this.pendingAsks.get(String(chatId));
                if (pending) {
                    await this.handleTgAnswer(chatId, pending, parsed.text);
                    return;
                }
                await this.followupBound(chatId, parsed.text);
                return;
            }
        }
    }
    async handleCallback(update) {
        const cq = update.callback_query;
        const userId = cq.from.id;
        const chatId = cq.message?.chat.id;
        if (chatId === undefined) {
            await this.client.answerCallbackQuery(cq.id);
            return;
        }
        if (!isAuthorized({ allowAllUsers: this.allowAllUsers, allowedUserIds: this.allowedUserIds, userId })) {
            await this.client.answerCallbackQuery(cq.id, MSG.DENIED);
            await this.client.sendMessage(chatId, MSG.DENIED);
            return;
        }
        const data = cq.data ?? '';
        const picker = this.pickers.get(String(chatId));
        if (data === LAST_CB) {
            await this.client.answerCallbackQuery(cq.id);
            await this.sendLastTurn(chatId);
            return;
        }
        if (data === BACK_WS_CB) {
            await this.client.answerCallbackQuery(cq.id);
            await this.sendWorkspacePicker(chatId, picker?.catalog);
            return;
        }
        if (data === BACK_MODEL_CB) {
            await this.client.answerCallbackQuery(cq.id);
            await this.sendModelPicker(chatId);
            return;
        }
        if (data.startsWith(WS_CB)) {
            const index = Number(data.slice(WS_CB.length));
            await this.client.answerCallbackQuery(cq.id);
            await this.sendSessionPicker(chatId, index);
            return;
        }
        if (data.startsWith(SID_CB)) {
            const index = Number(data.slice(SID_CB.length));
            const row = picker?.sessions[index];
            if (!row) {
                await this.client.answerCallbackQuery(cq.id, 'Сессия устарела');
                await this.client.sendMessage(chatId, MSG.PICKER_STALE);
                return;
            }
            await this.bindSession(chatId, cq.id, row);
            return;
        }
        if (data.startsWith(MODEL_CB)) {
            const index = Number(data.slice(MODEL_CB.length));
            const option = picker?.models?.[index];
            if (!option) {
                await this.client.answerCallbackQuery(cq.id, 'Список устарел');
                await this.client.sendMessage(chatId, MSG.PICKER_STALE);
                return;
            }
            const efforts = (option.efforts ?? []).filter((e) => e.id);
            if (efforts.length === 1) {
                // Single effort (often only "off") — apply immediately, no second tap.
                await this.applyModel(chatId, cq.id, { ...option, efforts }, efforts[0].id);
                return;
            }
            if (efforts.length > 1) {
                const pending = { ...option, efforts };
                this.pendingModels.set(String(chatId), pending);
                if (picker)
                    picker.pendingModel = pending;
                await this.client.answerCallbackQuery(cq.id);
                await this.sendEffortPicker(chatId, pending);
                return;
            }
            await this.applyModel(chatId, cq.id, option);
            return;
        }
        if (data.startsWith(EFFORT_CB) || data.startsWith('me:')) {
            // Accept legacy "me:" callbacks from older bot messages.
            const rawIndex = data.startsWith(EFFORT_CB)
                ? data.slice(EFFORT_CB.length)
                : data.slice('me:'.length);
            const index = Number(rawIndex);
            const pending = this.pendingModels.get(String(chatId)) ?? picker?.pendingModel;
            const effort = pending?.efforts?.[index];
            if (!pending || !effort?.id) {
                await this.client.answerCallbackQuery(cq.id, 'Список устарел');
                await this.client.sendMessage(chatId, MSG.PICKER_STALE);
                return;
            }
            await this.applyModel(chatId, cq.id, pending, effort.id);
            return;
        }
        // Legacy bind:<sessionId> callbacks (older messages / tests)
        if (data.startsWith('bind:')) {
            const sessionId = data.slice('bind:'.length);
            await this.bindSession(chatId, cq.id, {
                sessionId,
                title: sessionId,
                blank: false,
                running: true,
                updatedAt: 0,
            });
            return;
        }
        await this.client.answerCallbackQuery(cq.id);
    }
    async resolveCatalog() {
        try {
            const fromApi = await loadCatalog(this.ctx);
            if (fromApi)
                return fromApi;
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: catalog via apiProxy failed: ${this.redact(err)}`);
        }
        return catalogFromLiveAgents(this.liveAgents(), this.ctx);
    }
    async sendWorkspacePicker(chatId, existing) {
        const catalog = existing ?? await this.resolveCatalog();
        const workspaces = workspacesWithVisibleSessions(catalog);
        if (workspaces.length === 0) {
            this.pickers.delete(String(chatId));
            await this.client.sendMessage(chatId, MSG.NO_SESSIONS);
            return;
        }
        const shown = workspaces.slice(0, MAX_BUTTONS);
        this.pickers.set(String(chatId), { workspaces: shown, sessions: [], catalog });
        const keyboard = {
            inline_keyboard: shown.map((ws, i) => ([{
                    text: truncateButton(`${i + 1}. ${ws.title}`),
                    callback_data: `${WS_CB}${i}`,
                }])),
        };
        const body = [
            catalog.complete
                ? `Выберите рабочую область (${workspaces.length}, как в Web, без архива):`
                : `Выберите рабочую область (${workspaces.length}) ⚠️ только запущенные сессии (apiProxy не готов; полный список — плагин ≥0.3.2 и перезапуск dsh web):`,
            '',
            ...shown.map((ws, i) => {
                const n = visibleSessionsForWorkspace(catalog, ws).length;
                return `${i + 1}. ${ws.title}\n   ${ws.path}\n   сессий: ${n}`;
            }),
            workspaces.length > MAX_BUTTONS ? `\nПоказаны первые ${MAX_BUTTONS} рабочих областей.` : '',
            '',
            'Нажмите кнопку ниже, чтобы открыть сессии этой области.',
        ].filter(Boolean).join('\n');
        await this.client.sendMessage(chatId, body, undefined, keyboard);
    }
    /**
     * Button caption for one session: `N. <name> <state>`. The name is the Web
     * session title (the catalog falls back to `workspace · date`).
     * ▶ = live in memory, ▷ = parked (resumed on attach).
     */
    sessionButtonText(row, index) {
        const name = (row.title ?? '').trim() || `сессия …${row.sessionId.slice(-12)}`;
        return `${index + 1}. ${name} ${row.running ? '▶' : '▷'}`;
    }
    /**
     * Fill in real session names for the rows the picker is about to show.
     * `sessions.list` leaves cold sessions without a projection block, so ask
     * the host per session (cached by updatedAt).
     */
    async ensureSessionNames(rows) {
        const pending = rows.filter((row) => !row.named);
        if (pending.length === 0)
            return;
        await Promise.all(pending.map(async (row) => {
            const cached = this.titleCache.get(row.sessionId);
            if (cached && cached.at === row.updatedAt) {
                row.title = cached.title;
                row.named = true;
                return;
            }
            const title = await resolveSessionTitle(this.ctx, row.sessionId);
            if (!title)
                return;
            this.titleCache.set(row.sessionId, { at: row.updatedAt, title });
            row.title = title;
            row.named = true;
        }));
    }
    async sendSessionPicker(chatId, workspaceIndex) {
        const picker = this.pickers.get(String(chatId));
        const catalog = picker?.catalog ?? await this.resolveCatalog();
        const workspaces = picker?.workspaces?.length
            ? picker.workspaces
            : workspacesWithVisibleSessions(catalog);
        const workspace = workspaces[workspaceIndex];
        if (!workspace) {
            await this.client.sendMessage(chatId, MSG.PICKER_STALE);
            return;
        }
        const sessions = visibleSessionsForWorkspace(catalog, workspace)
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt);
        if (sessions.length === 0) {
            await this.client.sendMessage(chatId, MSG.NO_SESSIONS_IN_WS(workspace.title));
            return;
        }
        const shown = sessions.slice(0, MAX_BUTTONS);
        await this.ensureSessionNames(shown);
        this.pickers.set(String(chatId), { workspaces, sessions: shown, catalog });
        const keyboard = {
            inline_keyboard: [
                ...shown.map((row, i) => ([{
                        text: truncateButton(this.sessionButtonText(row, i)),
                        callback_data: `${SID_CB}${i}`,
                    }])),
                [{ text: '← К областям', callback_data: BACK_WS_CB }],
            ],
        };
        const body = [
            `Рабочая область: ${workspace.title}`,
            workspace.path,
            '',
            `Выберите сессию (всего ${sessions.length}):`,
            '',
            ...shown.map((row, i) => {
                const mark = row.running ? 'идёт работа' : 'не запущена';
                return `${i + 1}. ${row.title}\n   ${mark} · …${row.sessionId.slice(-12)}`;
            }),
            sessions.length > MAX_BUTTONS ? `\nПоказаны первые ${MAX_BUTTONS} сессий.` : '',
            '',
            'Нажмите кнопку, чтобы привязать; неактивная сессия поднимется автоматически (Web не закрывается).',
        ].filter(Boolean).join('\n');
        await this.client.sendMessage(chatId, body, undefined, keyboard);
    }
    async bindSession(chatId, callbackId, row) {
        const agent = await this.ensureLiveAgent(row.sessionId);
        if (!agent) {
            await this.client.answerCallbackQuery(callbackId, 'Не удалось привязать');
            await this.client.sendMessage(chatId, MSG.RESUME_FAILED);
            return;
        }
        const parts = describeAgent(agent, 0, this.ctx);
        const label = row.title && row.title !== row.sessionId
            ? displayLabel({ ...parts, title: row.title })
            : displayLabel(parts);
        this.bindings.set(String(chatId), { chatId, sessionId: String(agent.id), label });
        // Drop stale pending asks when rebinding to another session; persist bindings.
        const stale = this.pendingAsks.get(String(chatId));
        if (stale && stale.sessionId !== String(agent.id))
            this.pendingAsks.delete(String(chatId));
        this.saveBindings();
        await this.client.answerCallbackQuery(callbackId, 'Привязано');
        await this.client.sendMessage(chatId, MSG.BOUND(label), undefined, lastContextKeyboard());
    }
    async sendLastTurn(chatId) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        const agent = await this.ensureLiveAgent(binding.sessionId);
        try {
            const turn = await loadLastTurn(this.ctx, binding.sessionId, agent);
            const text = formatLastTurn(turn);
            await this.deliver(chatId, text);
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: /last failed: ${this.redact(err)}`);
            await this.client.sendMessage(chatId, MSG.LAST_FAILED);
        }
    }
    async sendModelPicker(chatId) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        const agent = await this.ensureLiveAgent(binding.sessionId);
        if (!agent) {
            this.bindings.delete(String(chatId));
            await this.client.sendMessage(chatId, MSG.GONE);
            return;
        }
        try {
            const snap = await loadSessionModels(this.ctx, binding.sessionId);
            if (!snap.routable) {
                await this.client.sendMessage(chatId, MSG.MODEL_UNROUTABLE(formatModel(snap.current)));
                return;
            }
            if (snap.options.length === 0) {
                await this.client.sendMessage(chatId, MSG.MODEL_EMPTY(formatModel(snap.current)));
                return;
            }
            const shown = snap.options.slice(0, MAX_BUTTONS);
            const prev = this.pickers.get(String(chatId));
            this.pickers.set(String(chatId), {
                workspaces: prev?.workspaces ?? [],
                sessions: prev?.sessions ?? [],
                catalog: prev?.catalog,
                models: shown,
            });
            const keyboard = {
                inline_keyboard: shown.map((opt, i) => ([{
                        text: truncateButton(`${opt.label}${opt.provider === snap.current.provider && opt.model === snap.current.model ? ' ✓' : ''}`),
                        callback_data: `${MODEL_CB}${i}`,
                    }])),
            };
            const body = [
                `Текущая модель: ${formatModel(snap.current)}`,
                `Сессия: ${binding.label}`,
                '',
                'Выберите модель (действует со следующего хода):',
            ].join('\n');
            await this.client.sendMessage(chatId, body, undefined, keyboard);
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: /model failed: ${this.redact(err)}`);
            const detail = err instanceof Error ? err.message : String(err);
            await this.client.sendMessage(chatId, MSG.MODEL_UNAVAILABLE(detail));
        }
    }
    async sendEffortPicker(chatId, option) {
        const efforts = option.efforts ?? [];
        const keyboard = {
            inline_keyboard: [
                ...efforts.map((e, i) => ([{
                        text: truncateButton(e.name || e.id),
                        callback_data: `${EFFORT_CB}${i}`,
                    }])),
                [{ text: '← К списку моделей', callback_data: BACK_MODEL_CB }],
            ],
        };
        await this.client.sendMessage(chatId, `Выбрано: ${option.label}\nТеперь выберите глубину размышлений:`, undefined, keyboard);
    }
    async applyModel(chatId, callbackId, option, reasoningEffort) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.answerCallbackQuery(callbackId, 'Нет привязки');
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        // Ensure session is live before selectModel (same as followup path).
        await this.ensureLiveAgent(binding.sessionId);
        try {
            const selected = await selectSessionModel(this.ctx, binding.sessionId, {
                provider: option.provider,
                model: option.model,
                reasoningEffort,
            });
            this.pendingModels.delete(String(chatId));
            const picker = this.pickers.get(String(chatId));
            if (picker)
                picker.pendingModel = undefined;
            await this.client.answerCallbackQuery(callbackId, 'Переключено');
            await this.client.sendMessage(chatId, MSG.MODEL_SET(formatModel(selected)));
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: selectModel failed: ${this.redact(err)}`);
            const detail = err instanceof Error ? err.message : String(err);
            await this.client.answerCallbackQuery(callbackId, 'Не удалось переключить');
            await this.client.sendMessage(chatId, MSG.MODEL_FAILED(detail));
        }
    }
    liveAgents() {
        const agents = this.ctx.agents;
        if (typeof agents.roots === 'function') {
            const roots = agents.roots();
            if (roots.length > 0)
                return roots;
        }
        if (typeof agents.list === 'function')
            return agents.list();
        return [];
    }
    findLiveAgent(sessionId) {
        const agents = this.ctx.agents;
        if (typeof agents.get === 'function') {
            try {
                const found = agents.get(SessionId(sessionId));
                if (found)
                    return found;
            }
            catch {
                // fall through to list scan
            }
        }
        return this.liveAgents().find((a) => String(a.id) === sessionId);
    }
    /** Resume cold sessions when needed; never dispose the returned handle. */
    async ensureLiveAgent(sessionId) {
        const live = this.findLiveAgent(sessionId);
        if (live)
            return live;
        const agents = this.ctx.agents;
        if (typeof agents.resume !== 'function')
            return undefined;
        try {
            const handle = await agents.resume({ resumeSessionId: SessionId(sessionId) });
            return handle.agent;
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: resume failed for ${sessionId}: ${this.redact(err)}`);
            return undefined;
        }
    }
    async sendStatus(chatId) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.STATUS_NONE);
            return;
        }
        const info = {
            label: binding.label,
            sessionId: binding.sessionId,
        };
        // 冷会话：不强制 resume（只读查询），给出可用的绑定/工作区信息即可。
        const agent = this.findLiveAgent(binding.sessionId);
        if (!agent) {
            info.live = false;
            info.workspace = await this.workspaceOf(binding.sessionId, undefined);
            await this.client.sendMessage(chatId, formatStatusText(info));
            return;
        }
        info.live = true;
        info.workspace = await this.workspaceOf(binding.sessionId, agent);
        try {
            const snap = await loadSessionModels(this.ctx, binding.sessionId);
            if (snap.current) {
                info.model = {
                    provider: snap.current.provider,
                    model: snap.current.model,
                    reasoningEffort: snap.current.reasoningEffort,
                };
            }
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: /status model read failed: ${this.redact(err)}`);
        }
        info.runtime = this.readRuntimeValues(agent);
        await this.client.sendMessage(chatId, formatStatusText(info));
    }
    /** 按 sessionId 解析工作区：apiProxy 目录优先，冷/热会话均可用；退化为 agent cwd。 */
    async workspaceOf(sessionId, agent) {
        try {
            const catalog = await this.resolveCatalog();
            const ws = (catalog?.workspaces ?? []).find((w) => (w.sessionIds ?? []).includes(sessionId));
            if (ws) {
                return { title: ws.title || undefined, path: ws.path || undefined };
            }
            const row = catalog?.sessionsById?.get(sessionId);
            if (row?.cwd) {
                return { title: workspaceName(row.cwd) || undefined, path: row.cwd };
            }
        }
        catch {
            // 目录不可用 → 继续走 agent 侧兜底
        }
        if (agent) {
            const parts = describeAgent(agent, 0, this.ctx);
            if (parts.cwd) {
                return { title: parts.workspace || undefined, path: parts.cwd };
            }
        }
        return undefined;
    }
    /** 从 sessionProjections 快照读 Web 底部同款统计（sessionStats/tokenUsage/contextPressure）。 */
    readRuntimeValues(agent) {
        const registry = this.serviceOf('sessionProjections');
        let values;
        if (registry?.snapshot) {
            try {
                values = registry.snapshot(agent.session)?.values;
            }
            catch (err) {
                this.ctx.logger.warn(`dsh-telegram-channel: projection snapshot failed: ${this.redact(err)}`);
            }
        }
        if (!values)
            return undefined;
        const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : undefined;
        const stats = (values['sessionStats'] ?? {});
        const usage = (values['tokenUsage'] ?? {});
        const pressure = (values['contextPressure'] ?? {});
        const runtime = {
            turns: num(stats.turns),
            steps: num(stats.steps),
            llmMs: num(stats.llmMs),
            toolMs: num(stats.toolMs),
            ttftMs: num(stats.ttftMs),
            ttftSteps: num(stats.ttftSteps),
            decodeMs: num(stats.decodeMs),
            decodeTokens: num(stats.decodeTokens),
            uncachedInputTokens: num(usage.uncachedInputTokens),
            cacheReadTokens: num(usage.cacheReadTokens),
            cacheWriteTokens: num(usage.cacheWriteTokens),
            outputTokens: num(usage.outputTokens),
            contextUsed: num(pressure.projectedTokens) ?? num(pressure.pressureTokens),
            contextWindow: num(pressure.contextWindow),
        };
        // 完全无数据时视为无统计块。
        const hasAny = Object.values(runtime).some((v) => v !== undefined);
        return hasAny ? runtime : undefined;
    }
    /** 按名称解析宿主服务（Cordis 需 ctx.get；mock/plain ctx 走自有属性兜底）。 */
    serviceOf(name) {
        const c = this.ctx;
        if (typeof c.get === 'function') {
            try {
                const via = c.get(name, false);
                if (via)
                    return via;
            }
            catch {
                // 服务未装配或当前 ctx 不可解析
            }
        }
        try {
            if (Object.prototype.hasOwnProperty.call(this.ctx, name)) {
                return this.ctx[name];
            }
        }
        catch {
            // proxy ctx：无 inject 直接读属性会抛错，忽略
        }
        return undefined;
    }
    // ── /compact：手动压缩当前绑定会话（需会话空闲）──
    //
    // 压缩引擎（compaction-basic）挂载在隔离作用域，插件 ctx 拿不到；但宿主的
    // command-compact 已把 /compact 注册进命令运行时的按 agent 作用层（Web 端
    // 同款通道），因此这里复用它：语义、busy/错误映射、命令生命周期日志与 Web
    // 端 /compact 完全一致，且无需接触引擎内部。
    async requestCompact(chatId) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        if (this.compacting.has(binding.sessionId)) {
            await this.client.sendMessage(chatId, MSG.COMPACT_INFLIGHT);
            return;
        }
        const agent = await this.ensureLiveAgent(binding.sessionId);
        if (!agent) {
            this.bindings.delete(String(chatId));
            await this.client.sendMessage(chatId, MSG.GONE);
            return;
        }
        const commands = this.serviceOf('commands');
        if (!commands?.execute || typeof commands.find !== 'function' || !commands.find(agent, 'compact')) {
            await this.client.sendMessage(chatId, MSG.COMPACT_UNAVAILABLE);
            return;
        }
        // 会话正在跑任务时压缩会被拒（runMaintenance 忙）；提前提示避免「已开始→失败」两步。
        const busy = this.busySessions.has(binding.sessionId)
            || Boolean(agent.phase?.kind
                && agent.phase?.kind !== 'idle');
        if (busy) {
            await this.client.sendMessage(chatId, MSG.COMPACT_BUSY);
            return;
        }
        const controller = new AbortController();
        this.compacting.add(binding.sessionId);
        this.compactAborts.set(binding.sessionId, controller);
        await this.client.sendMessage(chatId, MSG.COMPACT_STARTED);
        const operation = commands.execute(agent, '/compact', [], controller.signal);
        void this.runCompaction(chatId, binding.sessionId, operation, controller).catch((err) => {
            this.ctx.logger.error(`dsh-telegram-channel: /compact runner crashed: ${this.redact(err)}`);
        });
    }
    /** 等待压缩落定并汇报结果（不阻塞轮询循环）。 */
    async runCompaction(chatId, sessionId, operation, controller) {
        try {
            const execution = await operation;
            if (execution === undefined) {
                // find() 通过但 execute 未命中：按未注册处理。
                await this.enqueueNotice(chatId, MSG.COMPACT_UNAVAILABLE);
                return;
            }
            const translated = translateCompactResult(execution.result);
            if (translated !== undefined) {
                await this.enqueueNotice(chatId, translated);
                return;
            }
            // 无法识别的结果：回退为通用失败 + 宿主原文。
            const raw = execution.result?.text;
            await this.enqueueNotice(chatId, MSG.COMPACT_FAILED(raw));
        }
        catch (err) {
            if (controller.signal.aborted) {
                // 桥停止/热重载导致的取消：静默，不打扰（本实例正在退出）。
                this.ctx.logger.info('dsh-telegram-channel: compaction aborted by bridge stop');
                return;
            }
            this.ctx.logger.warn(`dsh-telegram-channel: /compact failed: ${this.redact(err)}`);
            await this.enqueueNotice(chatId, MSG.COMPACT_FAILED(this.redact(err)));
        }
        finally {
            this.compacting.delete(sessionId);
            this.compactAborts.delete(sessionId);
        }
    }
    async followupBound(chatId, text) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        const agent = await this.ensureLiveAgent(binding.sessionId);
        if (!agent) {
            this.bindings.delete(String(chatId));
            await this.client.sendMessage(chatId, MSG.GONE);
            return;
        }
        const message = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        });
        // Busy feedback: mid-turn followups queue silently by design — tell the user.
        const busy = this.busySessions.has(binding.sessionId)
            || Boolean(agent.phase?.kind
                && agent.phase?.kind !== 'idle');
        agent.followup(message);
        if (busy) {
            await this.enqueueNotice(chatId, 'В очереди: сообщение обработается после текущей задачи');
        }
    }
    /**
     * Extract wire prompt parts from a media message.
     * Returns undefined when the message carries no media at all; returns [] for
     * an unsupported media type (the user was already notified); otherwise the
     * caption text part (when present) followed by the image part.
     */
    async collectMediaParts(chatId, message) {
        const caption = message.caption?.trim();
        const textPart = caption ? { type: 'text', text: caption } : undefined;
        const withText = (part) => textPart ? [textPart, part] : [part];
        if (message.photo && message.photo.length > 0) {
            // TG photo sizes are ordered smallest → largest; the last is the best quality.
            const best = message.photo[message.photo.length - 1];
            const part = await this.downloadImagePart(chatId, best.file_id, 'image/jpeg');
            return part ? withText(part) : [];
        }
        const doc = message.document;
        if (doc) {
            if (!doc.mime_type || !IMAGE_MEDIA_TYPES.includes(doc.mime_type)) {
                await this.enqueueNotice(chatId, MSG.MEDIA_UNSUPPORTED);
                return [];
            }
            const part = await this.downloadImagePart(chatId, doc.file_id, doc.mime_type, doc.file_name);
            return part ? withText(part) : [];
        }
        return undefined;
    }
    /** Download one TG file and encode it as a canonical-base64 wire image part. */
    async downloadImagePart(chatId, fileId, mediaType, name) {
        try {
            const file = await this.client.getFile(fileId);
            if (!file.file_path)
                throw new Error('Telegram не вернул путь к файлу');
            const bytes = await this.client.downloadFile(file.file_path);
            // Buffer base64 is canonical (standard alphabet, no whitespace) — the host
            // attachment admission rejects non-canonical forms outright.
            const data = Buffer.from(bytes).toString('base64');
            return { type: 'image', mediaType, data, ...(name === undefined ? {} : { name }) };
        }
        catch (err) {
            await this.enqueueNotice(chatId, MSG.IMAGE_FAILED(this.redact(err)));
            return undefined;
        }
    }
    /**
     * Album photos arrive as separate updates sharing a media_group_id — debounce
     * them into ONE prompt so an album does not spawn N sequential turns.
     */
    accumulateMediaGroup(chatId, groupId, parts) {
        const key = `${String(chatId)}:${groupId}`;
        const existing = this.mediaGroups.get(key);
        if (existing) {
            clearTimeout(existing.timer);
            existing.parts.push(...parts);
        }
        const entry = existing ?? { chatId, parts: [...parts] };
        entry.timer = setTimeout(() => {
            this.mediaGroups.delete(key);
            this.sendImageFollowup(entry.chatId, entry.parts).catch((err) => {
                this.ctx.logger.error(this.redact(err));
            });
        }, MEDIA_GROUP_WINDOW_MS);
        this.mediaGroups.set(key, entry);
    }
    /**
     * Dispatch an image-bearing message to the bound session through the host
     * prompt RPC — the exact channel the Web composer uses. The host checks
     * whether the current model accepts image input, admits the bytes into the
     * durable attachment store, then queues the message on the agent (mode
     * 'queue' — same semantics as the text path's agent.followup).
     */
    async sendImageFollowup(chatId, parts) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        const agent = await this.ensureLiveAgent(binding.sessionId);
        if (!agent) {
            this.bindings.delete(String(chatId));
            await this.client.sendMessage(chatId, MSG.GONE);
            return;
        }
        const proxy = resolveApiProxy(this.ctx);
        if (!proxy?.sessions?.prompt) {
            await this.enqueueNotice(chatId, 'Хост не поддерживает sessions.prompt — отправить изображение нельзя.');
            return;
        }
        const busy = this.busySessions.has(binding.sessionId)
            || Boolean(agent.phase?.kind
                && agent.phase?.kind !== 'idle');
        let res;
        try {
            res = await proxy.sessions.prompt({
                rpcId: randomUUID(),
                payload: { sessionId: binding.sessionId, mode: 'queue', content: parts },
            });
        }
        catch (err) {
            await this.enqueueNotice(chatId, MSG.IMAGE_FAILED(this.redact(err)));
            return;
        }
        const result = res?.result;
        if (!result?.ok) {
            const code = result?.error?.code;
            const message = String(result?.error?.message ?? 'хост не подтвердил приём');
            if (code === 'attachment-error' && result?.error?.details?.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES') {
                await this.enqueueNotice(chatId, MSG.IMAGE_MODEL_UNSUPPORTED);
            }
            else {
                const detail = `${code ? `[${code}] ` : ''}${message}`.trim();
                await this.enqueueNotice(chatId, MSG.IMAGE_FAILED(detail));
            }
            return;
        }
        if (busy) {
            await this.enqueueNotice(chatId, 'В очереди: сообщение обработается после текущей задачи');
        }
    }
    async pollLoop() {
        const signal = this.pollAbort?.signal;
        let errorCount = 0;
        while (this.polling) {
            try {
                const updates = await this.client.getUpdates(this.offset);
                if (!this.polling)
                    break;
                errorCount = 0;
                if (updates.length === 0) {
                    await this.interruptibleDelay(50, signal);
                    continue;
                }
                for (const update of updates) {
                    if (!this.polling)
                        break;
                    await this.processUpdate(update);
                    this.offset = update.update_id + 1;
                }
            }
            catch (err) {
                if (!this.polling)
                    break;
                errorCount += 1;
                this.ctx.logger.error(this.redact(err));
                await this.interruptibleSleep(Math.min(1000 * errorCount, 10_000), signal);
            }
        }
    }
    interruptibleDelay(ms, signal) {
        if (signal?.aborted || !this.polling)
            return Promise.resolve();
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve();
            }, { once: true });
        });
    }
    async interruptibleSleep(ms, signal) {
        if (signal?.aborted || !this.polling)
            return;
        await Promise.race([
            this.sleep(ms),
            new Promise((resolve) => {
                if (signal?.aborted) {
                    resolve();
                    return;
                }
                signal?.addEventListener('abort', () => resolve(), { once: true });
            }),
        ]);
    }
    async onSessionEvent(session, event) {
        const id = String(session.id);
        const targets = [...this.bindings.values()].filter((b) => b.sessionId === id);
        if (targets.length === 0)
            return;
        if (event.type === 'turn/start') {
            // Typing heartbeat — one sendChatAction expires in ~5s, so refresh it
            // for the whole turn instead of only at start.
            this.busySessions.add(id);
            for (const b of targets)
                this.startTypingHeartbeat(b.chatId);
            return;
        }
        if (event.type === 'turn/end') {
            this.busySessions.delete(id);
            this.thinkingSessions.delete(id);
            for (const b of targets)
                this.stopTypingHeartbeat(b.chatId);
            // Abnormal endings (API failure / abort / crash-recovery) must be
            // visible on the phone — previously they ended in silence.
            const reason = event.data?.reason;
            const kind = reason?.kind;
            if (kind === 'error') {
                const detail = String(reason?.error?.message ?? reason?.error?.code ?? '').replace(/\s+/g, ' ').slice(0, 300);
                for (const b of targets)
                    this.enqueueNotice(b.chatId, `Ход прерван из-за ошибки (API/внутренняя)${detail ? `：${detail}` : ''}`);
            }
            else if (kind === 'aborted') {
                const manual = reason?.reason?.kind === 'user';
                for (const b of targets)
                    this.enqueueNotice(b.chatId, manual ? 'Ход остановлен вручную' : 'Ход прерван');
            }
            else if (kind === 'interrupted') {
                for (const b of targets)
                    this.enqueueNotice(b.chatId, 'Сессия пережила аварийное завершение (восстановление после сбоя) — ход помечен как прерванный');
            }
            return;
        }
        if (event.type === 'tool/call') {
            // Progress summary; ask_user is owned by the provider hook (avoids duplicates).
            const name = event.data?.name ?? 'tool';
            if (name === 'ask_user_question')
                return;
            this.thinkingSessions.set(id, false);
            if (event.data?.callId !== undefined) {
                if (this.callNames.size > 400) {
                    const first = this.callNames.keys().next().value;
                    if (first !== undefined)
                        this.callNames.delete(first);
                }
                this.callNames.set(String(event.data.callId), String(name));
            }
            const args = typeof event.data?.arguments === 'string' ? event.data.arguments : '';
            const brief = args.replace(/\s+/g, ' ').trim();
            const shown = brief.length > 60 ? `${brief.slice(0, 60)}…` : brief;
            for (const b of targets)
                this.enqueueNotice(b.chatId, `> ${name}${shown ? ` ${shown}` : ''}`);
            return;
        }
        if (event.type === 'assistant/message') {
            const text = contentToText(event.data.message.content);
            this.thinkingSessions.set(id, false);
            if (!text)
                return;
            await Promise.all(targets.map((b) => this.deliver(b.chatId, text)));
            return;
        }
        if (event.type === 'assistant/chunk') {
            // Thinking indicator: once per reasoning phase, status only (no content).
            const chunk = event.data?.chunk;
            const ctype = String(chunk?.type ?? '');
            const btype = String(chunk?.block?.type ?? '');
            const isReasoning = ctype.includes('reasoning') || btype.includes('reasoning') || btype.includes('think');
            if (isReasoning && this.thinkingSessions.get(id) !== true) {
                this.thinkingSessions.set(id, true);
                for (const b of targets)
                    this.enqueueNotice(b.chatId, '> Thinking…');
            }
            return;
        }
        if (event.type === 'tool/result') {
            // Only failures — successful results are too noisy for the phone.
            const data = event.data;
            if (data?.error) {
                const callKey = String(data.message?.tool_use_id ?? data.message?.callId ?? '');
                const name = this.callNames.get(callKey) ?? 'tool';
                for (const b of targets)
                    this.enqueueNotice(b.chatId, `> Инструмент ${name} — ошибка: ${String(data.error.name ?? 'Error')}${data.error.code ? `/${String(data.error.code)}` : ''}`);
            }
            return;
        }
        if (event.type === 'todo/write') {
            const todos = Array.isArray(event.data?.todos) ? event.data.todos : [];
            this.lastTodos.set(id, todos);
            if (todos.length === 0)
                return;
            const done = todos.filter((t) => t?.status === 'completed').length;
            const current = todos.find((t) => t?.status === 'in_progress') ?? todos.find((t) => t?.status === 'pending');
            const cur = current ? String(current.content ?? '').slice(0, 50) : '';
            for (const b of targets)
                this.enqueueNotice(b.chatId, `> Прогресс ${done}/${todos.length}${cur ? `：${cur}` : ''}`);
            return;
        }
    }
    // ── /rich: per-chat rendering mode (persisted) ──
    //
    // Rich messages (Bot API sendRichMessage) only render on recent Telegram
    // clients; old ones (10.x) show the message as “not supported”. The bot cannot
    // detect the recipient's client version, so the choice is per-chat and manual,
    // remembered forever. HTML mode is the compat default and works everywhere.
    async handleRichCommand(chatId, arg) {
        const key = String(chatId);
        const setAndReply = async (mode) => {
            this.renderPrefs.set(key, mode);
            this.saveBindings();
            await this.client.sendMessage(chatId, MSG.RICH_SET(mode));
        };
        switch (arg) {
            case 'on':
            case 'rich':
                await setAndReply('rich');
                return;
            case 'off':
            case 'html':
            case 'compat':
                await setAndReply('html');
                return;
            case 'auto':
            case 'default':
            case 'reset':
                this.renderPrefs.delete(key);
                this.saveBindings();
                await this.client.sendMessage(chatId, MSG.RICH_STATE(this.renderingMode));
                return;
            case undefined:
                await this.client.sendMessage(chatId, MSG.RICH_STATE(this.modeFor(chatId)));
                return;
            default:
                await this.client.sendMessage(chatId, MSG.RICH_USAGE);
        }
    }
    async deliver(chatId, markdown) {
        if (this.modeFor(chatId) !== 'html') {
            let sentAny = false;
            try {
                const chunks = splitRichMarkdown(markdown);
                for (const chunk of chunks) {
                    try {
                        // Per-chunk retry: transient network blips must not drop a reply.
                        await this.withRetry(() => this.client.sendRichMessage(chatId, chunk));
                        sentAny = true;
                    }
                    catch (err) {
                        if (!sentAny && isRichUnsupportedError(err)) {
                            this.ctx.logger.warn('dsh-telegram-channel: Rich Message API unavailable, falling back to HTML rendering');
                            this.renderingMode = 'html';
                            // Rich API being gone is a server-wide fact: per-chat rich overrides
                            // must not bypass the global downgrade (modeFor prefers the override).
                            for (const [key, mode] of this.renderPrefs) {
                                if (mode === 'rich')
                                    this.renderPrefs.delete(key);
                            }
                            this.saveBindings();
                            await this.deliverHtml(chatId, markdown);
                            return;
                        }
                        throw err;
                    }
                }
                return;
            }
            catch (err) {
                // Persistent rich failure → HTML fallback instead of dropping the message.
                this.ctx.logger.warn(`dsh-telegram-channel: rich deliver failed (${this.redact(err)}), falling back to HTML`);
            }
        }
        await this.deliverHtml(chatId, markdown);
    }
    async deliverHtml(chatId, markdown) {
        const chunks = splitMessage(markdown, this.maxMessageLength);
        for (const chunk of chunks) {
            let html;
            try {
                html = markdownToHtml(chunk);
            }
            catch {
                html = chunk; // Pathological markdown input: degrade to plain text instead of dropping.
            }
            try {
                await this.withRetry(() => this.client.sendMessage(chatId, html, 'HTML'));
            }
            catch {
                try {
                    await this.withRetry(() => this.client.sendMessage(chatId, chunk));
                }
                catch (err) {
                    this.ctx.logger.error(this.redact(err));
                }
            }
        }
    }
    // ── Stability & interactivity helpers ──
    /** Retry an outbound call with capped linear backoff (500ms, 1s, 2s… max 4s). */
    async withRetry(fn, tries = 3) {
        let lastErr;
        for (let attempt = 1; attempt <= tries; attempt++) {
            try {
                return await fn();
            }
            catch (err) {
                lastErr = err;
                if (attempt < tries)
                    await this.sleep(Math.min(500 * 2 ** (attempt - 1), 4000));
            }
        }
        throw lastErr;
    }
    /**
     * Send a notice; a leading `> ` keeps the quote look via a plain-text `> `
     * prefix. NB: NOT `<blockquote>` HTML — older Telegram clients cannot render
     * the blockquote entity at all and show the whole message as “not supported”.
     * Falls back to plain text when the send fails — a notice is never lost.
     */
    async deliverNotice(chatId, text) {
        const quoted = text.startsWith('> ');
        const body = quoted ? text.slice(2) : text;
        try {
            await this.withRetry(() => this.client.sendMessage(chatId, quoted ? `> ${body}` : body));
            return;
        }
        catch (err) {
            this.ctx.logger.error(this.redact(err));
        }
    }
    /** Serialized per-chat notice chain — bursts can't race into Telegram 429s. */
    enqueueNotice(chatId, text) {
        const key = String(chatId);
        const prev = this.noticeQueue.get(key) ?? Promise.resolve();
        const next = prev.then(() => this.deliverNotice(chatId, text)).catch(() => { });
        this.noticeQueue.set(key, next);
        return next;
    }
    startTypingHeartbeat(chatId) {
        this.stopTypingHeartbeat(chatId);
        const send = () => {
            void this.client.sendChatAction(chatId, 'typing').catch(() => { });
        };
        send();
        this.heartbeats.set(String(chatId), setInterval(send, 4000));
    }
    stopTypingHeartbeat(chatId) {
        const h = this.heartbeats.get(String(chatId));
        if (h) {
            clearInterval(h);
            this.heartbeats.delete(String(chatId));
        }
    }
    stopAllHeartbeats() {
        for (const h of this.heartbeats.values())
            clearInterval(h);
        this.heartbeats.clear();
    }
    // ── ask_user_question: TG answering via dual-path race with the UI ──
    /**
     * Mirror the host's agent-scoped waterfall request to Telegram. The next
     * handler remains the Web answer path; NO_PROVIDER means no Web answerer is
     * available, so keep waiting for Telegram instead of failing the request.
     */
    async onUserQuestionRequest(request, next) {
        const sessionId = request?.agent?.id !== undefined ? String(request.agent.id) : undefined;
        const hasBoundChat = sessionId !== undefined
            && [...this.bindings.values()].some((binding) => binding.sessionId === sessionId);
        if (!hasBoundChat || !Array.isArray(request.questions) || request.questions.length === 0) {
            return next();
        }
        const tg = this.registerTgAsk(request);
        let gui;
        try {
            gui = next();
        }
        catch (err) {
            this.discardTgAsk(request);
            tg.reject(err instanceof Error ? err : new Error(String(err)));
            throw err;
        }
        const guiSafe = gui.catch((err) => {
            if (isNoQuestionAnswererError(err)) {
                return new Promise(() => { });
            }
            this.discardTgAsk(request);
            tg.reject(err instanceof Error ? err : new Error(String(err)));
            throw err;
        });
        void gui.then(() => this.settleGuiSide(request), (err) => {
            if (!isNoQuestionAnswererError(err))
                this.discardTgAsk(request);
        });
        return Promise.race([tg.promise, guiSafe]);
    }
    registerTgAsk(request) {
        let resolveFn = () => { };
        let rejectFn = () => { };
        const promise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });
        const ask = { resolve: resolveFn, reject: rejectFn, answered: false };
        const req = request;
        const sessionId = req.agent?.id !== undefined ? String(req.agent.id) : undefined;
        const questions = Array.isArray(req.questions) ? req.questions : [];
        const onAbort = () => {
            for (const [chatId, p] of this.pendingAsks) {
                if (p.ask === ask)
                    this.pendingAsks.delete(chatId);
            }
            rejectFn(new Error('ask aborted'));
        };
        if (req.signal?.aborted) {
            rejectFn(new Error('ask aborted'));
            return { promise, reject: rejectFn };
        }
        req.signal?.addEventListener('abort', onAbort, { once: true });
        if (sessionId !== undefined && questions.length > 0) {
            let asked = false;
            for (const [chatId, binding] of this.bindings) {
                if (binding.sessionId !== sessionId)
                    continue;
                this.pendingAsks.set(String(chatId), { req: request, sessionId, questions, ask, at: Date.now() });
                this.enqueueNotice(Number(chatId), this.formatAskPending(questions));
                asked = true;
            }
            if (asked)
                return { promise, reject: rejectFn };
        }
        // No bound TG chat: never settle — the UI remains the only answer path.
        return { promise, reject: rejectFn };
    }
    settleGuiSide(request) {
        for (const [chatId, p] of [...this.pendingAsks]) {
            if (p.req !== request)
                continue;
            this.pendingAsks.delete(chatId);
            if (!p.ask.answered) {
                this.enqueueNotice(Number(chatId), 'На вопрос уже ответили в Web — канал ответов в TG закрыт');
            }
        }
    }
    discardTgAsk(request) {
        for (const [chatId, pending] of [...this.pendingAsks]) {
            if (pending.req === request)
                this.pendingAsks.delete(chatId);
        }
    }
    formatAskPending(questions) {
        const lines = ['Ждут ответа (ответьте буквой варианта или введите свой ответ; /cancel — закрыть ответы в TG)'];
        questions.forEach((q, i) => {
            const prefix = questions.length > 1 ? `Q${i + 1}. ` : '';
            lines.push(`${prefix}${q.question ?? ''}`);
            const opts = Array.isArray(q.options) ? q.options : [];
            if (opts.length === 0) {
                lines.push('  (открытый вопрос — просто введите ответ)');
            }
            else {
                opts.forEach((o, j) => lines.push(`  [${String.fromCharCode(65 + j)}] ${o.label}${o.description ? ` — ${o.description}` : ''}`));
                if (q.multiSelect)
                    lines.push('  (можно несколько, например: A,B)');
            }
        });
        return lines.join('\n');
    }
    async handleTgAnswer(chatId, pending, text) {
        const { questions, ask } = pending;
        let parts;
        if (questions.length === 1) {
            parts = [[0, text.trim()]];
        }
        else {
            parts = [];
            const lines = text.split(/\n|；|;/).map((s) => s.trim()).filter(Boolean);
            for (const line of lines) {
                const m = line.match(/^([0-9]+)\s*[:：.、)]\s*(.+)$/);
                if (m)
                    parts.push([Number(m[1]) - 1, m[2].trim()]);
                else
                    parts.push([null, line]);
            }
            if (parts.some(([idx]) => idx === null)) {
                await this.enqueueNotice(chatId, `Вопросов: ${questions.length} — отвечайте построчно с префиксом 1:/2:`);
                return;
            }
        }
        const answers = [];
        for (const [idx, raw] of parts) {
            if (idx === null || idx < 0 || idx >= questions.length) {
                await this.enqueueNotice(chatId, `Вопроса №${(idx ?? 0) + 1} нет (всего ${questions.length})`);
                return;
            }
            const q = questions[idx];
            const cleaned = raw.replace(/^\[+/, '').replace(/\]+$/, '').trim();
            const letters = cleaned.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean);
            const opts = Array.isArray(q.options) ? q.options : [];
            const isLetterChoice = letters.length > 0
                && letters.every((s) => /^[a-zA-Z]$/.test(s))
                && opts.length > 0;
            if (isLetterChoice) {
                const selected = [];
                for (const s of letters) {
                    const i = s.toUpperCase().charCodeAt(0) - 65;
                    if (i < 0 || i >= opts.length) {
                        await this.enqueueNotice(chatId, `Варианта ${s.toUpperCase()} нет (доступно A-${String.fromCharCode(64 + opts.length)}). Ответьте снова или /cancel`);
                        return;
                    }
                    selected.push(opts[i].label);
                }
                answers.push({ id: q.id, selected });
            }
            else {
                answers.push({ id: q.id, selected: [], custom: cleaned });
            }
        }
        ask.answered = true;
        for (const [cid, p] of this.pendingAsks) {
            if (p.ask === ask)
                this.pendingAsks.delete(cid);
        }
        ask.resolve({ answers });
        this.enqueueNotice(chatId, 'Ответ отправлен');
    }
    // ── approval: TG answering via dual-path race on the request waterfall ──
    async onApprovalRequest(req, next) {
        const sessionId = req?.agent?.id !== undefined ? String(req.agent.id) : undefined;
        const targets = sessionId !== undefined
            ? [...this.bindings.values()].filter((b) => b.sessionId === sessionId).map((b) => String(b.chatId))
            : [];
        let resolveFn = () => { };
        let rejectFn = () => { };
        const promise = new Promise((resolve, reject) => {
            resolveFn = resolve;
            rejectFn = reject;
        });
        const ask = { resolve: resolveFn, reject: rejectFn, answered: false };
        const onAbort = () => {
            for (const [chatId, p] of this.pendingApprovalsTG) {
                if (p.ask === ask)
                    this.pendingApprovalsTG.delete(chatId);
            }
            rejectFn(new Error('approval withdrawn'));
        };
        if (req?.signal?.aborted) {
            rejectFn(new Error('approval withdrawn'));
            return next();
        }
        req?.signal?.addEventListener('abort', onAbort, { once: true });
        if (targets.length > 0) {
            const toolName = String(req?.toolName ?? 'tool');
            const reason = req?.reason ? String(req.reason).slice(0, 200) : '';
            for (const chatId of targets) {
                this.pendingApprovalsTG.set(chatId, { toolName, ask });
                this.enqueueNotice(Number(chatId), `Запрос разрешения: ${toolName}${reason ? `\n(${reason})` : ''}\nОтветьте [A] — разрешить один раз / [B] — отклонить (/cancel — закрыть в TG)`);
            }
        }
        // No bound TG chat: promise never settles — the UI remains the only answer path.
        const gui = next();
        void gui.then(() => {
            for (const [chatId, p] of [...this.pendingApprovalsTG]) {
                if (p.ask !== ask)
                    continue;
                this.pendingApprovalsTG.delete(chatId);
                if (!p.ask.answered) {
                    p.ask.reject(new Error('superseded-by-gui'));
                    this.enqueueNotice(Number(chatId), 'Это разрешение уже обработано в Web');
                }
            }
        }, () => {
            for (const [chatId, p] of [...this.pendingApprovalsTG]) {
                if (p.ask === ask)
                    this.pendingApprovalsTG.delete(chatId);
            }
        });
        return Promise.race([promise, gui]);
    }
    async handleTgApproval(chatId, approval, text) {
        const cleaned = text.trim().replace(/^\[+/, '').replace(/\]+$/, '').toUpperCase();
        if (cleaned === 'A' || cleaned === 'B') {
            approval.ask.answered = true;
            for (const [cid, p] of this.pendingApprovalsTG) {
                if (p.ask === approval.ask)
                    this.pendingApprovalsTG.delete(cid);
            }
            if (cleaned === 'A') {
                approval.ask.resolve('allowed-once');
                await this.enqueueNotice(chatId, `Разрешён один запуск: ${approval.toolName}`);
            }
            else {
                approval.ask.resolve('rejected');
                await this.enqueueNotice(chatId, 'Запуск инструмента отклонён');
            }
            return;
        }
        await this.enqueueNotice(chatId, 'Ответьте [A] — разрешить один раз или [B] — отклонить (/cancel — закрыть)');
    }
    // ── /stop /mission /new commands ──
    async stopBound(chatId) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        const agent = this.findLiveAgent(binding.sessionId);
        if (!agent) {
            await this.client.sendMessage(chatId, 'В сессии нет выполняющейся задачи');
            return;
        }
        try {
            agent.cancel({ kind: 'user' });
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: stop failed: ${this.redact(err)}`);
        }
        await this.enqueueNotice(chatId, 'Запрошена остановка текущего хода…');
    }
    async sendMission(chatId) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        const todos = this.lastTodos.get(binding.sessionId) ?? [];
        const lines = ['Список задач'];
        if (todos.length === 0) {
            lines.push('(записей пока нет — появятся, когда агент воспользуется todo)');
        }
        else {
            const mark = { completed: '✓', in_progress: '⟳', pending: '·' };
            todos.forEach((t, i) => lines.push(`${mark[t?.status ?? ''] ?? '·'} ${i + 1}. ${String(t?.content ?? '')}`));
            const done = todos.filter((t) => t?.status === 'completed').length;
            lines.push(`— выполнено ${done}/${todos.length}`);
        }
        lines.push(this.busySessions.has(binding.sessionId) ? '(идёт задача: /stop прервёт её)' : '(свободна)');
        await this.client.sendMessage(chatId, lines.join('\n'));
    }
    /** /new: create a session in the bound session's workspace and attach to it. */
    async newSessionHere(chatId) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        let workspaceId;
        let fallbackCwd;
        try {
            const catalog = await this.resolveCatalog();
            for (const ws of catalog?.workspaces ?? []) {
                if ((ws.sessionIds ?? []).includes(binding.sessionId)) {
                    workspaceId = ws.id;
                    break;
                }
            }
            if (workspaceId === undefined)
                fallbackCwd = catalog?.sessionsById?.get(binding.sessionId)?.cwd;
        }
        catch {
            // Catalog unavailable → fall back to the host default workspace.
        }
        const proxy = resolveApiProxy(this.ctx);
        if (!proxy?.sessions?.create) {
            await this.client.sendMessage(chatId, 'Хост не поддерживает создание сессий');
            return;
        }
        let res;
        try {
            const payload = workspaceId !== undefined ? { workspaceId } : (fallbackCwd ? { cwd: fallbackCwd } : {});
            res = await proxy.sessions.create({
                rpcId: `tg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                payload,
            });
        }
        catch (err) {
            await this.client.sendMessage(chatId, `Не удалось создать: ${this.redact(err)}`);
            return;
        }
        const newId = res?.result?.ok ? res.result.value?.sessionId : undefined;
        if (!newId) {
            const detail = res?.result?.error?.message ?? JSON.stringify(res?.result ?? res);
            await this.client.sendMessage(chatId, `Не удалось создать: ${String(detail).slice(0, 200)}`);
            return;
        }
        const stale = this.pendingAsks.get(String(chatId));
        if (stale && stale.sessionId !== String(newId))
            this.pendingAsks.delete(String(chatId));
        this.bindings.set(String(chatId), { chatId, sessionId: String(newId), label: binding.label });
        this.saveBindings();
        const where = workspaceId !== undefined ? 'текущая рабочая область' : (fallbackCwd ? `каталог ${fallbackCwd}` : 'рабочая область по умолчанию');
        await this.client.sendMessage(chatId, `Новый диалог создан и привязан (${where}):\n${String(newId)}\nПросто отправьте сообщение`);
    }
    // ── Binding persistence (survives hot reload / restart) ──
    bindingsPath() {
        // DSH_TELEGRAM_BINDINGS_FILE overrides the location (tests must isolate
        // from the real profile data — parallel test files share this file).
        const override = process.env.DSH_TELEGRAM_BINDINGS_FILE;
        if (override)
            return override;
        const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
        return join(home, 'telegram-channel-bindings.json');
    }
    saveBindings() {
        try {
            const obj = {
                bindings: Object.fromEntries(this.bindings),
                renderPrefs: Object.fromEntries(this.renderPrefs),
            };
            mkdirSync(dirname(this.bindingsPath()), { recursive: true });
            writeFileSync(this.bindingsPath(), JSON.stringify(obj, null, 2));
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: saveBindings failed: ${this.redact(err)}`);
        }
    }
    loadBindings() {
        try {
            const raw = readFileSync(this.bindingsPath(), 'utf8');
            const parsed = JSON.parse(raw);
            const data = parsed;
            // Legacy files (pre-renderPrefs) stored the bindings flat at the top level.
            const flat = parsed;
            const bindingEntries = data.bindings ?? flat;
            let n = 0;
            for (const [chatId, b] of Object.entries(bindingEntries ?? {})) {
                if (b && b.sessionId) {
                    this.bindings.set(String(chatId), {
                        chatId: b.chatId ?? Number(chatId),
                        sessionId: String(b.sessionId),
                        label: b.label ?? String(b.sessionId),
                    });
                    n += 1;
                }
            }
            for (const [chatId, mode] of Object.entries(data.renderPrefs ?? {})) {
                if (mode === 'rich' || mode === 'html') {
                    this.renderPrefs.set(String(chatId), mode);
                }
            }
            if (n > 0)
                this.ctx.logger.info(`dsh-telegram-channel: restored ${n} binding(s) from disk`);
        }
        catch {
            // First run: no file yet.
        }
    }
    redact(value) {
        const message = value instanceof Error ? value.message : String(value);
        return message.split(this.token).join('***');
    }
}

import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm/message';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import { isAuthorized } from './auth.js';
import { resolveApiProxy } from './apiproxy.js';
import { catalogFromLiveAgents, hostService, isArchived, resolveSessionTitle, sessionLogInfo, shortWhen as shortWhenLocal, loadCatalog, truncateButton, visibleSessionsForWorkspace, } from './catalog.js';
import { TelegramClient, } from './client.js';
import { MSG, LAST_CB, ASK_CB, APPROVAL_CB, RETRY_CB, CONTINUE_CB, NTF_HIST_CB, parseCommand } from './commands.js';
import { escapeHtml, markdownToHtml, splitMessage } from './format.js';
import { splitRichMarkdown } from './rich-format.js';
import { formatLastTurn, loadLastTurn } from './history.js';
import { describeAgent, displayLabel, workspaceName } from './label.js';
import { formatModel, loadSessionModels, selectSessionModel, } from './models.js';
import { formatStatusText, } from './status.js';
/** Host-admitted raster media types (@deepseek-ai/dsh-attachment). */
const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
/** Documents we can read as text: mime first, extension as a fallback. */
const TEXT_FILE_EXTENSIONS = [
    '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.csv', '.tsv', '.log',
    '.html', '.htm', '.xml', '.toml', '.ini', '.cfg', '.conf', '.gd', '.ts', '.tsx', '.js',
    '.jsx', '.py', '.sh', '.rs', '.go', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs',
    '.lua', '.sql', '.css',
];
const TEXT_FILE_MIME_EXACT = [
    'application/json', 'application/jsonl', 'application/xml', 'application/yaml',
    'application/x-yaml', 'application/toml', 'application/javascript', 'application/typescript',
    'application/x-sh', 'application/sql',
];
/** Cap on a document we inline into a prompt (a phone should not paste a book). */
export const MAX_TEXT_FILE_BYTES = 128 * 1024;
/** Album debounce window: TG emits each photo of an album as its own update. */
const MEDIA_GROUP_WINDOW_MS = 1200;
/** One-shot reminder if a mirrored question is still unanswered after 5 minutes. */
export const ASK_REMINDER_MS = 5 * 60 * 1000;
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
/** Архивировать сессию из пикера: arc:<индекс в списке>. */
const ARC_CB = 'arc:';
/** Создать сессию в области: ns:<индекс области>. */
const NEW_SID_CB = 'ns:';
/** «Новый проект»: плагин ждёт путь следующим сообщением. */
const NEW_WS_CB = 'nw';
/** Вернуть сессию из архива: unarc:<индекс в списке архива>. */
const UNARC_CB = 'unarc:';
/** Пролистать историю назад: hist:<beforeSeq>. */
const HIST_CB = 'hist:';
/** Показать архивные сессии области: arcl:<индекс области>. */
const ARCLIST_CB = 'arcl:';
/** Вернуться к списку сессий области: bs */
const BACK_SESS_CB = 'bs';
const MAX_BUTTONS = 40;
function lastContextKeyboard() {
    return {
        inline_keyboard: [[{ text: 'Последний диалог', callback_data: LAST_CB }]],
    };
}
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function contentToText(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('');
}
/**
 * Reasoning text of one durable assistant message. DSH 0.2 records the model's
 * thinking as `reasoning` content blocks of the finalized `assistant/message`;
 * the streaming `assistant/chunk` events the bridge also understands never reach
 * a `session/event` listener on this host, so this is the reliable source.
 */
function reasoningToText(content) {
    if (!Array.isArray(content))
        return '';
    return content
        .filter((block) => block?.type === 'reasoning')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .filter((text) => text.length > 0)
        .join('\n\n');
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
    /** Normalized GUI-managed allowlist (may be empty on legacy configs). */
    users;
    client;
    sleep;
    maxMessageLength;
    /** Global rendering mode: follows config; flipped to 'html' permanently when the
     *  Rich Message API itself is unavailable (a server-wide fact, not per-chat). */
    renderingMode;
    /** Per-chat rendering override (persisted): rich messages need a recent Telegram
     *  client — old ones (e.g. 10.x) cannot render them and show “unsupported”. */
    renderPrefs = new Map();
    /** chatId → присылать рассуждения спойлером (по умолчанию да; persisted). */
    reasoningPrefs = new Map();
    bindings = new Map();
    pickers = new Map();
    /** Session names fetched from host projections, keyed by id and updatedAt. */
    titleCache = new Map();
    /** chatId → ждём путь нового проекта следующим сообщением. */
    pendingProject = new Set();
    /** chatId → какие события присылать: всё, только ошибки или ничего. */
    notifyPrefs = new Map();
    /** chatId → за какими сессиями следить: только за привязанной или за всеми. */
    notifyScope = new Map();
    /** Чаты, которые вообще писали боту: им можно присылать уведомления. */
    knownChats = new Set();
    /** People seen in updates: filled for the Web settings page (names, usernames). */
    people = new Map();
    /** Bot identity from `getMe`; refreshed on start and on demand. */
    botInfo;
    /** Why `getMe` failed (bad token, offline) — surfaced in the Web settings. */
    botError;
    /** When `botInfo`/`botError` was last written (ms). */
    botCheckedAt = 0;
    /** id → ms of a failed `getChat`, so a settings page refresh cannot hammer the API. */
    chatLookupFailed = new Map();
    /** Последний загруженный каталог — источник имён сессий для уведомлений. */
    lastCatalog;
    /** sessionId → накопленные рассуждения текущего шага (уходят спойлером). */
    reasoningBuffers = new Map();
    /** chatId → курсор для листания истории (beforeSeq) и признак «есть ещё». */
    historyCursors = new Map();
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
    /** sessionId → last text prompt sent from Telegram (for /retry and the 🔁 button). */
    lastPromptBySession = new Map();
    constructor(ctx, options) {
        this.ctx = ctx;
        this.token = options.token;
        this.allowedUserIds = options.allowedUserIds;
        this.allowAllUsers = options.allowAllUsers;
        this.users = options.users ?? [];
        this.client = options.client ?? new TelegramClient(options.token, {
            pollingTimeoutSec: options.pollingTimeoutSec ?? 30,
        });
        this.sleep = options.sleep ?? defaultSleep;
        this.maxMessageLength = options.maxMessageLength ?? 4096;
        // A live config reload rebuilds the bridge; reusing the last confirmed
        // offset keeps Telegram from redelivering the updates it already answered.
        this.offset = options.offset;
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
        // Bot identity (`getMe`) feeds the Web settings page's status line; it is
        // cached and refreshed on demand, so a slow Telegram call never delays the
        // first poll.
        void this.refreshBotInfo();
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
            { command: 'reasoning', description: 'Рассуждения спойлером: on / off (для этого чата)' },
            { command: 'unbind', description: 'Отвязать телефон (сессия остаётся)' },
            { command: 'stop', description: 'Прервать текущую задачу' },
            { command: 'mission', description: 'Список задач и прогресс' },
            { command: 'new', description: 'Новый диалог в этой области и привязка' },
            { command: 'newproject', description: 'Добавить папку как проект' },
            { command: 'archive', description: 'Убрать сессию в архив' },
            { command: 'archived', description: 'Список архива — вернуть сессию' },
            { command: 'history', description: 'Предыдущие сообщения сессии' },
            { command: 'notify', description: 'Уведомления: on/errors/off, every/bound' },
            { command: 'cancel', description: 'Закрыть ответы/подтверждения в TG' },
            { command: 'help', description: 'Помощь' },
        ]).then(() => {
            this.ctx.logger.info('dsh-telegram-channel: bot commands registered');
        }).catch((err) => {
            this.ctx.logger.warn(`dsh-telegram-channel: setMyCommands failed: ${this.redact(err)}`);
        });
        // Bot profile card (what a stranger sees before /start) — empty by default.
        // Optional on purpose: a partial client/mock without these methods must not
        // break start-up (the card is cosmetic).
        const card = this.client;
        if (typeof card.setMyShortDescription === 'function') {
            void card.setMyShortDescription('Telegram-пульт для DeepSeek Harness: та же сессия, что на компьютере').catch((err) => {
                this.ctx.logger.warn(`dsh-telegram-channel: setMyShortDescription failed: ${this.redact(err)}`);
            });
        }
        if (typeof card.setMyDescription !== 'function')
            return;
        void card.setMyDescription([
            'Пульт для DeepSeek Harness: телефон подключается к уже идущей сессии на компьютере.',
            'Один диалог, две стороны — Web и Telegram видят одну и ту же переписку.',
            '',
            'Нажмите /sessions, выберите рабочую область и сессию — дальше просто пишите.',
            'Доступ только для пользователей из белого списка.',
        ].join('\n')).catch((err) => {
            this.ctx.logger.warn(`dsh-telegram-channel: setMyDescription failed: ${this.redact(err)}`);
        });
        // Names for lifecycle notifications come from the catalog: warm it at boot.
        // At this instant the host services are not registered yet (the plugin
        // mounts first), so warm again shortly after — that pass sees the services
        // and every stored session with its projection.
        this.prefetchCatalog();
        const reWarm = setTimeout(() => this.prefetchCatalog(), 4000);
        if (typeof reWarm.unref === 'function')
            reWarm.unref();
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
        this.reasoningPrefs.clear();
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
    /** Last confirmed `getUpdates` offset — carried into the next bridge instance. */
    get currentOffset() {
        return this.offset;
    }
    /** Whether the long-poll loop is running (the Web settings page shows this). */
    get running() {
        return this.polling;
    }
    /**
     * Ask Telegram who this token belongs to and cache the answer.
     * A rejected token is a normal outcome here — it is reported, not thrown, so
     * the settings page can say “Telegram did not accept this token”.
     * @param force - bypass the cache (the settings page's Refresh button).
     */
    async refreshBotInfo(force = false) {
        if (!force && this.botCheckedAt > 0 && Date.now() - this.botCheckedAt < 60_000)
            return;
        this.botCheckedAt = Date.now();
        try {
            const me = await this.client.getMe();
            this.botInfo = {
                id: me.id,
                ...(me.username === undefined ? {} : { username: me.username }),
                ...(me.first_name === undefined ? {} : { name: me.first_name }),
            };
            this.botError = undefined;
        }
        catch (err) {
            this.botInfo = undefined;
            this.botError = this.redact(err);
        }
    }
    /** The cached bot identity / error, refreshing once when nothing is cached yet. */
    async selectedBot() {
        if (this.botCheckedAt === 0)
            await this.refreshBotInfo();
        return {
            ...(this.botInfo === undefined ? {} : { bot: this.botInfo }),
            ...(this.botError === undefined ? {} : { error: this.botError }),
            checkedAt: this.botCheckedAt,
        };
    }
    /**
     * Everything the Web settings page shows about the running bot: identity,
     * the allowlist as configured, and the people the bot has actually seen.
     * The token itself never crosses this boundary.
     */
    async describeSettings() {
        const identity = await this.selectedBot();
        // Name the configured people who never wrote to the bot: `getChat` works
        // for a user the bot has interacted with, and fails harmlessly otherwise.
        const lookup = this.client.getChat?.bind(this.client);
        const unnamed = lookup === undefined
            ? []
            : this.effectiveEntries().filter((user) => {
                const person = this.people.get(user.id);
                if (person?.name !== undefined || person?.username !== undefined)
                    return false;
                const failedAt = this.chatLookupFailed.get(user.id);
                return failedAt === undefined || Date.now() - failedAt > 300_000;
            });
        for (const user of unnamed.slice(0, 10)) {
            try {
                const chat = await lookup(user.id);
                this.rememberPerson({
                    id: user.id,
                    first_name: chat.first_name,
                    last_name: chat.last_name,
                    username: chat.username,
                });
            }
            catch {
                // Unknown to Telegram until they start the bot: keep just the number,
                // and do not ask again for a while.
                this.chatLookupFailed.set(user.id, Date.now());
            }
        }
        return {
            running: this.polling,
            tokenSet: this.token.length > 0,
            ...(identity.bot === undefined ? {} : { bot: identity.bot }),
            ...(identity.error === undefined ? {} : { error: identity.error }),
            allowAllUsers: this.allowAllUsers,
            users: this.effectiveEntries().map((user) => {
                const person = this.people.get(user.id);
                const bound = this.bindings.has(String(user.id));
                return {
                    ...user,
                    ...(person?.name === undefined ? {} : { name: user.name ?? person.name }),
                    ...(person?.username === undefined ? {} : { username: person.username }),
                    bound,
                };
            }),
            people: [...this.people.values()].sort((a, b) => b.at - a.at).slice(0, 20),
            bindings: [...this.bindings.values()].map((binding) => ({
                chatId: binding.chatId,
                sessionId: binding.sessionId,
                label: binding.label,
            })),
        };
    }
    /**
     * Resolve one person the owner typed: a numeric id or an `@username`.
     * `getChat` is the only Bot API call that finds a user by handle, and it only
     * answers for users the bot has interacted with.
     * @param query - `@name`, `name`, or a numeric Telegram user id.
     */
    async resolvePerson(query) {
        const text = query.trim();
        if (text.length === 0)
            throw new Error('пустой запрос');
        const lookup = this.client.getChat?.bind(this.client);
        if (lookup === undefined)
            throw new Error('этот клиент Telegram не умеет искать пользователей');
        const chat = await lookup(/^\d+$/.test(text) ? Number(text) : text);
        const id = Number(chat.id);
        if (!Number.isFinite(id) || id <= 0)
            throw new Error('Telegram вернул некорректный id');
        const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
        this.rememberPerson({
            id,
            first_name: chat.first_name,
            last_name: chat.last_name,
            username: chat.username,
        });
        return {
            id,
            ...(name.length > 0 ? { name } : {}),
            ...(chat.username === undefined ? {} : { username: chat.username }),
        };
    }
    /** Configured people, with the legacy flat list presented as entries of its own. */
    effectiveEntries() {
        if (this.users.length > 0)
            return this.users;
        return this.allowedUserIds.map((id) => ({ id, enabled: true }));
    }
    /** Record the person behind an update (name and @username for the settings page). */
    rememberPerson(from) {
        if (from === undefined || typeof from.id !== 'number')
            return;
        const name = [from.first_name, from.last_name].filter((part) => typeof part === 'string' && part.trim().length > 0).join(' ').trim();
        const previous = this.people.get(from.id);
        const next = {
            id: from.id,
            at: Date.now(),
            ...(name.length > 0 ? { name } : previous?.name === undefined ? {} : { name: previous.name }),
            ...(typeof from.username === 'string' && from.username.length > 0
                ? { username: from.username }
                : previous?.username === undefined ? {} : { username: previous.username }),
        };
        this.people.set(from.id, next);
        this.saveBindings();
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
        this.rememberChat(chatId);
        this.rememberPerson(message.from);
        // Text documents (md/json/code…) are inlined into the prompt instead of
        // being rejected as "unsupported media"; photos keep the image path.
        if (message.document && !this.isImageDocument(message.document)) {
            await this.handleTextDocument(chatId, message);
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
        // «Новый проект» ждёт путь. Абсолютный путь начинается с «/», поэтому
        // здесь текст не разбирается как команда — исключение только /cancel.
        if (this.pendingProject.has(chatId)) {
            this.pendingProject.delete(chatId);
            const answer = message.text.trim();
            if (answer === '/cancel') {
                await this.client.sendMessage(chatId, MSG.NEWPROJECT_CANCELLED);
                return;
            }
            await this.createWorkspaceFromText(chatId, message.text);
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
            case 'reasoning':
                await this.handleReasoningCommand(chatId, parsed.arg);
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
            case 'archive':
                await this.archiveBound(chatId);
                return;
            case 'notify':
                await this.handleNotifyCommand(chatId, parsed.arg);
                return;
            case 'newproject':
                if (!parsed.arg || !parsed.arg.trim()) {
                    await this.client.sendMessage(chatId, MSG.NEWPROJECT_PROMPT);
                    return;
                }
                await this.createWorkspaceFromText(chatId, parsed.arg);
                return;
            case 'projects':
                await this.sendWorkspacePicker(chatId);
                return;
            case 'archived':
                await this.sendArchivedPicker(chatId);
                return;
            case 'history':
                await this.handleHistoryCommand(chatId, parsed.arg);
                return;
            case 'retry':
                await this.retryLastPrompt(chatId);
                return;
            case 'find':
                await this.handleFindCommand(chatId, parsed.arg);
                return;
            case 'cancel': {
                // /cancel closes the TG-side answer/approval channel; the UI side stays open.
                let cancelled = false;
                const approval = this.pendingApprovalsTG.get(String(chatId));
                if (approval) {
                    this.pendingApprovalsTG.delete(String(chatId));
                    this.clearApprovalKeyboard(chatId, approval);
                    cancelled = true;
                }
                const pendingAsk = this.pendingAsks.get(String(chatId));
                if (pendingAsk) {
                    this.pendingAsks.delete(String(chatId));
                    this.clearAskReminder(pendingAsk);
                    this.clearAskKeyboards(chatId, pendingAsk);
                    cancelled = true;
                }
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
                    if (pending.awaitingCustom !== undefined) {
                        await this.handleAskCustomText(chatId, pending, parsed.text);
                    }
                    else {
                        await this.handleTgAnswer(chatId, pending, parsed.text);
                    }
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
        this.rememberChat(chatId);
        this.rememberPerson(cq.from);
        const data = cq.data ?? '';
        const picker = this.pickers.get(String(chatId));
        if (data.startsWith(ASK_CB)) {
            await this.handleAskCallback(chatId, cq.id, data);
            return;
        }
        if (data.startsWith(APPROVAL_CB)) {
            await this.handleApprovalCallback(chatId, cq.id, data);
            return;
        }
        if (data.startsWith(RETRY_CB)) {
            await this.client.answerCallbackQuery(cq.id, 'Повторяю…');
            await this.retryLastPrompt(chatId, data.slice(RETRY_CB.length));
            return;
        }
        if (data.startsWith(CONTINUE_CB)) {
            await this.client.answerCallbackQuery(cq.id, 'Продолжаю…');
            await this.followupSession(chatId, data.slice(CONTINUE_CB.length), MSG.CONTINUE_TEXT);
            return;
        }
        if (data.startsWith(NTF_HIST_CB)) {
            await this.client.answerCallbackQuery(cq.id);
            await this.sendHistoryPage(chatId, data.slice(NTF_HIST_CB.length));
            return;
        }
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
        if (data.startsWith(HIST_CB)) {
            const beforeSeq = Number(data.slice(HIST_CB.length));
            const cursor = this.historyCursors.get(String(chatId));
            const sessionId = cursor?.sessionId ?? this.bindings.get(String(chatId))?.sessionId;
            await this.client.answerCallbackQuery(cq.id);
            if (!sessionId) {
                await this.client.sendMessage(chatId, MSG.NEED_BIND);
                return;
            }
            await this.sendHistoryPage(chatId, sessionId, Number.isFinite(beforeSeq) ? beforeSeq : undefined);
            return;
        }
        if (data.startsWith(UNARC_CB)) {
            const index = Number(data.slice(UNARC_CB.length));
            const row = picker?.sessions[index];
            if (!row) {
                await this.client.answerCallbackQuery(cq.id, 'Список устарел');
                await this.client.sendMessage(chatId, MSG.PICKER_STALE);
                return;
            }
            await this.client.answerCallbackQuery(cq.id, 'Возвращаю');
            const restored = await this.unarchiveSessionById(chatId, row.sessionId, row.title);
            if (restored)
                await this.sendArchivedPicker(chatId);
            return;
        }
        if (data.startsWith(ARCLIST_CB)) {
            await this.client.answerCallbackQuery(cq.id);
            await this.sendArchivedInWorkspace(chatId, Number(data.slice(ARCLIST_CB.length)));
            return;
        }
        if (data === BACK_SESS_CB) {
            const index = picker?.workspaceIndex ?? 0;
            await this.client.answerCallbackQuery(cq.id);
            await this.sendSessionPicker(chatId, index);
            return;
        }
        if (data === NEW_WS_CB) {
            await this.client.answerCallbackQuery(cq.id, 'Жду путь к папке');
            this.pendingProject.add(chatId);
            await this.client.sendMessage(chatId, MSG.NEWPROJECT_PROMPT);
            return;
        }
        if (data.startsWith(NEW_SID_CB)) {
            const index = Number(data.slice(NEW_SID_CB.length));
            const ws = picker?.workspaces?.[index] ?? (await this.resolveCatalog()).workspaces[index];
            if (!ws) {
                await this.client.answerCallbackQuery(cq.id, 'Область устарела');
                await this.client.sendMessage(chatId, MSG.PICKER_STALE);
                return;
            }
            await this.client.answerCallbackQuery(cq.id, 'Создаю сессию');
            await this.createSessionInTarget(chatId, { workspaceId: ws.id });
            return;
        }
        if (data.startsWith(ARC_CB)) {
            const index = Number(data.slice(ARC_CB.length));
            const row = picker?.sessions[index];
            if (!row) {
                await this.client.answerCallbackQuery(cq.id, 'Сессия устарела');
                await this.client.sendMessage(chatId, MSG.PICKER_STALE);
                return;
            }
            await this.client.answerCallbackQuery(cq.id, 'В архив');
            const archived = await this.archiveSessionById(chatId, row.sessionId, row.title);
            if (archived) {
                const wsIndex = picker?.workspaceIndex;
                await this.sendSessionPicker(chatId, wsIndex ?? 0);
            }
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
            if (fromApi) {
                this.lastCatalog = fromApi;
                return fromApi;
            }
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: catalog via apiProxy failed: ${this.redact(err)}`);
        }
        const fallback = catalogFromLiveAgents(this.liveAgents(), this.ctx);
        this.lastCatalog = fallback;
        return fallback;
    }
    /** Chat remembering: any authorized contact may receive notifications. */
    rememberChat(chatId) {
        if (this.knownChats.has(chatId))
            return;
        this.knownChats.add(chatId);
        this.saveBindings();
    }
    notifyScopeFor(chatId) {
        return this.notifyScope.get(String(chatId)) ?? 'every';
    }
    /** Human name of a session for lifecycle notifications. */
    /**
     * Async label for notifications: when the catalog row has no real title yet
     * (`named === false`), ask the host for the session projections — that yields
     * the session title or its first message instead of an id tail. The result is
     * cached back into the catalog row so later events are cheap.
     */
    async sessionLabelFor(sessionId) {
        const row = this.lastCatalog?.sessionsById.get(sessionId);
        let name = row?.title;
        if (!name || row?.named === false) {
            const fresh = await resolveSessionTitle(this.ctx, sessionId, row?.cwd).catch(() => undefined);
            if (fresh) {
                name = fresh;
                if (row) {
                    row.title = fresh;
                    row.named = true;
                }
            }
        }
        if (!name) {
            const bound = [...this.bindings.values()].find((b) => b.sessionId === sessionId);
            name = bound?.label ?? `…${sessionId.slice(-8)}`;
        }
        const project = this.projectLabel(sessionId, row?.cwd);
        return project ? `${name} · проект ${project}` : name;
    }
    sessionLabel(sessionId) {
        const row = this.lastCatalog?.sessionsById.get(sessionId);
        const bound = [...this.bindings.values()].find((b) => b.sessionId === sessionId);
        const name = row?.title || bound?.label || `…${sessionId.slice(-8)}`;
        const project = this.projectLabel(sessionId, row?.cwd);
        return project ? `${name} · проект ${project}` : name;
    }
    /** Project (workspace) a session belongs to: registry match, else cwd basename. */
    projectLabel(sessionId, cwd) {
        const catalog = this.lastCatalog;
        const workspace = catalog?.workspaces.find((w) => (w.sessionIds ?? []).includes(sessionId) || (cwd !== undefined && w.path === cwd));
        if (workspace?.title)
            return workspace.title;
        return workspaceName(cwd ?? undefined);
    }
    /** Warm the catalog so notifications can name sessions and projects. */
    prefetchCatalog() {
        void this.resolveCatalog().catch((err) => {
            this.ctx.logger.warn(`dsh-telegram-channel: catalog prefetch failed: ${this.redact(err)}`);
        });
    }
    /**
     * Chats that must hear about lifecycle events of this session: those bound
     * to it, plus every chat following "every session" (the default), so a task
     * started on the desktop still pings the phone.
     */
    lifecycleTargets(sessionId) {
        const chats = new Set();
        for (const b of this.bindings.values()) {
            if (b.sessionId === sessionId)
                chats.add(b.chatId);
        }
        for (const chatId of this.knownChats) {
            if (this.notifyPrefs.get(String(chatId)) === 'off')
                continue;
            if (this.notifyScopeFor(chatId) === 'every')
                chats.add(chatId);
        }
        return [...chats];
    }
    async sendWorkspacePicker(chatId, existing) {
        const catalog = existing ?? await this.resolveCatalog();
        // Все области реестра, включая пустые: в пустой можно сразу создать сессию.
        const workspaces = catalog.workspaces;
        if (workspaces.length === 0) {
            this.pickers.delete(String(chatId));
            await this.client.sendMessage(chatId, MSG.NO_PROJECTS);
            return;
        }
        const shown = workspaces.slice(0, MAX_BUTTONS);
        this.pickers.set(String(chatId), { workspaces: shown, sessions: [], catalog });
        const keyboard = {
            inline_keyboard: [
                ...shown.map((ws, i) => ([{
                        text: truncateButton(`${i + 1}. ${ws.title}`),
                        callback_data: `${WS_CB}${i}`,
                    }])),
                [{ text: '➕ Новый проект', callback_data: NEW_WS_CB }],
            ],
        };
        const body = [
            catalog.complete
                ? `Выберите рабочую область (${workspaces.length}, как в Web; архивные сессии скрыты):`
                : `Выберите рабочую область (${workspaces.length}) ⚠️ хост не отдал каталог: видны только запущенные сессии`,
            '',
            ...shown.map((ws, i) => {
                const n = visibleSessionsForWorkspace(catalog, ws).length;
                return `${i + 1}. ${ws.title}${n === 0 ? ' — сессий нет' : ''}\n   ${ws.path}\n   сессий: ${n}`;
            }),
            workspaces.length > MAX_BUTTONS ? `\nПоказаны первые ${MAX_BUTTONS} рабочих областей.` : '',
            '',
            'Кнопка области открывает её сессии; в пустой области можно создать новую. «➕ Новый проект» добавляет папку в реестр.',
        ].filter(Boolean).join('\n');
        await this.client.sendMessage(chatId, body, undefined, keyboard);
    }
    /**
     * Button caption for one session: `N. <name> <state>`. The name is the Web
     * session title (the catalog falls back to `workspace · date`), so the phone
     * list reads like the desktop sidebar instead of bare numbers.
     * ▶ = the session is live in memory, ▷ = parked (resumed on attach).
     */
    sessionButtonText(row, index) {
        const raw = (row.title ?? '').trim() || `сессия …${row.sessionId.slice(-12)}`;
        const name = raw.replace(/…+$/, '').trim() || raw;
        return `${index + 1}. ${name} ${row.running ? '▶' : '▷'}`;
    }
    /**
     * Fill in real session names for the rows the picker is about to show.
     * `sessions.list` leaves cold sessions without a projection block, so ask the
     * host per session (cached by updatedAt) — that is what makes a button read
     * like the Web sidebar instead of "workspace · date".
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
            const title = await resolveSessionTitle(this.ctx, row.sessionId, row.cwd);
            if (!title) {
                // No name anywhere: a *cold* session whose log carries no user message
                // is empty — hide it instead of showing an id tail. A running session is
                // never blank: its log may simply not be on disk yet.
                if (!row.named && !row.running && !sessionLogInfo(row.sessionId, row.cwd).hasUserMessage)
                    row.blank = true;
                return;
            }
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
            : catalog.workspaces;
        const workspace = workspaces[workspaceIndex];
        if (!workspace) {
            await this.client.sendMessage(chatId, MSG.PICKER_STALE);
            return;
        }
        const sessions = visibleSessionsForWorkspace(catalog, workspace)
            .slice()
            .sort((a, b) => b.updatedAt - a.updatedAt);
        const shownRaw = sessions.slice(0, MAX_BUTTONS);
        await this.ensureSessionNames(shownRaw);
        const shown = shownRaw.filter((row) => !row.blank);
        const hiddenEmpty = shownRaw.length - shown.length;
        sessions.length = 0;
        sessions.push(...shown);
        this.pickers.set(String(chatId), { workspaces, workspaceIndex, sessions: shown, catalog });
        const archivedCount = workspace.sessionIds
            .filter((sid) => isArchived(catalog.archivedIds, sid))
            .length;
        const keyboard = {
            inline_keyboard: [
                ...shown.map((row, i) => ([
                    { text: truncateButton(this.sessionButtonText(row, i)), callback_data: `${SID_CB}${i}` },
                    { text: '🗄', callback_data: `${ARC_CB}${i}` },
                ])),
                ...(archivedCount > 0
                    ? [[{ text: `🗂 Архивные (${archivedCount})`, callback_data: `${ARCLIST_CB}${workspaceIndex}` }]]
                    : []),
                [{ text: '➕ Новая сессия здесь', callback_data: `${NEW_SID_CB}${workspaceIndex}` }],
                [{ text: '← К областям', callback_data: BACK_WS_CB }],
            ],
        };
        if (sessions.length === 0) {
            const body = [
                `Рабочая область: ${workspace.title}`,
                workspace.path,
                '',
                MSG.NO_SESSIONS_IN_WS_EMPTY(workspace.title),
                ...(archivedCount > 0 ? ['', `В архиве этой области: ${this.ruCount(archivedCount, 'сессия', 'сессии', 'сессий')}.`] : []),
            ].join('\n');
            await this.client.sendMessage(chatId, body, undefined, keyboard);
            return;
        }
        const body = [
            `Рабочая область: ${workspace.title}`,
            workspace.path,
            '',
            `Выберите сессию: ${this.ruCount(sessions.length, 'сессия', 'сессии', 'сессий')}${archivedCount > 0 ? ` (+${archivedCount} в архиве)` : ''}`,
            ...shown.map((row, i) => {
                const when = shortWhenLocal(row.updatedAt);
                const mark = row.running ? '▶ идёт работа' : '▷ не запущена';
                return `${i + 1}. ${row.title}${when ? ` — ${when}` : ''}\n   ${mark} · …${row.sessionId.slice(-8)}`;
            }),
            sessions.length > MAX_BUTTONS ? `Показаны первые ${MAX_BUTTONS}.` : '',
            hiddenEmpty > 0 ? `Скрыто пустых сессий: ${hiddenEmpty}.` : '',
            '',
            'Кнопка привязывает сессию; 🗄 убирает её в архив.',
        ].filter(Boolean).join('\n');
        await this.client.sendMessage(chatId, body, undefined, keyboard);
    }
    /** Archived sessions of one workspace, each with a restore button. */
    async sendArchivedInWorkspace(chatId, workspaceIndex) {
        const picker = this.pickers.get(String(chatId));
        const catalog = picker?.catalog ?? await this.resolveCatalog();
        const workspaces = picker?.workspaces?.length ? picker.workspaces : catalog.workspaces;
        const workspace = workspaces[workspaceIndex];
        if (!workspace) {
            await this.client.sendMessage(chatId, MSG.PICKER_STALE);
            return;
        }
        const rows = [];
        for (const sid of workspace.sessionIds) {
            if (!isArchived(catalog.archivedIds, sid))
                continue;
            const row = catalog.sessionsById.get(sid);
            if (row)
                rows.push(row);
            else
                rows.push({ sessionId: sid, title: `сессия …${sid.slice(-8)}`, named: false, blank: false, running: false, updatedAt: 0 });
        }
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        const shownRaw = rows.slice(0, MAX_BUTTONS);
        await this.ensureSessionNames(shownRaw);
        const shown = shownRaw.filter((row) => !row.blank);
        this.pickers.set(String(chatId), { workspaces, workspaceIndex, sessions: shown, catalog });
        const keyboard = {
            inline_keyboard: [
                ...shown.map((row, i) => ([
                    { text: truncateButton(`↩ ${i + 1}. ${row.title}`), callback_data: `${UNARC_CB}${i}` },
                ])),
                [{ text: '← К сессиям', callback_data: BACK_SESS_CB }],
            ],
        };
        const body = rows.length === 0
            ? [`Рабочая область: ${workspace.title}`, '', 'В архиве этой области пусто.'].join('\n')
            : [
                `Архив области: ${workspace.title}`,
                workspace.path,
                '',
                `${this.ruCount(rows.length, 'сессия', 'сессии', 'сессий')} в архиве${rows.length > MAX_BUTTONS ? ` (показаны первые ${MAX_BUTTONS})` : ''}:`,
                ...shown.map((row, i) => {
                    const when = shortWhenLocal(row.updatedAt);
                    return `${i + 1}. ${row.title}${when ? ` — ${when}` : ''}`;
                }),
                '',
                'Кнопка возвращает сессию из архива.',
            ].join('\n');
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
        // Show where we left off: the last page of the conversation.
        await this.sendHistoryPage(chatId, String(agent.id));
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
        this.deliverPrompt(chatId, binding.sessionId, agent, text);
    }
    /** Send text to an explicit session (notification buttons work across bindings). */
    async followupSession(chatId, sessionId, text) {
        const agent = await this.ensureLiveAgent(sessionId);
        if (!agent) {
            await this.client.sendMessage(chatId, MSG.GONE);
            return;
        }
        this.deliverPrompt(chatId, sessionId, agent, text);
    }
    deliverPrompt(chatId, sessionId, agent, text) {
        const message = createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'user' },
        });
        // Busy feedback: mid-turn followups queue silently by design — tell the user.
        const busy = this.busySessions.has(sessionId)
            || Boolean(agent.phase?.kind
                && agent.phase?.kind !== 'idle');
        agent.followup(message);
        if (text.trim().length > 0)
            this.lastPromptBySession.set(sessionId, text);
        if (busy) {
            void this.enqueueNotice(chatId, 'В очереди: сообщение обработается после текущей задачи');
        }
    }
    /** /retry: re-send the last text prompt of this chat's session. */
    async retryLastPrompt(chatId, sessionId) {
        const binding = this.bindings.get(String(chatId));
        const target = sessionId ?? binding?.sessionId;
        if (!target) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        const text = this.lastPromptBySession.get(target);
        if (!text) {
            await this.enqueueNotice(chatId, MSG.RETRY_NONE);
            return;
        }
        await this.followupSession(chatId, target, text);
        await this.enqueueNotice(chatId, MSG.RETRY_SENT);
    }
    /**
     * Extract wire prompt parts from a media message.
     * Returns undefined when the message carries no media at all; returns [] for
     * an unsupported media type (the user was already notified); otherwise the
     * caption text part (when present) followed by the image part.
     */
    isImageDocument(doc) {
        return typeof doc.mime_type === 'string' && IMAGE_MEDIA_TYPES.includes(doc.mime_type);
    }
    isTextDocument(doc) {
        const mime = (doc.mime_type ?? '').toLowerCase();
        if (mime.startsWith('text/') || TEXT_FILE_MIME_EXACT.includes(mime))
            return true;
        const name = (doc.file_name ?? '').toLowerCase();
        return TEXT_FILE_EXTENSIONS.some((ext) => name.endsWith(ext));
    }
    /**
     * Download a text document and deliver it as prompt text (with the caption).
     * Binary documents are refused with an explicit notice — they would arrive as
     * mojibake, and there is no attachment seam for arbitrary files.
     */
    async handleTextDocument(chatId, message) {
        const doc = message.document;
        if (!doc)
            return;
        if (!this.isTextDocument(doc)) {
            await this.enqueueNotice(chatId, MSG.FILE_UNSUPPORTED);
            return;
        }
        if (!this.bindings.has(String(chatId))) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        if ((doc.file_size ?? 0) > MAX_TEXT_FILE_BYTES) {
            await this.enqueueNotice(chatId, MSG.FILE_TOO_LARGE(Math.floor(MAX_TEXT_FILE_BYTES / 1024)));
            return;
        }
        try {
            const file = await this.client.getFile(doc.file_id);
            if (!file.file_path)
                throw new Error('Telegram не вернул путь к файлу');
            const bytes = await this.client.downloadFile(file.file_path);
            if (bytes.length > MAX_TEXT_FILE_BYTES) {
                await this.enqueueNotice(chatId, MSG.FILE_TOO_LARGE(Math.floor(MAX_TEXT_FILE_BYTES / 1024)));
                return;
            }
            const text = Buffer.from(bytes).toString('utf8');
            const name = doc.file_name ?? 'файл';
            const caption = message.caption?.trim();
            const body = [caption, `${MSG.FILE_HEADER(name)}\n\`\`\`\n${text}\n\`\`\``].filter(Boolean).join('\n\n');
            await this.followupBound(chatId, body);
        }
        catch (err) {
            await this.enqueueNotice(chatId, MSG.FILE_FAILED(this.redact(err)));
        }
    }
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
        const controller = hostService(this.ctx, 'sessionController');
        const hostPrompt = controller?.prompt;
        if (!proxy?.sessions?.prompt && typeof hostPrompt !== 'function') {
            await this.enqueueNotice(chatId, 'Хост не поддерживает отправку изображений (нет ни apiProxy.sessions.prompt, ни sessionController.prompt).');
            return;
        }
        const busy = this.busySessions.has(binding.sessionId)
            || Boolean(agent.phase?.kind
                && agent.phase?.kind !== 'idle');
        // dsh 0.2: no apiProxy — the host session controller takes the same payload.
        if (!proxy?.sessions?.prompt) {
            try {
                const accepted = await hostPrompt.call(controller, {
                    requestId: randomUUID(),
                    sessionId: binding.sessionId,
                    mode: 'queue',
                    content: parts,
                });
                if (!accepted?.accepted)
                    throw new Error('хост не подтвердил приём');
            }
            catch (err) {
                await this.enqueueNotice(chatId, MSG.IMAGE_FAILED(this.redact(err)));
                return;
            }
            if (busy)
                await this.enqueueNotice(chatId, 'В очереди: сообщение обработается после текущей задачи');
            return;
        }
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
                const updates = await this.client.getUpdates(this.offset, signal);
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
        const lifecycle = this.lifecycleTargets(id);
        // Content (assistant text, tool progress) stays bound-only; lifecycle goes wider.
        if (targets.length === 0 && !(lifecycle.length > 0 && event.type === 'turn/end'))
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
            await this.flushReasoning(id);
            this.busySessions.delete(id);
            this.thinkingSessions.delete(id);
            for (const b of targets)
                this.stopTypingHeartbeat(b.chatId);
            if (!this.lastCatalog?.sessionsById.has(id))
                this.prefetchCatalog();
            const label = await this.sessionLabelFor(id);
            // Abnormal endings (API failure / abort / crash-recovery) must be
            // visible on the phone — previously they ended in silence.
            const reason = event.data?.reason;
            const kind = reason?.kind;
            const lifecycleSet = new Set(lifecycle);
            for (const chatId of lifecycleSet) {
                const mode = this.notificationMode(chatId);
                if (mode === 'off')
                    continue;
                if (kind === 'error') {
                    this.enqueueNotice(chatId, `${this.describeTurnError(reason?.error)}\nСессия: ${label}`, this.turnNoticeKeyboard(id, 'error'));
                }
                else if (kind === 'completed') {
                    if (mode === 'all')
                        this.enqueueNotice(chatId, `✅ Сессия завершила работу — ${label}`, this.turnNoticeKeyboard(id, 'completed'));
                }
                else if (kind === 'max-tokens') {
                    this.enqueueNotice(chatId, `⚠️ Достигнут лимит выходных токенов — ход закрыт\nСессия: ${label}`, this.turnNoticeKeyboard(id, 'max-tokens'));
                }
                else if (kind === 'blocked') {
                    this.enqueueNotice(chatId, `⛔ Ход заблокирован хостом (сессия в архиве или работа остановлена)\nСессия: ${label}`);
                }
                else if (kind === 'aborted') {
                    const manual = reason?.reason?.kind === 'user';
                    if (mode === 'all')
                        this.enqueueNotice(chatId, manual ? `⏹ Ход остановлен вручную — ${label}` : `⏹ Ход прерван — ${label}`);
                }
                else if (kind === 'interrupted') {
                    this.enqueueNotice(chatId, `⚠️ Сессия оборвалась: аварийное завершение (восстановление после сбоя), ход помечен прерванным\nСессия: ${label}`);
                }
            }
            return;
        }
        if (event.type === 'step/end') {
            await this.flushReasoning(id);
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
            const rawArgs = typeof event.data?.arguments === 'string'
                ? event.data.arguments
                : JSON.stringify(event.data?.arguments ?? {}, null, 2);
            for (const b of targets) {
                await this.sendHtml(b.chatId, this.spoilerBlock(`🛠 ${escapeHtml(String(name))}`, rawArgs?.trim() ? rawArgs : '(без аргументов)'));
            }
            return;
        }
        if (event.type === 'assistant/message') {
            const content = event.data.message.content;
            const text = contentToText(content);
            this.thinkingSessions.set(id, false);
            // Reasoning rides on the finalized message (see `reasoningToText`); a
            // streamed prefix in the buffer is the fallback, never both at once.
            const streamed = this.reasoningBuffers.get(id);
            this.reasoningBuffers.delete(id);
            const reasoning = reasoningToText(content).trim() || (streamed ?? '').trim();
            if (reasoning.length > 0) {
                for (const b of targets) {
                    if (!this.showReasoning(b.chatId))
                        continue;
                    await this.sendHtml(b.chatId, this.spoilerBlock(MSG.REASONING_TITLE, reasoning));
                }
            }
            if (!text)
                return;
            await Promise.all(targets.map((b) => this.deliver(b.chatId, text)));
            return;
        }
        // `assistant/chunk` and `todo/write` exist at runtime but are missing from the
        // narrowed SessionEvent union of @deepseek-ai/dsh-session, so widen once.
        if (event.type === 'assistant/chunk') {
            // Thinking indicator: once per reasoning phase, status only (no content).
            const chunk = event.data?.chunk;
            const ctype = String(chunk?.type ?? '');
            const btype = String(chunk?.block?.type ?? '');
            const isReasoning = ctype.includes('reasoning') || btype.includes('reasoning') || btype.includes('think');
            if (isReasoning) {
                const delta = chunk?.text;
                if (typeof delta === 'string' && delta.length > 0) {
                    this.reasoningBuffers.set(id, (this.reasoningBuffers.get(id) ?? '') + delta);
                }
                if (this.thinkingSessions.get(id) !== true) {
                    this.thinkingSessions.set(id, true);
                    for (const b of targets)
                        this.enqueueNotice(b.chatId, '> Думаю…');
                }
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
            const todoData = event.data;
            const todos = Array.isArray(todoData?.todos) ? todoData.todos : [];
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
    async deliverNotice(chatId, text, keyboard) {
        const quoted = text.startsWith('> ');
        const body = quoted ? text.slice(2) : text;
        try {
            await this.withRetry(() => this.client.sendMessage(chatId, quoted ? `> ${body}` : body, undefined, keyboard));
            return;
        }
        catch (err) {
            this.ctx.logger.error(this.redact(err));
        }
    }
    /** Serialized per-chat notice chain — bursts can't race into Telegram 429s. */
    enqueueNotice(chatId, text, keyboard) {
        const key = String(chatId);
        const prev = this.noticeQueue.get(key) ?? Promise.resolve();
        const next = prev.then(() => this.deliverNotice(chatId, text, keyboard)).catch(() => { });
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
        // Phone side is offered the question when the chat is bound to that session
        // OR follows every session (desktop-started tasks included).
        const wantedChat = sessionId !== undefined && this.lifecycleTargets(sessionId).length > 0;
        if (!wantedChat || !Array.isArray(request.questions) || request.questions.length === 0) {
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
            for (const [chatId, p] of [...this.pendingAsks]) {
                if (p.ask !== ask)
                    continue;
                this.pendingAsks.delete(chatId);
                this.clearAskReminder(p);
                this.clearAskKeyboards(Number(chatId), p);
            }
            rejectFn(new Error('ask aborted'));
        };
        if (req.signal?.aborted) {
            rejectFn(new Error('ask aborted'));
            return { promise, reject: rejectFn };
        }
        req.signal?.addEventListener('abort', onAbort, { once: true });
        if (sessionId !== undefined && questions.length > 0) {
            const label = this.sessionLabel(sessionId);
            let asked = false;
            for (const chatId of this.lifecycleTargets(sessionId)) {
                if (this.notificationMode(chatId) === 'off')
                    continue;
                const pending = {
                    req: request,
                    sessionId,
                    questions,
                    ask,
                    at: Date.now(),
                    messageIds: questions.map(() => undefined),
                    selected: questions.map(() => []),
                    custom: questions.map(() => undefined),
                    final: questions.map(() => false),
                };
                this.pendingAsks.set(String(chatId), pending);
                this.armAskReminder(chatId, pending);
                void this.offerAskChat(chatId, pending, label);
                asked = true;
            }
            if (asked)
                return { promise, reject: rejectFn };
        }
        // No bound TG chat: never settle — the UI remains the only answer path.
        return { promise, reject: rejectFn };
    }
    /** Send one message per question, each with its own inline keyboard. */
    async offerAskChat(chatId, pending, label) {
        for (let i = 0; i < pending.questions.length; i++) {
            if (pending.ask.answered || !this.pendingAsks.has(String(chatId)))
                return;
            try {
                const keyboard = this.askKeyboard(pending, i);
                const message = await this.client.sendMessage(chatId, this.formatAskQuestion(pending.questions, i, label), undefined, keyboard);
                pending.messageIds[i] = message?.message_id;
            }
            catch (err) {
                this.ctx.logger.warn(`dsh-telegram-channel: ask prompt failed: ${this.redact(err)}`);
            }
        }
    }
    /** `A. label ✓` buttons; multiSelect adds «Готово», every question adds «Свой ответ». */
    askKeyboard(pending, index) {
        const opts = Array.isArray(pending.questions[index]?.options) ? pending.questions[index].options : [];
        if (opts.length === 0)
            return undefined;
        const chosen = pending.selected[index] ?? [];
        const rows = opts.map((option, j) => ([{
                text: truncateButton(`${String.fromCharCode(65 + j)}. ${option.label}${chosen.includes(option.label) ? ' ✓' : ''}`),
                callback_data: `${ASK_CB}${index}:${j}`,
            }]));
        rows.push([{ text: MSG.ASK_CUSTOM_BUTTON, callback_data: `${ASK_CB}${index}:c` }]);
        if (pending.questions[index]?.multiSelect) {
            rows.push([{ text: MSG.ASK_DONE_BUTTON, callback_data: `${ASK_CB}${index}:d` }]);
        }
        return { inline_keyboard: rows };
    }
    formatAskQuestion(questions, index, label) {
        const q = questions[index];
        const multi = questions.length > 1;
        const lines = [];
        if (index === 0) {
            lines.push(`${MSG.ASK_HEADER}${multi ? ` (вопросов: ${questions.length})` : ''}`);
            lines.push(`Сессия: ${label}`);
            lines.push('');
        }
        else {
            lines.push(`❓ Вопрос ${index + 1}/${questions.length} · ${label}`);
            lines.push('');
        }
        lines.push(`${multi ? `Q${index + 1}. ` : ''}${q.question ?? ''}`);
        const opts = Array.isArray(q.options) ? q.options : [];
        if (opts.length === 0) {
            lines.push(`  ${MSG.ASK_OPEN}`);
        }
        else {
            opts.forEach((o, j) => lines.push(`  [${String.fromCharCode(65 + j)}] ${o.label}${o.description ? ` — ${o.description}` : ''}`));
            if (q.multiSelect)
                lines.push(`  ${MSG.ASK_MULTI_TIP}`);
        }
        if (index === 0)
            lines.push(MSG.ASK_HINT);
        return lines.join('\n');
    }
    settleGuiSide(request) {
        for (const [chatId, p] of [...this.pendingAsks]) {
            if (p.req !== request)
                continue;
            this.pendingAsks.delete(chatId);
            this.clearAskReminder(p);
            if (!p.ask.answered) {
                this.clearAskKeyboards(Number(chatId), p);
                this.enqueueNotice(Number(chatId), 'На вопрос уже ответили в Web — канал ответов в TG закрыт');
            }
        }
    }
    discardTgAsk(request) {
        for (const [chatId, pending] of [...this.pendingAsks]) {
            if (pending.req !== request)
                continue;
            this.pendingAsks.delete(chatId);
            this.clearAskReminder(pending);
            this.clearAskKeyboards(Number(chatId), pending);
        }
    }
    /** Answer arrives from a button or a typed answer: mark the message, check completion. */
    async markAskAnswered(chatId, pending, index, selected, custom) {
        const messageId = pending.messageIds[index];
        const edit = this.client.editMessageText;
        if (messageId === undefined || !edit)
            return;
        const prefix = pending.questions.length > 1 ? `Q${index + 1}. ` : '';
        const answer = custom !== undefined ? custom : selected.join(', ');
        try {
            await edit.call(this.client, chatId, messageId, `✅ ${prefix}${pending.questions[index]?.question ?? ''}\nОтвет: ${answer}`, undefined, null);
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: ask edit failed: ${this.redact(err)}`);
        }
    }
    async refreshAskKeyboard(chatId, pending, index) {
        const messageId = pending.messageIds[index];
        const keyboard = this.askKeyboard(pending, index);
        const edit = this.client.editMessageReplyMarkup;
        if (messageId === undefined || !edit || !keyboard)
            return;
        try {
            await edit.call(this.client, chatId, messageId, keyboard);
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: ask keyboard edit failed: ${this.redact(err)}`);
        }
    }
    /** Drop inline keyboards that can no longer be used (answered in Web, /cancel, abort). */
    clearAskKeyboards(chatId, pending) {
        const edit = this.client.editMessageReplyMarkup;
        if (!edit)
            return;
        for (const messageId of pending.messageIds) {
            if (messageId === undefined)
                continue;
            void edit.call(this.client, chatId, messageId, null).catch(() => { });
        }
    }
    /** One gentle reminder; never repeats, never keeps the process alive. */
    armAskReminder(chatId, pending) {
        const timer = setTimeout(() => {
            if (this.pendingAsks.get(String(chatId)) !== pending || pending.ask.answered)
                return;
            void this.enqueueNotice(chatId, MSG.ASK_REMINDER(pending.questions.length));
        }, ASK_REMINDER_MS);
        timer.unref?.();
        pending.reminder = timer;
    }
    clearAskReminder(pending) {
        if (pending.reminder === undefined)
            return;
        clearTimeout(pending.reminder);
        pending.reminder = undefined;
    }
    async maybeResolveAsk(chatId, pending) {
        if (pending.ask.answered)
            return;
        if (!pending.questions.every((_, i) => pending.final[i]))
            return;
        this.clearAskReminder(pending);
        pending.ask.answered = true;
        for (const [cid, p] of [...this.pendingAsks]) {
            if (p.ask !== pending.ask)
                continue;
            this.pendingAsks.delete(cid);
            this.clearAskReminder(p);
            if (cid !== String(chatId))
                this.clearAskKeyboards(Number(cid), p);
        }
        const answers = pending.questions.map((q, i) => {
            const custom = pending.custom[i];
            if (custom !== undefined)
                return { id: q.id, selected: [], custom };
            return { id: q.id, selected: pending.selected[i] ?? [] };
        });
        pending.ask.resolve({ answers });
        await this.enqueueNotice(chatId, MSG.ASK_ANSWERED);
    }
    async handleAskCallback(chatId, callbackId, data) {
        const pending = this.pendingAsks.get(String(chatId));
        if (!pending || pending.ask.answered) {
            await this.client.answerCallbackQuery(callbackId, MSG.ASK_CLOSED);
            return;
        }
        const rest = data.slice(ASK_CB.length);
        const sep = rest.indexOf(':');
        const index = Number(sep >= 0 ? rest.slice(0, sep) : rest);
        const action = sep >= 0 ? rest.slice(sep + 1) : '';
        const question = Number.isInteger(index) ? pending.questions[index] : undefined;
        if (!question) {
            await this.client.answerCallbackQuery(callbackId, MSG.ASK_CLOSED);
            return;
        }
        if (pending.final[index]) {
            await this.client.answerCallbackQuery(callbackId, MSG.ASK_ALREADY);
            return;
        }
        if (action === 'c') {
            pending.awaitingCustom = index;
            await this.client.answerCallbackQuery(callbackId, 'Жду текст');
            await this.enqueueNotice(chatId, MSG.ASK_CUSTOM_PROMPT(index + 1));
            return;
        }
        if (action === 'd') {
            const chosen = pending.selected[index] ?? [];
            if (chosen.length === 0) {
                await this.client.answerCallbackQuery(callbackId, MSG.ASK_NONE_SELECTED);
                return;
            }
            pending.final[index] = true;
            await this.client.answerCallbackQuery(callbackId, '✅ Готово');
            await this.markAskAnswered(chatId, pending, index, chosen);
            await this.maybeResolveAsk(chatId, pending);
            return;
        }
        const options = Array.isArray(question.options) ? question.options : [];
        const option = options[Number(action)];
        if (!option) {
            await this.client.answerCallbackQuery(callbackId, 'Вариант устарел');
            return;
        }
        if (question.multiSelect) {
            const chosen = pending.selected[index] ?? [];
            pending.selected[index] = chosen.includes(option.label)
                ? chosen.filter((label) => label !== option.label)
                : [...chosen, option.label];
            await this.refreshAskKeyboard(chatId, pending, index);
            const now = pending.selected[index].length;
            await this.client.answerCallbackQuery(callbackId, now > 0 ? `Выбрано: ${now} — «✅ Готово»` : 'Снято всё');
            return;
        }
        pending.selected[index] = [option.label];
        pending.final[index] = true;
        pending.awaitingCustom = undefined;
        await this.client.answerCallbackQuery(callbackId, `✅ ${option.label}`);
        await this.markAskAnswered(chatId, pending, index, [option.label]);
        await this.maybeResolveAsk(chatId, pending);
    }
    /** Text typed after «✏️ Свой ответ» answers exactly that question. */
    async handleAskCustomText(chatId, pending, text) {
        const index = pending.awaitingCustom;
        if (index === undefined)
            return;
        const cleaned = text.trim();
        if (!cleaned) {
            await this.enqueueNotice(chatId, MSG.ASK_CUSTOM_PROMPT(index + 1));
            return;
        }
        pending.awaitingCustom = undefined;
        if (pending.final[index]) {
            await this.enqueueNotice(chatId, MSG.ASK_ALREADY);
            return;
        }
        pending.custom[index] = cleaned;
        pending.selected[index] = [];
        pending.final[index] = true;
        await this.markAskAnswered(chatId, pending, index, [], cleaned);
        await this.maybeResolveAsk(chatId, pending);
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
        this.clearAskReminder(pending);
        for (const [cid, p] of [...this.pendingAsks]) {
            if (p.ask !== ask)
                continue;
            this.pendingAsks.delete(cid);
            this.clearAskReminder(p);
            if (cid !== String(chatId))
                this.clearAskKeyboards(Number(cid), p);
        }
        this.clearAskKeyboards(chatId, pending);
        ask.resolve({ answers });
        await this.enqueueNotice(chatId, MSG.ASK_ANSWERED);
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
                if (p.ask !== ask)
                    continue;
                this.pendingApprovalsTG.delete(chatId);
                this.clearApprovalKeyboard(Number(chatId), p);
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
                let messageId;
                try {
                    const message = await this.client.sendMessage(Number(chatId), `🔐 ${MSG.APPROVAL_HEADER}: ${toolName}${reason ? `\n(${reason})` : ''}\n${MSG.APPROVAL_TIP}`, undefined, {
                        inline_keyboard: [[
                                { text: MSG.APPROVAL_ALLOW_BUTTON, callback_data: `${APPROVAL_CB}1` },
                                { text: MSG.APPROVAL_DENY_BUTTON, callback_data: `${APPROVAL_CB}0` },
                            ]],
                    });
                    messageId = message?.message_id;
                }
                catch (err) {
                    this.ctx.logger.warn(`dsh-telegram-channel: approval prompt failed: ${this.redact(err)}`);
                }
                this.pendingApprovalsTG.set(chatId, { toolName, ask, messageId });
            }
        }
        // No bound TG chat: promise never settles — the UI remains the only answer path.
        const gui = next();
        void gui.then(() => {
            for (const [chatId, p] of [...this.pendingApprovalsTG]) {
                if (p.ask !== ask)
                    continue;
                this.pendingApprovalsTG.delete(chatId);
                this.clearApprovalKeyboard(Number(chatId), p);
                if (!p.ask.answered) {
                    p.ask.reject(new Error('superseded-by-gui'));
                    this.enqueueNotice(Number(chatId), 'Это разрешение уже обработано в Web');
                }
            }
        }, () => {
            for (const [chatId, p] of [...this.pendingApprovalsTG]) {
                if (p.ask !== ask)
                    continue;
                this.pendingApprovalsTG.delete(chatId);
                this.clearApprovalKeyboard(Number(chatId), p);
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
            this.clearApprovalKeyboard(chatId, approval);
            if (cleaned === 'A') {
                approval.ask.resolve('allowed-once');
                await this.enqueueNotice(chatId, MSG.APPROVAL_ALLOWED(approval.toolName));
            }
            else {
                approval.ask.resolve('rejected');
                await this.enqueueNotice(chatId, MSG.APPROVAL_REJECTED);
            }
            return;
        }
        await this.enqueueNotice(chatId, MSG.APPROVAL_TIP);
    }
    clearApprovalKeyboard(chatId, pending) {
        const edit = this.client.editMessageReplyMarkup;
        if (pending.messageId === undefined || !edit)
            return;
        void edit.call(this.client, chatId, pending.messageId, null).catch(() => { });
    }
    async handleApprovalCallback(chatId, callbackId, data) {
        const pending = this.pendingApprovalsTG.get(String(chatId));
        if (!pending || pending.ask.answered) {
            await this.client.answerCallbackQuery(callbackId, MSG.APPROVAL_CLOSED);
            return;
        }
        const allow = data.slice(APPROVAL_CB.length) === '1';
        pending.ask.answered = true;
        for (const [cid, p] of [...this.pendingApprovalsTG]) {
            if (p.ask !== pending.ask)
                continue;
            this.pendingApprovalsTG.delete(cid);
            if (cid !== String(chatId))
                this.clearApprovalKeyboard(Number(cid), p);
        }
        this.clearApprovalKeyboard(chatId, pending);
        if (allow) {
            pending.ask.resolve('allowed-once');
            await this.client.answerCallbackQuery(callbackId, '✅ Разрешено');
            await this.enqueueNotice(chatId, MSG.APPROVAL_ALLOWED(pending.toolName));
        }
        else {
            pending.ask.resolve('rejected');
            await this.client.answerCallbackQuery(callbackId, '⛔ Отклонено');
            await this.enqueueNotice(chatId, MSG.APPROVAL_REJECTED);
        }
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
    /** /history [beforeSeq]: показать предыдущие сообщения сессии. */
    async handleHistoryCommand(chatId, arg) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.NEED_BIND);
            return;
        }
        const raw = Number((arg ?? '').trim());
        await this.sendHistoryPage(chatId, binding.sessionId, Number.isFinite(raw) && raw > 0 ? raw : undefined);
    }
    /** /find <text>: search session titles and folders, then bind with a button. */
    async handleFindCommand(chatId, query) {
        const q = (query ?? '').trim();
        if (q.length === 0) {
            await this.client.sendMessage(chatId, MSG.FIND_USAGE);
            return;
        }
        const catalog = await this.resolveCatalog();
        const needle = q.toLowerCase();
        const rows = [...catalog.sessionsById.values()]
            .filter((row) => !isArchived(catalog.archivedIds, row.sessionId) && !row.blank)
            .filter((row) => (row.title ?? '').toLowerCase().includes(needle)
            || (row.cwd ?? '').toLowerCase().includes(needle))
            .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
            .slice(0, MAX_BUTTONS);
        if (rows.length === 0) {
            await this.client.sendMessage(chatId, MSG.FIND_NONE(q));
            return;
        }
        this.pickers.set(String(chatId), { workspaces: [], sessions: rows, catalog });
        const keyboard = {
            inline_keyboard: rows.map((row, i) => ([{
                    text: truncateButton(this.sessionButtonText(row, i)),
                    callback_data: `${SID_CB}${i}`,
                }])),
        };
        const body = [
            MSG.FIND_HEADER(q, rows.length),
            '',
            ...rows.map((row, i) => `${i + 1}. ${row.title ?? row.sessionId}\n   ${row.cwd ?? ''}`),
        ].join('\n');
        await this.client.sendMessage(chatId, body, undefined, keyboard);
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
        await this.createSessionInTarget(chatId, { workspaceId, cwd: fallbackCwd });
    }
    /**
     * Create a session in a workspace (or a directory) and bind the chat to it.
     * Works on both host generations: `sessionController.create` on DSH 0.2 and
     * `apiProxy.sessions.create` on 0.1.x.
     */
    async createSessionInTarget(chatId, target) {
        const proxy = resolveApiProxy(this.ctx);
        const payload = target.workspaceId !== undefined
            ? { workspaceId: target.workspaceId }
            : (target.cwd ? { cwd: target.cwd } : {});
        let newId;
        if (!proxy?.sessions?.create) {
            // dsh 0.2: no apiProxy — `sessionController.create` is the host's own route.
            const controller = hostService(this.ctx, 'sessionController');
            if (typeof controller?.create !== 'function') {
                await this.client.sendMessage(chatId, 'Хост не поддерживает создание сессий');
                return;
            }
            try {
                const created = await controller.create.call(controller, payload);
                newId = created?.sessionId;
                if (!newId)
                    throw new Error('хост не вернул идентификатор сессии');
            }
            catch (err) {
                await this.client.sendMessage(chatId, `Не удалось создать: ${this.redact(err)}`);
                return;
            }
        }
        else {
            let res;
            try {
                res = await proxy.sessions.create({
                    rpcId: `tg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                    payload,
                });
            }
            catch (err) {
                await this.client.sendMessage(chatId, `Не удалось создать: ${this.redact(err)}`);
                return;
            }
            newId = res?.result?.ok ? res.result.value?.sessionId : undefined;
            if (!newId) {
                const detail = res?.result?.error?.message ?? JSON.stringify(res?.result ?? res);
                await this.client.sendMessage(chatId, `Не удалось создать: ${String(detail).slice(0, 200)}`);
                return;
            }
        }
        const stale = this.pendingAsks.get(String(chatId));
        if (stale && stale.sessionId !== String(newId))
            this.pendingAsks.delete(String(chatId));
        const label = target.workspaceId !== undefined
            ? (this.pickers.get(String(chatId))?.workspaces.find((w) => w.id === target.workspaceId)?.title ?? 'новая сессия')
            : (target.cwd ?? 'новая сессия');
        this.bindings.set(String(chatId), { chatId, sessionId: String(newId), label });
        this.saveBindings();
        const where = target.workspaceId !== undefined
            ? `рабочая область ${label}`
            : (target.cwd ? `каталог ${target.cwd}` : 'рабочая область по умолчанию');
        await this.client.sendMessage(chatId, `Новый диалог создан и привязан (${where}):\n${String(newId)}\nПросто отправьте сообщение`);
    }
    /** /newproject: add a directory to the workspace registry (DSH 0.2). */
    async createWorkspaceFromText(chatId, raw) {
        const text = raw.trim();
        if (!text) {
            await this.client.sendMessage(chatId, MSG.NEWPROJECT_USAGE);
            return;
        }
        const sep = text.indexOf(' | ');
        const pathPart = (sep >= 0 ? text.slice(0, sep) : text).trim();
        const titlePart = sep >= 0 ? text.slice(sep + 3).trim() : '';
        if (!pathPart) {
            await this.client.sendMessage(chatId, MSG.NEWPROJECT_USAGE);
            return;
        }
        const registry = hostService(this.ctx, 'workspaceRegistry');
        if (typeof registry?.create !== 'function') {
            await this.client.sendMessage(chatId, MSG.NEWPROJECT_FAILED('хост не умеет создавать рабочие области (нет workspaceRegistry)'));
            return;
        }
        try {
            const created = await registry.create.call(registry, pathPart, titlePart || undefined);
            this.pickers.delete(String(chatId));
            await this.client.sendMessage(chatId, MSG.NEWPROJECT_CREATED(created?.title ?? titlePart ?? pathPart, created?.path ?? pathPart));
        }
        catch (err) {
            await this.client.sendMessage(chatId, MSG.NEWPROJECT_FAILED(this.redact(err)));
        }
    }
    /** /archive: move the bound session to the archive and unbind the chat. */
    async archiveBound(chatId) {
        const binding = this.bindings.get(String(chatId));
        if (!binding) {
            await this.client.sendMessage(chatId, MSG.ARCHIVE_NONE);
            return;
        }
        await this.archiveSessionById(chatId, binding.sessionId, binding.label);
    }
    /**
     * Archive one session through the host registry. `stopActivity` is requested
     * so a running session is stopped instead of being refused: an archived
     * session must not keep burning tokens.
     */
    async archiveSessionById(chatId, sessionId, label) {
        const registry = hostService(this.ctx, 'workspaceRegistry');
        const call = registry?.archiveSession;
        if (typeof call !== 'function') {
            await this.client.sendMessage(chatId, MSG.ARCHIVE_FAILED('хост не умеет архивировать (нет workspaceRegistry)'));
            return false;
        }
        try {
            await call.call(registry, sessionId, { stopActivity: true });
        }
        catch (err) {
            await this.client.sendMessage(chatId, MSG.ARCHIVE_FAILED(this.redact(err)));
            return false;
        }
        const binding = this.bindings.get(String(chatId));
        if (binding?.sessionId === sessionId) {
            this.bindings.delete(String(chatId));
            this.pendingAsks.delete(String(chatId));
            this.saveBindings();
        }
        await this.client.sendMessage(chatId, MSG.ARCHIVE_DONE(label ?? sessionId));
        return true;
    }
    /** /notify: what this chat receives, and about which sessions. */
    async handleNotifyCommand(chatId, arg) {
        const current = this.notificationMode(chatId);
        const wanted = (arg ?? '').trim().toLowerCase();
        if (wanted === 'every' || wanted === 'all-sessions' || wanted === 'watch') {
            this.notifyScope.set(String(chatId), 'every');
            if (this.notificationMode(chatId) === 'off')
                this.notifyPrefs.set(String(chatId), 'all');
            this.saveBindings();
            await this.client.sendMessage(chatId, 'Уведомления: слежу за ВСЕМИ сессиями (включая запущенные с компьютера).');
            return;
        }
        if (wanted === 'bound' || wanted === 'session') {
            this.notifyScope.set(String(chatId), 'bound');
            this.saveBindings();
            await this.client.sendMessage(chatId, 'Уведомления: только за привязанной сессией.');
            return;
        }
        if (wanted === 'on' || wanted === 'all') {
            this.notifyPrefs.set(String(chatId), 'all');
            this.saveBindings();
            await this.client.sendMessage(chatId, MSG.NOTIFY_SET('all'));
            return;
        }
        if (wanted === 'errors' || wanted === 'error') {
            this.notifyPrefs.set(String(chatId), 'errors');
            this.saveBindings();
            await this.client.sendMessage(chatId, MSG.NOTIFY_SET('errors'));
            return;
        }
        if (wanted === 'off' || wanted === 'none') {
            this.notifyPrefs.set(String(chatId), 'off');
            this.saveBindings();
            await this.client.sendMessage(chatId, MSG.NOTIFY_SET('off'));
            return;
        }
        const scope = this.notifyScopeFor(chatId) === 'every' ? 'все сессии' : 'только привязанная';
        await this.client.sendMessage(chatId, `${MSG.NOTIFY_STATE(current)}\nОбласть: ${scope}.\nСменить: /notify every | bound`);
    }
    notificationMode(chatId) {
        return this.notifyPrefs.get(String(chatId)) ?? 'all';
    }
    /** Human explanation for a failed turn, with a hint for the usual causes. */
    describeTurnError(error) {
        const raw = String(error?.message ?? '').replace(/\s+/g, ' ').trim();
        const code = String(error?.code ?? '').trim();
        const probe = `${code} ${raw}`.toLowerCase();
        let hint = '';
        if (/quota|credit|balance|insufficient|402|payment|token.?limit/.test(probe)) {
            hint = 'похоже, закончились токены или квота провайдера';
        }
        else if (/429|rate.?limit|too many requests|overload/.test(probe)) {
            hint = 'похоже, упёрлись в лимит запросов — попробуйте позже';
        }
        else if (/404|model.?not.?found|no such model|model.*(unavailable|not available|disabled)/.test(probe)) {
            hint = 'похоже, модель недоступна — смените её через /model';
        }
        else if (/context|too long|maximum.*token|overflow/.test(probe)) {
            hint = 'похоже, переполнен контекст — поможет /compact';
        }
        else if (/timeout|timed out|econnreset|econnrefused|network|fetch failed|dns/.test(probe)) {
            hint = 'похоже, сеть или недоступный провайдер';
        }
        else if (/401|403|unauthor|forbidden|api.?key|credential/.test(probe)) {
            hint = 'похоже, ключ или доступ к провайдеру не принят';
        }
        const tail = [code ? `Код: ${code}` : '', hint ? `Похоже: ${hint}` : ''].filter(Boolean).join(' · ');
        const head = raw || code || 'причина не сообщена';
        return `⚠️ Сессия упала: ${head}${tail ? `\n${tail}` : ''}`;
    }
    /** «1 сессия / 2 сессии / 5 сессий» */
    ruCount(n, one, few, many) {
        const mod10 = n % 10;
        const mod100 = n % 100;
        const word = mod10 === 1 && mod100 !== 11
            ? one
            : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
                ? few
                : many;
        return `${n} ${word}`;
    }
    // ── вывод: HTML, спойлеры, архив, история ──
    /** Send pre-built HTML; if Telegram rejects the markup, fall back to plain. */
    async sendHtml(chatId, html, keyboard) {
        try {
            await this.withRetry(() => this.client.sendMessage(chatId, html, 'HTML', keyboard));
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: HTML send failed, falling back: ${this.redact(err)}`);
            await this.client.sendMessage(chatId, html.replace(/<[^>]+>/g, ''), undefined, keyboard);
        }
    }
    /** Collapsible block: Telegram shows it as "expandable quote", hidden by default. */
    spoilerBlock(title, body, limit = 3000) {
        const text = body.length > limit ? `${body.slice(0, limit)}\n… (обрезано)` : body;
        return `<blockquote expandable>${title}\n<pre>${escapeHtml(text)}</pre></blockquote>`;
    }
    /** Whether this chat wants the model's reasoning as a spoiler (default: yes). */
    showReasoning(chatId) {
        return this.reasoningPrefs.get(String(chatId)) !== false;
    }
    /** Flush streamed reasoning of one session as a spoiler block (fallback path). */
    async flushReasoning(sessionId) {
        const buffered = this.reasoningBuffers.get(sessionId);
        this.reasoningBuffers.delete(sessionId);
        if (!buffered || buffered.trim().length === 0)
            return;
        const targets = [...this.bindings.values()].filter((b) => b.sessionId === sessionId);
        for (const b of targets) {
            if (!this.showReasoning(b.chatId))
                continue;
            await this.sendHtml(b.chatId, this.spoilerBlock(MSG.REASONING_TITLE, buffered.trim()));
        }
    }
    /** `/reasoning [on|off]` — remember whether reasoning is mirrored into this chat. */
    async handleReasoningCommand(chatId, arg) {
        const key = String(chatId);
        switch (arg) {
            case 'on':
            case 'yes':
            case 'show':
                this.reasoningPrefs.set(key, true);
                this.saveBindings();
                await this.client.sendMessage(chatId, MSG.REASONING_SET(true));
                return;
            case 'off':
            case 'no':
            case 'hide':
                this.reasoningPrefs.set(key, false);
                this.saveBindings();
                await this.client.sendMessage(chatId, MSG.REASONING_SET(false));
                return;
            case 'auto':
            case 'default':
            case 'reset':
                this.reasoningPrefs.delete(key);
                this.saveBindings();
                await this.client.sendMessage(chatId, MSG.REASONING_STATE(true));
                return;
            case undefined:
                await this.client.sendMessage(chatId, MSG.REASONING_STATE(this.showReasoning(chatId)));
                return;
            default:
                await this.client.sendMessage(chatId, MSG.REASONING_USAGE);
        }
    }
    /** List archived sessions with one-tap restore. */
    async sendArchivedPicker(chatId) {
        const catalog = await this.resolveCatalog();
        const rows = [];
        for (const rawId of catalog.archivedIds) {
            const row = catalog.sessionsById.get(rawId);
            if (row)
                rows.push(row);
            else
                rows.push({
                    sessionId: rawId,
                    title: `сессия …${String(rawId).slice(-8)}`,
                    named: false,
                    blank: false,
                    running: false,
                    updatedAt: 0,
                });
        }
        rows.sort((a, b) => b.updatedAt - a.updatedAt);
        if (rows.length === 0) {
            await this.client.sendMessage(chatId, 'Архив пуст.');
            return;
        }
        const shown = rows.slice(0, MAX_BUTTONS);
        this.pickers.set(String(chatId), { workspaces: [], sessions: shown, catalog });
        const keyboard = {
            inline_keyboard: shown.map((row, i) => ([{
                    text: truncateButton(`↩ ${i + 1}. ${row.title}`),
                    callback_data: `${UNARC_CB}${i}`,
                }])),
        };
        const body = [
            `Архив: ${this.ruCount(rows.length, 'сессия', 'сессии', 'сессий')}${rows.length > MAX_BUTTONS ? ` (показаны первые ${MAX_BUTTONS})` : ''}.`,
            '',
            ...shown.map((row, i) => {
                const project = this.projectLabel(row.sessionId, row.cwd);
                return `${i + 1}. ${row.title}${project ? ` · проект ${project}` : ''}`;
            }),
            '',
            'Нажмите кнопку, чтобы вернуть сессию из архива.',
        ].join('\n');
        await this.client.sendMessage(chatId, body, undefined, keyboard);
    }
    /** Restore one session from the archive (host registry, DSH 0.2). */
    async unarchiveSessionById(chatId, sessionId, label) {
        const registry = hostService(this.ctx, 'workspaceRegistry');
        const call = registry?.unarchiveSession;
        if (typeof call !== 'function') {
            await this.client.sendMessage(chatId, 'Хост не умеет возвращать сессии из архива (нет workspaceRegistry).');
            return false;
        }
        try {
            await call.call(registry, sessionId);
        }
        catch (err) {
            await this.client.sendMessage(chatId, `Не удалось вернуть из архива: ${this.redact(err)}`);
            return false;
        }
        this.lastCatalog = undefined;
        await this.client.sendMessage(chatId, `↩ Сессия возвращена из архива: ${label ?? `…${sessionId.slice(-8)}`}`);
        return true;
    }
    /**
     * One page of real session history (user/assistant messages and tool calls as
     * spoilers) via the host session controller, newest page by default.
     */
    async fetchHistoryPage(sessionId, beforeSeq, maxMessages = 10) {
        const controller = hostService(this.ctx, 'sessionController');
        const page = controller?.page;
        if (typeof page !== 'function')
            return undefined;
        try {
            const res = await page.call(controller, {
                address: { kind: 'session', sessionId },
                throughSeq: -1,
                maxMessages,
                ...(beforeSeq !== undefined ? { beforeSeq } : {}),
            });
            const records = res?.records ?? [];
            const blocks = [];
            let earliest;
            for (const record of records) {
                const event = record?.event;
                if (!event?.type)
                    continue;
                if (typeof event.seq === 'number' && (earliest === undefined || event.seq < earliest))
                    earliest = event.seq;
                const data = (event.data ?? {});
                if (event.type === 'user/message') {
                    if (data.source?.kind !== undefined && data.source.kind !== 'user')
                        continue;
                    const text = contentToText(data.message?.content);
                    if (text.trim())
                        blocks.push(`👤 <b>Вы</b>\n${escapeHtml(text)}`);
                }
                else if (event.type === 'assistant/message') {
                    const text = contentToText(data.message?.content);
                    if (text.trim())
                        blocks.push(`🤖 <b>Ассистент</b>\n${escapeHtml(text)}`);
                }
                else if (event.type === 'tool/call') {
                    const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {});
                    blocks.push(this.spoilerBlock(`🛠 ${escapeHtml(String(data.name ?? 'tool'))}`, args));
                }
            }
            return { blocks, earliestSeq: earliest, hasMore: Boolean(res?.hasMore) };
        }
        catch (err) {
            this.ctx.logger.warn(`dsh-telegram-channel: history page failed: ${this.redact(err)}`);
            return undefined;
        }
    }
    /** Send a history page to the chat, with a "earlier" button when available. */
    async sendHistoryPage(chatId, sessionId, beforeSeq) {
        const page = await this.fetchHistoryPage(sessionId, beforeSeq);
        if (!page) {
            await this.client.sendMessage(chatId, 'История недоступна: хост не отдал страницу сессии.');
            return;
        }
        if (page.blocks.length === 0) {
            await this.client.sendMessage(chatId, beforeSeq === undefined ? 'Сообщений в сессии пока нет.' : 'Раньше сообщений нет.');
            return;
        }
        // Group events into messages below the Telegram limit.
        let buffer = '';
        const flush = async () => {
            if (!buffer.trim())
                return;
            await this.sendHtml(chatId, buffer);
            buffer = '';
        };
        for (const block of page.blocks) {
            if (buffer.length + block.length > 3500)
                await flush();
            buffer = buffer ? `${buffer}\n\n${block}` : block;
        }
        await flush();
        this.historyCursors.set(String(chatId), { sessionId, beforeSeq: page.earliestSeq });
        if (page.hasMore && page.earliestSeq !== undefined) {
            await this.client.sendMessage(chatId, 'Показаны последние сообщения. Ранее:', undefined, {
                inline_keyboard: [[{ text: '⬅ Раньше', callback_data: `${HIST_CB}${page.earliestSeq}` }]],
            });
        }
    }
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
                reasoningPrefs: Object.fromEntries([...this.reasoningPrefs].map(([chatId, on]) => [chatId, on ? 'on' : 'off'])),
                notifyPrefs: Object.fromEntries(this.notifyPrefs),
                notifyScope: Object.fromEntries(this.notifyScope),
                knownChats: [...this.knownChats],
                // Names for the Web settings page (who wrote to the bot) and the last
                // confirmed update offset, so a restart does not answer old updates twice.
                people: Object.fromEntries([...this.people].map(([id, person]) => [String(id), person])),
                ...(this.offset === undefined ? {} : { offset: this.offset }),
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
            for (const [chatId, mode] of Object.entries(data.reasoningPrefs ?? {})) {
                if (mode === 'on')
                    this.reasoningPrefs.set(String(chatId), true);
                else if (mode === 'off')
                    this.reasoningPrefs.set(String(chatId), false);
            }
            for (const [chatId, mode] of Object.entries(data.notifyPrefs ?? {})) {
                if (mode === 'all' || mode === 'errors' || mode === 'off') {
                    this.notifyPrefs.set(String(chatId), mode);
                }
            }
            for (const [chatId, scope] of Object.entries(data.notifyScope ?? {})) {
                if (scope === 'every' || scope === 'bound') {
                    this.notifyScope.set(String(chatId), scope);
                }
            }
            for (const chatId of data.knownChats ?? []) {
                if (Number.isFinite(chatId))
                    this.knownChats.add(Number(chatId));
            }
            for (const [key, person] of Object.entries(data.people ?? {})) {
                const id = Number(person?.id ?? key);
                if (!Number.isFinite(id) || id <= 0)
                    continue;
                this.people.set(id, {
                    id,
                    at: typeof person?.at === 'number' && Number.isFinite(person.at) ? person.at : Date.now(),
                    ...(typeof person?.name === 'string' && person.name.length > 0 ? { name: person.name } : {}),
                    ...(typeof person?.username === 'string' && person.username.length > 0 ? { username: person.username } : {}),
                });
            }
            if (typeof data.offset === 'number' && Number.isFinite(data.offset) && data.offset > 0) {
                // Constructor-provided offset wins: a live config reload passes the
                // offset of the bridge it replaces, which is newer than the file.
                this.offset = this.offset ?? data.offset;
            }
            if (n > 0)
                this.ctx.logger.info(`dsh-telegram-channel: restored ${n} binding(s) from disk`);
        }
        catch {
            // First run: no file yet.
        }
    }
    /** Inline actions on a turn/end notice: retry, continue, last answer, history. */
    turnNoticeKeyboard(sessionId, kind) {
        const rows = [];
        if (kind === 'error' && this.lastPromptBySession.has(sessionId)) {
            rows.push([{ text: MSG.RETRY_BUTTON, callback_data: `${RETRY_CB}${sessionId}` }]);
        }
        if (kind === 'max-tokens') {
            rows.push([{ text: MSG.CONTINUE_BUTTON, callback_data: `${CONTINUE_CB}${sessionId}` }]);
        }
        rows.push([{ text: MSG.NTF_LAST_BUTTON, callback_data: LAST_CB }]);
        if (kind === 'completed') {
            rows.push([{ text: MSG.NTF_HIST_BUTTON, callback_data: `${NTF_HIST_CB}${sessionId}` }]);
        }
        return { inline_keyboard: rows };
    }
    redact(value) {
        const message = value instanceof Error ? value.message : String(value);
        return message.split(this.token).join('***');
    }
}

import type { Context } from '@deepseek-ai/cordis';
import type { TelegramUserEntry } from './config.js';
import { type TelegramClientLike, type TelegramUpdate } from './client.js';
export interface TelegramBridgeOptions {
    token: string;
    allowedUserIds: number[];
    allowAllUsers: boolean;
    /** GUI-managed allowlist; `allowedUserIds` already carries the effective ids. */
    users?: TelegramUserEntry[];
    client?: TelegramClientLike;
    sleep?: (ms: number) => Promise<void>;
    maxMessageLength?: number;
    pollingTimeoutSec?: number;
    rendering?: 'rich' | 'html';
    /** `getUpdates` offset carried over from the previous bridge instance. */
    offset?: number;
}
/** One person the bot has seen in an update (kept for the Web settings page). */
export interface KnownPerson {
    id: number;
    name?: string;
    username?: string;
    /** Unix ms of the last update from this person. */
    at: number;
}
/** Bot identity reported by `getMe`, cached for the Web settings page. */
export interface BotIdentity {
    id: number;
    username?: string;
    name?: string;
}
/** Cap on a document we inline into a prompt (a phone should not paste a book). */
export declare const MAX_TEXT_FILE_BYTES: number;
/** One-shot reminder if a mirrored question is still unanswered after 5 minutes. */
export declare const ASK_REMINDER_MS: number;
export declare class TelegramBridge {
    private readonly ctx;
    private readonly token;
    private readonly allowedUserIds;
    private readonly allowAllUsers;
    /** Normalized GUI-managed allowlist (may be empty on legacy configs). */
    private readonly users;
    private readonly client;
    private readonly sleep;
    private readonly maxMessageLength;
    /** Global rendering mode: follows config; flipped to 'html' permanently when the
     *  Rich Message API itself is unavailable (a server-wide fact, not per-chat). */
    private renderingMode;
    /** Per-chat rendering override (persisted): rich messages need a recent Telegram
     *  client — old ones (e.g. 10.x) cannot render them and show “unsupported”. */
    private readonly renderPrefs;
    /** chatId → присылать рассуждения спойлером (по умолчанию да; persisted). */
    private readonly reasoningPrefs;
    private readonly bindings;
    private readonly pickers;
    /** Session names fetched from host projections, keyed by id and updatedAt. */
    private readonly titleCache;
    /** chatId → ждём путь нового проекта следующим сообщением. */
    private readonly pendingProject;
    /** chatId → какие события присылать: всё, только ошибки или ничего. */
    private readonly notifyPrefs;
    /** chatId → за какими сессиями следить: только за привязанной или за всеми. */
    private readonly notifyScope;
    /** Чаты, которые вообще писали боту: им можно присылать уведомления. */
    private readonly knownChats;
    /** People seen in updates: filled for the Web settings page (names, usernames). */
    private readonly people;
    /** Bot identity from `getMe`; refreshed on start and on demand. */
    private botInfo?;
    /** Why `getMe` failed (bad token, offline) — surfaced in the Web settings. */
    private botError?;
    /** When `botInfo`/`botError` was last written (ms). */
    private botCheckedAt;
    /** id → ms of a failed `getChat`, so a settings page refresh cannot hammer the API. */
    private readonly chatLookupFailed;
    /** Последний загруженный каталог — источник имён сессий для уведомлений. */
    private lastCatalog?;
    /** sessionId → накопленные рассуждения текущего шага (уходят спойлером). */
    private readonly reasoningBuffers;
    /** chatId → курсор для листания истории (beforeSeq) и признак «есть ещё». */
    private readonly historyCursors;
    /** chatId → model awaiting reasoning-effort pick (kept outside picker so list refreshes won't drop it). */
    private readonly pendingModels;
    private polling;
    private offset;
    private pollPromise;
    private pollAbort;
    private disposeSessionListener;
    private disposeQuestionHook;
    /** sessionIds mid-turn (busy feedback, /stop state) */
    private readonly busySessions;
    /** chatId → typing heartbeat interval handle */
    private readonly heartbeats;
    /** chatId → serialized notice chain (prevents 429 storms) */
    private readonly noticeQueue;
    private readonly pendingAsks;
    private readonly pendingApprovalsTG;
    private disposeApprovalHook;
    /** sessionId → thinking indicator state (one notice per reasoning phase) */
    private readonly thinkingSessions;
    /** callId → tool name (tool/result failure notices) */
    private readonly callNames;
    /** sessionId → latest todo snapshot (/mission) */
    private readonly lastTodos;
    /** sessionId → in-flight manual compaction (dedup /compact) */
    private readonly compacting;
    /** sessionId → compaction abort controller (cancelled on bridge stop) */
    private readonly compactAborts;
    /** Album accumulation: chatId:media_group_id → parts buffered into one prompt. */
    private readonly mediaGroups;
    /** sessionId → last text prompt sent from Telegram (for /retry and the 🔁 button). */
    private readonly lastPromptBySession;
    constructor(ctx: Context, options: TelegramBridgeOptions);
    /** Effective rendering mode for a chat: per-chat override, else the global mode. */
    private modeFor;
    start(): void;
    stop(): Promise<void>;
    /** Last confirmed `getUpdates` offset — carried into the next bridge instance. */
    get currentOffset(): number | undefined;
    /** Whether the long-poll loop is running (the Web settings page shows this). */
    get running(): boolean;
    /**
     * Ask Telegram who this token belongs to and cache the answer.
     * A rejected token is a normal outcome here — it is reported, not thrown, so
     * the settings page can say “Telegram did not accept this token”.
     * @param force - bypass the cache (the settings page's Refresh button).
     */
    refreshBotInfo(force?: boolean): Promise<void>;
    /** The cached bot identity / error, refreshing once when nothing is cached yet. */
    selectedBot(): Promise<{
        bot?: BotIdentity;
        error?: string;
        checkedAt: number;
    }>;
    /**
     * Everything the Web settings page shows about the running bot: identity,
     * the allowlist as configured, and the people the bot has actually seen.
     * The token itself never crosses this boundary.
     */
    describeSettings(): Promise<{
        running: boolean;
        tokenSet: boolean;
        bot?: BotIdentity;
        error?: string;
        allowAllUsers: boolean;
        users: Array<TelegramUserEntry & {
            name?: string;
            username?: string;
            bound: boolean;
        }>;
        people: KnownPerson[];
        bindings: Array<{
            chatId: number;
            sessionId: string;
            label: string;
        }>;
    }>;
    /**
     * Resolve one person the owner typed: a numeric id or an `@username`.
     * `getChat` is the only Bot API call that finds a user by handle, and it only
     * answers for users the bot has interacted with.
     * @param query - `@name`, `name`, or a numeric Telegram user id.
     */
    resolvePerson(query: string): Promise<{
        id: number;
        name?: string;
        username?: string;
    }>;
    /** Configured people, with the legacy flat list presented as entries of its own. */
    private effectiveEntries;
    /** Record the person behind an update (name and @username for the settings page). */
    private rememberPerson;
    processUpdate(update: TelegramUpdate): Promise<void>;
    private handleCallback;
    private resolveCatalog;
    /** Chat remembering: any authorized contact may receive notifications. */
    private rememberChat;
    private notifyScopeFor;
    /** Human name of a session for lifecycle notifications. */
    /**
     * Async label for notifications: when the catalog row has no real title yet
     * (`named === false`), ask the host for the session projections — that yields
     * the session title or its first message instead of an id tail. The result is
     * cached back into the catalog row so later events are cheap.
     */
    private sessionLabelFor;
    private sessionLabel;
    /** Project (workspace) a session belongs to: registry match, else cwd basename. */
    private projectLabel;
    /** Warm the catalog so notifications can name sessions and projects. */
    private prefetchCatalog;
    /**
     * Chats that must hear about lifecycle events of this session: those bound
     * to it, plus every chat following "every session" (the default), so a task
     * started on the desktop still pings the phone.
     */
    private lifecycleTargets;
    private sendWorkspacePicker;
    /**
     * Button caption for one session: `N. <name> <state>`. The name is the Web
     * session title (the catalog falls back to `workspace · date`), so the phone
     * list reads like the desktop sidebar instead of bare numbers.
     * ▶ = the session is live in memory, ▷ = parked (resumed on attach).
     */
    private sessionButtonText;
    /**
     * Fill in real session names for the rows the picker is about to show.
     * `sessions.list` leaves cold sessions without a projection block, so ask the
     * host per session (cached by updatedAt) — that is what makes a button read
     * like the Web sidebar instead of "workspace · date".
     */
    private ensureSessionNames;
    private sendSessionPicker;
    /** Archived sessions of one workspace, each with a restore button. */
    private sendArchivedInWorkspace;
    private bindSession;
    private sendLastTurn;
    private sendModelPicker;
    private sendEffortPicker;
    private applyModel;
    private liveAgents;
    private findLiveAgent;
    /** Resume cold sessions when needed; never dispose the returned handle. */
    private ensureLiveAgent;
    private sendStatus;
    /** 按 sessionId 解析工作区：apiProxy 目录优先，冷/热会话均可用；退化为 agent cwd。 */
    private workspaceOf;
    /** 从 sessionProjections 快照读 Web 底部同款统计（sessionStats/tokenUsage/contextPressure）。 */
    private readRuntimeValues;
    /** 按名称解析宿主服务（Cordis 需 ctx.get；mock/plain ctx 走自有属性兜底）。 */
    private serviceOf;
    private requestCompact;
    /** 等待压缩落定并汇报结果（不阻塞轮询循环）。 */
    private runCompaction;
    private followupBound;
    /** Send text to an explicit session (notification buttons work across bindings). */
    private followupSession;
    private deliverPrompt;
    /** /retry: re-send the last text prompt of this chat's session. */
    private retryLastPrompt;
    /**
     * Extract wire prompt parts from a media message.
     * Returns undefined when the message carries no media at all; returns [] for
     * an unsupported media type (the user was already notified); otherwise the
     * caption text part (when present) followed by the image part.
     */
    private isImageDocument;
    private isTextDocument;
    /**
     * Download a text document and deliver it as prompt text (with the caption).
     * Binary documents are refused with an explicit notice — they would arrive as
     * mojibake, and there is no attachment seam for arbitrary files.
     */
    private handleTextDocument;
    private collectMediaParts;
    /** Download one TG file and encode it as a canonical-base64 wire image part. */
    private downloadImagePart;
    /**
     * Album photos arrive as separate updates sharing a media_group_id — debounce
     * them into ONE prompt so an album does not spawn N sequential turns.
     */
    private accumulateMediaGroup;
    /**
     * Dispatch an image-bearing message to the bound session through the host
     * prompt RPC — the exact channel the Web composer uses. The host checks
     * whether the current model accepts image input, admits the bytes into the
     * durable attachment store, then queues the message on the agent (mode
     * 'queue' — same semantics as the text path's agent.followup).
     */
    private sendImageFollowup;
    private pollLoop;
    private interruptibleDelay;
    private interruptibleSleep;
    private onSessionEvent;
    private handleRichCommand;
    private deliver;
    private deliverHtml;
    /** Retry an outbound call with capped linear backoff (500ms, 1s, 2s… max 4s). */
    private withRetry;
    /**
     * Send a notice; a leading `> ` keeps the quote look via a plain-text `> `
     * prefix. NB: NOT `<blockquote>` HTML — older Telegram clients cannot render
     * the blockquote entity at all and show the whole message as “not supported”.
     * Falls back to plain text when the send fails — a notice is never lost.
     */
    private deliverNotice;
    /** Serialized per-chat notice chain — bursts can't race into Telegram 429s. */
    private enqueueNotice;
    private startTypingHeartbeat;
    private stopTypingHeartbeat;
    private stopAllHeartbeats;
    /**
     * Mirror the host's agent-scoped waterfall request to Telegram. The next
     * handler remains the Web answer path; NO_PROVIDER means no Web answerer is
     * available, so keep waiting for Telegram instead of failing the request.
     */
    private onUserQuestionRequest;
    private registerTgAsk;
    /** Send one message per question, each with its own inline keyboard. */
    private offerAskChat;
    /** `A. label ✓` buttons; multiSelect adds «Готово», every question adds «Свой ответ». */
    private askKeyboard;
    private formatAskQuestion;
    private settleGuiSide;
    private discardTgAsk;
    /** Answer arrives from a button or a typed answer: mark the message, check completion. */
    private markAskAnswered;
    private refreshAskKeyboard;
    /** Drop inline keyboards that can no longer be used (answered in Web, /cancel, abort). */
    private clearAskKeyboards;
    /** One gentle reminder; never repeats, never keeps the process alive. */
    private armAskReminder;
    private clearAskReminder;
    private maybeResolveAsk;
    private handleAskCallback;
    /** Text typed after «✏️ Свой ответ» answers exactly that question. */
    private handleAskCustomText;
    private handleTgAnswer;
    private onApprovalRequest;
    private handleTgApproval;
    private clearApprovalKeyboard;
    private handleApprovalCallback;
    private stopBound;
    private sendMission;
    /** /history [beforeSeq]: показать предыдущие сообщения сессии. */
    private handleHistoryCommand;
    /** /find <text>: search session titles and folders, then bind with a button. */
    private handleFindCommand;
    /** /new: create a session in the bound session's workspace and attach to it. */
    private newSessionHere;
    /**
     * Create a session in a workspace (or a directory) and bind the chat to it.
     * Works on both host generations: `sessionController.create` on DSH 0.2 and
     * `apiProxy.sessions.create` on 0.1.x.
     */
    private createSessionInTarget;
    /** /newproject: add a directory to the workspace registry (DSH 0.2). */
    private createWorkspaceFromText;
    /** /archive: move the bound session to the archive and unbind the chat. */
    private archiveBound;
    /**
     * Archive one session through the host registry. `stopActivity` is requested
     * so a running session is stopped instead of being refused: an archived
     * session must not keep burning tokens.
     */
    private archiveSessionById;
    /** /notify: what this chat receives, and about which sessions. */
    private handleNotifyCommand;
    private notificationMode;
    /** Human explanation for a failed turn, with a hint for the usual causes. */
    private describeTurnError;
    /** «1 сессия / 2 сессии / 5 сессий» */
    private ruCount;
    /** Send pre-built HTML; if Telegram rejects the markup, fall back to plain. */
    private sendHtml;
    /** Collapsible block: Telegram shows it as "expandable quote", hidden by default. */
    private spoilerBlock;
    /** Whether this chat wants the model's reasoning as a spoiler (default: yes). */
    private showReasoning;
    /** Flush streamed reasoning of one session as a spoiler block (fallback path). */
    private flushReasoning;
    /** `/reasoning [on|off]` — remember whether reasoning is mirrored into this chat. */
    private handleReasoningCommand;
    /** List archived sessions with one-tap restore. */
    private sendArchivedPicker;
    /** Restore one session from the archive (host registry, DSH 0.2). */
    private unarchiveSessionById;
    /**
     * One page of real session history (user/assistant messages and tool calls as
     * spoilers) via the host session controller, newest page by default.
     */
    private fetchHistoryPage;
    /** Send a history page to the chat, with a "earlier" button when available. */
    private sendHistoryPage;
    private bindingsPath;
    private saveBindings;
    private loadBindings;
    /** Inline actions on a turn/end notice: retry, continue, last answer, history. */
    private turnNoticeKeyboard;
    private redact;
}

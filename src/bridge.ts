import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm/message'
import type { ContentBlock, TextBlock } from '@deepseek-ai/dsh-llm/types'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { isAuthorized } from './auth.js'
import { resolveApiProxy } from './apiproxy.js'
import {
  catalogFromLiveAgents,
  hostService,
  resolveSessionTitle,
  loadCatalog,
  truncateButton,
  visibleSessionsForWorkspace,
  type CatalogSnapshot,
  type SessionRow,
  type WorkspaceRow,
} from './catalog.js'
import {
  TelegramClient,
  type InlineKeyboardMarkup,
  type TelegramClientLike,
  type TelegramMessage,
  type TelegramUpdate,
} from './client.js'
import { MSG, LAST_CB, parseCommand } from './commands.js'
import { escapeHtml, markdownToHtml, splitMessage } from './format.js'
import { splitRichMarkdown } from './rich-format.js'
import { formatLastTurn, loadLastTurn } from './history.js'
import { describeAgent, displayLabel, workspaceName } from './label.js'
import {
  formatModel,
  loadSessionModels,
  selectSessionModel,
  type ModelOption,
} from './models.js'
import {
  formatStatusText,
  type StatusInfo,
  type StatusRuntime,
  type StatusWorkspace,
} from './status.js'

export interface TelegramBridgeOptions {
  token: string
  allowedUserIds: number[]
  allowAllUsers: boolean
  client?: TelegramClientLike
  sleep?: (ms: number) => Promise<void>
  maxMessageLength?: number
  pollingTimeoutSec?: number
  rendering?: 'rich' | 'html'
}

/** chatId → bound live session id (string form of SessionId) */
interface Binding {
  chatId: number
  sessionId: string
  label: string
}

interface PickerState {
  workspaces: WorkspaceRow[]
  /** индекс области, чьи сессии сейчас показаны (для кнопок создания/архива) */
  workspaceIndex?: number
  sessions: SessionRow[]
  catalog?: CatalogSnapshot
  models?: ModelOption[]
  pendingModel?: ModelOption
}

interface SessionLike {
  id: ReturnType<typeof SessionId>
}

/** ── Stability & interactivity additions: local types (host seam shapes mirrored structurally) ── */

interface TgQuestionItem {
  id?: string
  question?: string
  options?: Array<{ label: string; description?: string }>
  multiSelect?: boolean
}

interface TgAnswerHandle {
  resolve: (answer: unknown) => void
  reject: (err: Error) => void
  answered: boolean
}

/** chatId → pending ask_user_question mirrored to Telegram. */
interface TgPendingAsk {
  req: unknown
  sessionId: string
  questions: TgQuestionItem[]
  ask: TgAnswerHandle
  at: number
}

/** chatId → pending approval request mirrored to Telegram. */
interface TgPendingApproval {
  toolName: string
  ask: TgAnswerHandle
}

/** Structural view of the user-questions seam (types live in the host's dsh-user-questions package). */
interface UserQuestionRequestLike {
  agent?: Agent
  questions?: TgQuestionItem[]
  signal?: AbortSignal
}

/** Loose view of the approval request passed through the `approval/request` waterfall hook. */
interface ApprovalRequestLike {
  agent?: Agent
  toolName?: string
  reason?: string
  signal?: AbortSignal
}

/** ── /status 与 /compact 需要的宿主缝隙（结构镜像，避免引入额外依赖）── */

/** 会话投影注册表（只读使用 snapshot）：对齐 Web 底部统计条的数据源。 */
interface ProjectionRegistryLike {
  snapshot?: (session: unknown) => { asOfSeq: number; values: Record<string, unknown> } | undefined
}

/**
 * 命令运行时（结构镜像 ctx.commands.execute）。
 *
 * /compact 不在插件可见作用域内直接提供 compaction 服务（compaction-basic 挂载在
 * 隔离作用域，ctx.get 取不到），但宿主命令运行时可见，且 command-compact 已把
 * /compact 注册进该运行时的按 agent 作用层 —— Web 端正是用 execute() 派发它的。
 * TG 端复用同一条通道：语义、busy/错误映射、命令生命周期日志与 Web 完全一致。
 */
interface CommandsRuntimeLike {
  find?: (agent: unknown, name: string) => unknown
  execute?: (
    agent: unknown,
    line: string,
    images: readonly unknown[],
    signal: AbortSignal,
  ) => Promise<{ commandId: string; result: { kind: string; text?: string } } | undefined>
}

/** command-compact 的 CommandResult.kind 值。 */
type CompactCommandKind = 'success' | 'error'

/** Wire prompt content part (mirrors host PromptContentPart): text or base64 image. */
type WireContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }

/** Host-admitted raster media types (@deepseek-ai/dsh-attachment). */
const IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Album debounce window: TG emits each photo of an album as its own update. */
const MEDIA_GROUP_WINDOW_MS = 1200

/**
 * 把 command-compact 返回的英文结果翻译成 TG 中文回复。
 * 文案以宿主 @deepseek-ai/dsh-command-compact 的固定输出为准；无法识别时返回
 * undefined，由调用方回退为「压缩失败 + 原文详情」。
 */
function translateCompactResult(result: { kind: string; text?: string } | undefined): string | undefined {
  const kind = result?.kind as CompactCommandKind | undefined
  const text = result?.text ?? ''
  if (kind === 'success') {
    const m = /Compacted (\d+) history items \(~(\d+) tokens\)/.exec(text)
    if (m) return MSG.COMPACT_DONE(Number(m[1]), Number(m[2]))
    if (/No compactable history yet/.test(text)) return MSG.COMPACT_NOTHING
    return undefined
  }
  if (kind === 'error') {
    if (/active compaction|not idle/.test(text)) return MSG.COMPACT_BUSY
    if (/^Compaction cancelled/.test(text)) return MSG.COMPACT_CANCELLED
    if (/history selected for compaction changed/.test(text)) return MSG.COMPACT_CHANGED
    if (/could not produce a useful summary/.test(text)) return MSG.COMPACT_SUMMARY_FAILED
    if (/did not finish cleanly/.test(text)) return MSG.COMPACT_COMMIT_FAILED
    if (/could not be saved/.test(text)) return MSG.COMPACT_PERSIST_FAILED
    return undefined
  }
  return undefined
}

const WS_CB = 'ws:'
const SID_CB = 'sid:'
const BACK_WS_CB = 'wb'
const MODEL_CB = 'mdl:'
/** Use eff: (not me:) — short prefix, no collision with other callbacks. */
const EFFORT_CB = 'eff:'
const BACK_MODEL_CB = 'mb'
/** Архивировать сессию из пикера: arc:<индекс в списке>. */
const ARC_CB = 'arc:'
/** Создать сессию в области: ns:<индекс области>. */
const NEW_SID_CB = 'ns:'
/** «Новый проект»: плагин ждёт путь следующим сообщением. */
const NEW_WS_CB = 'nw'
/** Вернуть сессию из архива: unarc:<индекс в списке архива>. */
const UNARC_CB = 'unarc:'
/** Пролистать историю назад: hist:<beforeSeq>. */
const HIST_CB = 'hist:'
const MAX_BUTTONS = 40

function lastContextKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: 'Последний диалог', callback_data: LAST_CB }]],
  }
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function contentToText(content: readonly ContentBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function isRichUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /method not found|unknown method|not found|404|bad request|can't parse|rich message/i.test(message)
}

function isNoQuestionAnswererError(err: unknown): boolean {
  const message = err instanceof Error
    ? err.message
    : String((err as { message?: unknown } | null)?.message ?? err)
  return /NO_PROVIDER|no user-questions answerer/i.test(message)
}

export class TelegramBridge {
  private readonly ctx: Context
  private readonly token: string
  private readonly allowedUserIds: number[]
  private readonly allowAllUsers: boolean
  private readonly client: TelegramClientLike
  private readonly sleep: (ms: number) => Promise<void>
  private readonly maxMessageLength: number
  /** Global rendering mode: follows config; flipped to 'html' permanently when the
   *  Rich Message API itself is unavailable (a server-wide fact, not per-chat). */
  private renderingMode: 'rich' | 'html'
  /** Per-chat rendering override (persisted): rich messages need a recent Telegram
   *  client — old ones (e.g. 10.x) cannot render them and show “unsupported”. */
  private readonly renderPrefs = new Map<string, 'rich' | 'html'>()

  private readonly bindings = new Map<string, Binding>()
  private readonly pickers = new Map<string, PickerState>()
  /** Session names fetched from host projections, keyed by id and updatedAt. */
  private readonly titleCache = new Map<string, { at: number; title: string }>()
  /** chatId → ждём путь нового проекта следующим сообщением. */
  private readonly pendingProject = new Set<number>()
  /** chatId → какие события присылать: всё, только ошибки или ничего. */
  private readonly notifyPrefs = new Map<string, 'all' | 'errors' | 'off'>()
  /** chatId → за какими сессиями следить: только за привязанной или за всеми. */
  private readonly notifyScope = new Map<string, 'bound' | 'every'>()
  /** Чаты, которые вообще писали боту: им можно присылать уведомления. */
  private readonly knownChats = new Set<number>()
  /** Последний загруженный каталог — источник имён сессий для уведомлений. */
  private lastCatalog?: CatalogSnapshot
  /** sessionId → накопленные рассуждения текущего шага (уходят спойлером). */
  private readonly reasoningBuffers = new Map<string, string>()
  /** chatId → курсор для листания истории (beforeSeq) и признак «есть ещё». */
  private readonly historyCursors = new Map<string, { sessionId: string; beforeSeq?: number }>()
  /** chatId → model awaiting reasoning-effort pick (kept outside picker so list refreshes won't drop it). */
  private readonly pendingModels = new Map<string, ModelOption>()
  private polling = false
  private offset: number | undefined
  private pollPromise: Promise<void> | undefined
  private pollAbort: AbortController | undefined
  private disposeSessionListener: (() => void) | undefined
  private disposeQuestionHook: (() => void) | undefined

  // ── Stability & interactivity additions ──
  /** sessionIds mid-turn (busy feedback, /stop state) */
  private readonly busySessions = new Set<string>()
  /** chatId → typing heartbeat interval handle */
  private readonly heartbeats = new Map<string, ReturnType<typeof setInterval>>()
  /** chatId → serialized notice chain (prevents 429 storms) */
  private readonly noticeQueue = new Map<string, Promise<unknown>>()
  private readonly pendingAsks = new Map<string, TgPendingAsk>()
  private readonly pendingApprovalsTG = new Map<string, TgPendingApproval>()
  private disposeApprovalHook: (() => void) | undefined
  /** sessionId → thinking indicator state (one notice per reasoning phase) */
  private readonly thinkingSessions = new Map<string, boolean>()
  /** callId → tool name (tool/result failure notices) */
  private readonly callNames = new Map<string, string>()
  /** sessionId → latest todo snapshot (/mission) */
  private readonly lastTodos = new Map<string, Array<{ content?: string; status?: string }>>()
  /** sessionId → in-flight manual compaction (dedup /compact) */
  private readonly compacting = new Set<string>()
  /** sessionId → compaction abort controller (cancelled on bridge stop) */
  private readonly compactAborts = new Map<string, AbortController>()
  /** Album accumulation: chatId:media_group_id → parts buffered into one prompt. */
  private readonly mediaGroups = new Map<string, { chatId: number; parts: WireContentPart[]; timer?: ReturnType<typeof setTimeout> }>()

  constructor(ctx: Context, options: TelegramBridgeOptions) {
    this.ctx = ctx
    this.token = options.token
    this.allowedUserIds = options.allowedUserIds
    this.allowAllUsers = options.allowAllUsers
    this.client = options.client ?? new TelegramClient(options.token, {
      pollingTimeoutSec: options.pollingTimeoutSec ?? 30,
    })
    this.sleep = options.sleep ?? defaultSleep
    this.maxMessageLength = options.maxMessageLength ?? 4096
    // Compat-first default: only an explicit `rendering: 'rich'` opts into rich
    // messages, because old Telegram clients (10.x) cannot render them at all.
    this.renderingMode = options.rendering === 'rich' ? 'rich' : 'html'
  }

  /** Effective rendering mode for a chat: per-chat override, else the global mode. */
  private modeFor(chatId: number): 'rich' | 'html' {
    return this.renderPrefs.get(String(chatId)) ?? this.renderingMode
  }

  start(): void {
    this.disposeSessionListener?.()
    this.disposeSessionListener = this.ctx.on('session/event', (session, event) => {
      void this.onSessionEvent(session, event).catch((err) => {
        this.ctx.logger.error(this.redact(err))
      })
    })
    // Restore persisted bindings (survive hot reload / restart) and install
    // the TG answering hooks (ask_user dual-path + approval dual-path).
    this.loadBindings()
    this.disposeQuestionHook?.()
    this.disposeQuestionHook = (this.ctx as unknown as {
      on: (
        event: string,
        handler: (request: UserQuestionRequestLike, next: () => Promise<unknown>) => Promise<unknown>,
      ) => () => void
    }).on('user-questions/request', (request, next) => this.onUserQuestionRequest(request, next))
    this.disposeApprovalHook?.()
    this.disposeApprovalHook = (this.ctx as unknown as {
      on: (event: string, handler: (req: ApprovalRequestLike, next: () => Promise<string>) => Promise<string>) => () => void
    }).on('approval/request', (req, next) => this.onApprovalRequest(req, next))
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
      { command: 'newproject', description: 'Добавить папку как проект' },
      { command: 'archive', description: 'Убрать сессию в архив' },
      { command: 'archived', description: 'Список архива — вернуть сессию' },
      { command: 'history', description: 'Предыдущие сообщения сессии' },
      { command: 'notify', description: 'Уведомления: on/errors/off, every/bound' },
      { command: 'cancel', description: 'Закрыть ответы/подтверждения в TG' },
      { command: 'help', description: 'Помощь' },
    ]).then(() => {
      this.ctx.logger.info('dsh-telegram-channel: bot commands registered')
    }).catch((err) => {
      this.ctx.logger.warn(`dsh-telegram-channel: setMyCommands failed: ${this.redact(err)}`)
    })
    // Bot profile card (what a stranger sees before /start) — empty by default.
    void this.client.setMyShortDescription(
      'Telegram-пульт для DeepSeek Harness: та же сессия, что на компьютере',
    ).catch((err) => {
      this.ctx.logger.warn(`dsh-telegram-channel: setMyShortDescription failed: ${this.redact(err)}`)
    })
    void this.client.setMyDescription([
      'Пульт для DeepSeek Harness: телефон подключается к уже идущей сессии на компьютере.',
      'Один диалог, две стороны — Web и Telegram видят одну и ту же переписку.',
      '',
      'Нажмите /sessions, выберите рабочую область и сессию — дальше просто пишите.',
      'Доступ только для пользователей из белого списка.',
    ].join('\n')).catch((err) => {
      this.ctx.logger.warn(`dsh-telegram-channel: setMyDescription failed: ${this.redact(err)}`)
    })
    // Names for lifecycle notifications come from the catalog: warm it at boot.
    // At this instant the host services are not registered yet (the plugin
    // mounts first), so warm again shortly after — that pass sees the services
    // and every stored session with its projection.
    this.prefetchCatalog()
    const reWarm = setTimeout(() => this.prefetchCatalog(), 4000)
    if (typeof (reWarm as { unref?: () => void }).unref === 'function') (reWarm as { unref: () => void }).unref()
    if (!this.polling) {
      this.polling = true
      this.pollAbort = new AbortController()
      this.ctx.logger.info('dsh-telegram-channel: long-polling started')
      this.pollPromise = this.pollLoop()
    }
  }

  async stop(): Promise<void> {
    this.polling = false
    this.pollAbort?.abort()
    this.pollAbort = undefined
    this.disposeSessionListener?.()
    this.disposeSessionListener = undefined
    this.disposeQuestionHook?.()
    this.disposeQuestionHook = undefined
    // Never dispose host agents — only clear remote bindings.
    this.bindings.clear()
    this.renderPrefs.clear()
    this.pickers.clear()
    this.pendingModels.clear()
    this.stopAllHeartbeats()
    this.busySessions.clear()
    this.noticeQueue.clear()
    this.pendingAsks.clear()
    this.pendingApprovalsTG.clear()
    this.thinkingSessions.clear()
    this.callNames.clear()
    this.lastTodos.clear()
    for (const controller of this.compactAborts.values()) controller.abort()
    this.compactAborts.clear()
    this.compacting.clear()
    for (const group of this.mediaGroups.values()) clearTimeout(group.timer)
    this.mediaGroups.clear()
    this.disposeApprovalHook?.()
    this.disposeApprovalHook = undefined
    if (this.pollPromise) {
      await this.pollPromise.catch(() => {})
      this.pollPromise = undefined
    }
  }

  async processUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      await this.handleCallback(update)
      return
    }
    const message = update.message
    if (!message) return

    const chatId = message.chat.id
    const userId = message.from?.id

    if (!isAuthorized({ allowAllUsers: this.allowAllUsers, allowedUserIds: this.allowedUserIds, userId })) {
      await this.client.sendMessage(chatId, MSG.DENIED)
      return
    }
    this.rememberChat(chatId)

    // Media messages: photos / image documents (optionally with a caption) are
    // admitted into the bound session; other media get an explicit notice.
    // A caption is treated as accompanying text — never parsed as a command.
    const mediaParts = await this.collectMediaParts(chatId, message)
    if (mediaParts !== undefined) {
      if (mediaParts.length > 0) {
        if (message.media_group_id) this.accumulateMediaGroup(chatId, message.media_group_id, mediaParts)
        else await this.sendImageFollowup(chatId, mediaParts)
      }
      return
    }

    // Non-text messages without recognized media: tell the (authorized) user
    // instead of dropping silently.
    if (!message.text) {
      await this.enqueueNotice(chatId, MSG.MEDIA_UNSUPPORTED)
      return
    }

    // «Новый проект» ждёт путь. Абсолютный путь начинается с «/», поэтому
    // здесь текст не разбирается как команда — исключение только /cancel.
    if (this.pendingProject.has(chatId)) {
      this.pendingProject.delete(chatId)
      const answer = message.text.trim()
      if (answer === '/cancel') {
        await this.client.sendMessage(chatId, MSG.NEWPROJECT_CANCELLED)
        return
      }
      await this.createWorkspaceFromText(chatId, message.text)
      return
    }

    const parsed = parseCommand(message.text)
    switch (parsed.type) {
      case 'start':
        await this.client.sendMessage(chatId, MSG.WELCOME)
        return
      case 'help':
        await this.client.sendMessage(chatId, MSG.HELP)
        return
      case 'sessions':
        await this.sendWorkspacePicker(chatId)
        return
      case 'last':
        await this.sendLastTurn(chatId)
        return
      case 'model':
        await this.sendModelPicker(chatId)
        return
      case 'status':
        await this.sendStatus(chatId)
        return
      case 'compact':
        await this.requestCompact(chatId)
        return
      case 'rich':
        await this.handleRichCommand(chatId, parsed.arg)
        return
      case 'unbind':
        this.bindings.delete(String(chatId))
        this.pickers.delete(String(chatId))
        this.pendingAsks.delete(String(chatId))
        this.saveBindings()
        await this.client.sendMessage(chatId, MSG.UNBOUND)
        return
      case 'stop':
        await this.stopBound(chatId)
        return
      case 'mission':
        await this.sendMission(chatId)
        return
      case 'new':
        await this.newSessionHere(chatId)
        return
      case 'archive':
        await this.archiveBound(chatId)
        return
      case 'notify':
        await this.handleNotifyCommand(chatId, parsed.arg)
        return
      case 'newproject':
        if (!parsed.arg || !parsed.arg.trim()) {
          await this.client.sendMessage(chatId, MSG.NEWPROJECT_PROMPT)
          return
        }
        await this.createWorkspaceFromText(chatId, parsed.arg)
        return
      case 'projects':
        await this.sendWorkspacePicker(chatId)
        return
      case 'archived':
        await this.sendArchivedPicker(chatId)
        return
      case 'history':
        await this.handleHistoryCommand(chatId, parsed.arg)
        return
      case 'cancel': {
        // /cancel closes the TG-side answer/approval channel; the UI side stays open.
        let cancelled = false
        if (this.pendingApprovalsTG.delete(String(chatId))) cancelled = true
        if (this.pendingAsks.delete(String(chatId))) cancelled = true
        if (cancelled)
          await this.enqueueNotice(chatId, 'Ответы/подтверждения в Telegram закрыты (в Web вопрос по-прежнему доступен)')
        else
          await this.client.sendMessage(chatId, 'Сейчас нет вопросов или подтверждений, ждущих ответа')
        return
      }
      case 'unknown':
        await this.client.sendMessage(chatId, MSG.unknown(parsed.command))
        return
      case 'plain': {
        // A pending approval/ask on TG consumes the message as an answer.
        const approval = this.pendingApprovalsTG.get(String(chatId))
        if (approval) {
          await this.handleTgApproval(chatId, approval, parsed.text)
          return
        }
        const pending = this.pendingAsks.get(String(chatId))
        if (pending) {
          await this.handleTgAnswer(chatId, pending, parsed.text)
          return
        }
        await this.followupBound(chatId, parsed.text)
        return
      }
    }
  }

  private async handleCallback(update: TelegramUpdate): Promise<void> {
    const cq = update.callback_query!
    const userId = cq.from.id
    const chatId = cq.message?.chat.id
    if (chatId === undefined) {
      await this.client.answerCallbackQuery(cq.id)
      return
    }
    if (!isAuthorized({ allowAllUsers: this.allowAllUsers, allowedUserIds: this.allowedUserIds, userId })) {
      await this.client.answerCallbackQuery(cq.id, MSG.DENIED)
      await this.client.sendMessage(chatId, MSG.DENIED)
      return
    }
    this.rememberChat(chatId)
    const data = cq.data ?? ''
    const picker = this.pickers.get(String(chatId))

    if (data === LAST_CB) {
      await this.client.answerCallbackQuery(cq.id)
      await this.sendLastTurn(chatId)
      return
    }
    if (data === BACK_WS_CB) {
      await this.client.answerCallbackQuery(cq.id)
      await this.sendWorkspacePicker(chatId, picker?.catalog)
      return
    }
    if (data === BACK_MODEL_CB) {
      await this.client.answerCallbackQuery(cq.id)
      await this.sendModelPicker(chatId)
      return
    }
    if (data.startsWith(WS_CB)) {
      const index = Number(data.slice(WS_CB.length))
      await this.client.answerCallbackQuery(cq.id)
      await this.sendSessionPicker(chatId, index)
      return
    }
    if (data.startsWith(SID_CB)) {
      const index = Number(data.slice(SID_CB.length))
      const row = picker?.sessions[index]
      if (!row) {
        await this.client.answerCallbackQuery(cq.id, 'Сессия устарела')
        await this.client.sendMessage(chatId, MSG.PICKER_STALE)
        return
      }
      await this.bindSession(chatId, cq.id, row)
      return
    }
    if (data.startsWith(HIST_CB)) {
      const beforeSeq = Number(data.slice(HIST_CB.length))
      const cursor = this.historyCursors.get(String(chatId))
      const sessionId = cursor?.sessionId ?? this.bindings.get(String(chatId))?.sessionId
      await this.client.answerCallbackQuery(cq.id)
      if (!sessionId) {
        await this.client.sendMessage(chatId, MSG.NEED_BIND)
        return
      }
      await this.sendHistoryPage(chatId, sessionId, Number.isFinite(beforeSeq) ? beforeSeq : undefined)
      return
    }
    if (data.startsWith(UNARC_CB)) {
      const index = Number(data.slice(UNARC_CB.length))
      const row = picker?.sessions[index]
      if (!row) {
        await this.client.answerCallbackQuery(cq.id, 'Список устарел')
        await this.client.sendMessage(chatId, MSG.PICKER_STALE)
        return
      }
      await this.client.answerCallbackQuery(cq.id, 'Возвращаю')
      const restored = await this.unarchiveSessionById(chatId, row.sessionId, row.title)
      if (restored) await this.sendArchivedPicker(chatId)
      return
    }
    if (data === NEW_WS_CB) {
      await this.client.answerCallbackQuery(cq.id, 'Жду путь к папке')
      this.pendingProject.add(chatId)
      await this.client.sendMessage(chatId, MSG.NEWPROJECT_PROMPT)
      return
    }
    if (data.startsWith(NEW_SID_CB)) {
      const index = Number(data.slice(NEW_SID_CB.length))
      const ws = picker?.workspaces?.[index] ?? (await this.resolveCatalog()).workspaces[index]
      if (!ws) {
        await this.client.answerCallbackQuery(cq.id, 'Область устарела')
        await this.client.sendMessage(chatId, MSG.PICKER_STALE)
        return
      }
      await this.client.answerCallbackQuery(cq.id, 'Создаю сессию')
      await this.createSessionInTarget(chatId, { workspaceId: ws.id })
      return
    }
    if (data.startsWith(ARC_CB)) {
      const index = Number(data.slice(ARC_CB.length))
      const row = picker?.sessions[index]
      if (!row) {
        await this.client.answerCallbackQuery(cq.id, 'Сессия устарела')
        await this.client.sendMessage(chatId, MSG.PICKER_STALE)
        return
      }
      await this.client.answerCallbackQuery(cq.id, 'В архив')
      const archived = await this.archiveSessionById(chatId, row.sessionId, row.title)
      if (archived) {
        const wsIndex = picker?.workspaceIndex
        await this.sendSessionPicker(chatId, wsIndex ?? 0)
      }
      return
    }
    if (data.startsWith(MODEL_CB)) {
      const index = Number(data.slice(MODEL_CB.length))
      const option = picker?.models?.[index]
      if (!option) {
        await this.client.answerCallbackQuery(cq.id, 'Список устарел')
        await this.client.sendMessage(chatId, MSG.PICKER_STALE)
        return
      }
      const efforts = (option.efforts ?? []).filter((e) => e.id)
      if (efforts.length === 1) {
        // Single effort (often only "off") — apply immediately, no second tap.
        await this.applyModel(chatId, cq.id, { ...option, efforts }, efforts[0]!.id)
        return
      }
      if (efforts.length > 1) {
        const pending = { ...option, efforts }
        this.pendingModels.set(String(chatId), pending)
        if (picker) picker.pendingModel = pending
        await this.client.answerCallbackQuery(cq.id)
        await this.sendEffortPicker(chatId, pending)
        return
      }
      await this.applyModel(chatId, cq.id, option)
      return
    }
    if (data.startsWith(EFFORT_CB) || data.startsWith('me:')) {
      // Accept legacy "me:" callbacks from older bot messages.
      const rawIndex = data.startsWith(EFFORT_CB)
        ? data.slice(EFFORT_CB.length)
        : data.slice('me:'.length)
      const index = Number(rawIndex)
      const pending = this.pendingModels.get(String(chatId)) ?? picker?.pendingModel
      const effort = pending?.efforts?.[index]
      if (!pending || !effort?.id) {
        await this.client.answerCallbackQuery(cq.id, 'Список устарел')
        await this.client.sendMessage(chatId, MSG.PICKER_STALE)
        return
      }
      await this.applyModel(chatId, cq.id, pending, effort.id)
      return
    }

    // Legacy bind:<sessionId> callbacks (older messages / tests)
    if (data.startsWith('bind:')) {
      const sessionId = data.slice('bind:'.length)
      await this.bindSession(chatId, cq.id, {
        sessionId,
        title: sessionId,
        blank: false,
        running: true,
        updatedAt: 0,
      })
      return
    }

    await this.client.answerCallbackQuery(cq.id)
  }

  private async resolveCatalog(): Promise<CatalogSnapshot> {
    try {
      const fromApi = await loadCatalog(this.ctx)
      if (fromApi) {
        this.lastCatalog = fromApi
        return fromApi
      }
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: catalog via apiProxy failed: ${this.redact(err)}`)
    }
    const fallback = catalogFromLiveAgents(this.liveAgents(), this.ctx)
    this.lastCatalog = fallback
    return fallback
  }

  /** Chat remembering: any authorized contact may receive notifications. */
  private rememberChat(chatId: number): void {
    if (this.knownChats.has(chatId)) return
    this.knownChats.add(chatId)
    this.saveBindings()
  }

  private notifyScopeFor(chatId: number): 'bound' | 'every' {
    return this.notifyScope.get(String(chatId)) ?? 'every'
  }

  /** Human name of a session for lifecycle notifications. */
  /**
   * Async label for notifications: when the catalog row has no real title yet
   * (`named === false`), ask the host for the session projections — that yields
   * the session title or its first message instead of an id tail. The result is
   * cached back into the catalog row so later events are cheap.
   */
  private async sessionLabelFor(sessionId: string): Promise<string> {
    const row = this.lastCatalog?.sessionsById.get(sessionId)
    let name = row?.title
    if (!name || row?.named === false) {
      const fresh = await resolveSessionTitle(this.ctx, sessionId).catch(() => undefined)
      if (fresh) {
        name = fresh
        if (row) {
          row.title = fresh
          row.named = true
        }
      }
    }
    if (!name) {
      const bound = [...this.bindings.values()].find((b) => b.sessionId === sessionId)
      name = bound?.label ?? `…${sessionId.slice(-8)}`
    }
    const project = this.projectLabel(sessionId, row?.cwd)
    return project ? `${name} · проект ${project}` : name
  }

  private sessionLabel(sessionId: string): string {
    const row = this.lastCatalog?.sessionsById.get(sessionId)
    const bound = [...this.bindings.values()].find((b) => b.sessionId === sessionId)
    const name = row?.title || bound?.label || `…${sessionId.slice(-8)}`
    const project = this.projectLabel(sessionId, row?.cwd)
    return project ? `${name} · проект ${project}` : name
  }

  /** Project (workspace) a session belongs to: registry match, else cwd basename. */
  private projectLabel(sessionId: string, cwd?: string): string | undefined {
    const catalog = this.lastCatalog
    const workspace = catalog?.workspaces.find(
      (w) => (w.sessionIds ?? []).includes(sessionId) || (cwd !== undefined && w.path === cwd),
    )
    if (workspace?.title) return workspace.title
    return workspaceName(cwd ?? undefined)
  }

  /** Warm the catalog so notifications can name sessions and projects. */
  private prefetchCatalog(): void {
    void this.resolveCatalog().catch((err) => {
      this.ctx.logger.warn(`dsh-telegram-channel: catalog prefetch failed: ${this.redact(err)}`)
    })
  }

  /**
   * Chats that must hear about lifecycle events of this session: those bound
   * to it, plus every chat following "every session" (the default), so a task
   * started on the desktop still pings the phone.
   */
  private lifecycleTargets(sessionId: string): number[] {
    const chats = new Set<number>()
    for (const b of this.bindings.values()) {
      if (b.sessionId === sessionId) chats.add(b.chatId)
    }
    for (const chatId of this.knownChats) {
      if (this.notifyPrefs.get(String(chatId)) === 'off') continue
      if (this.notifyScopeFor(chatId) === 'every') chats.add(chatId)
    }
    return [...chats]
  }

  private async sendWorkspacePicker(chatId: number, existing?: CatalogSnapshot): Promise<void> {
    const catalog = existing ?? await this.resolveCatalog()
    // Все области реестра, включая пустые: в пустой можно сразу создать сессию.
    const workspaces = catalog.workspaces
    if (workspaces.length === 0) {
      this.pickers.delete(String(chatId))
      await this.client.sendMessage(chatId, MSG.NO_PROJECTS)
      return
    }
    const shown = workspaces.slice(0, MAX_BUTTONS)
    this.pickers.set(String(chatId), { workspaces: shown, sessions: [], catalog })
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        ...shown.map((ws, i) => ([{
          text: truncateButton(`${i + 1}. ${ws.title}`),
          callback_data: `${WS_CB}${i}`,
        }])),
        [{ text: '➕ Новый проект', callback_data: NEW_WS_CB }],
      ],
    }
    const body = [
      catalog.complete
        ? `Выберите рабочую область (${workspaces.length}, как в Web; архивные сессии скрыты):`
        : `Выберите рабочую область (${workspaces.length}) ⚠️ хост не отдал каталог: видны только запущенные сессии`,
      '',
      ...shown.map((ws, i) => {
        const n = visibleSessionsForWorkspace(catalog, ws).length
        return `${i + 1}. ${ws.title}${n === 0 ? ' — сессий нет' : ''}\n   ${ws.path}\n   сессий: ${n}`
      }),
      workspaces.length > MAX_BUTTONS ? `\nПоказаны первые ${MAX_BUTTONS} рабочих областей.` : '',
      '',
      'Кнопка области открывает её сессии; в пустой области можно создать новую. «➕ Новый проект» добавляет папку в реестр.',
    ].filter(Boolean).join('\n')
    await this.client.sendMessage(chatId, body, undefined, keyboard)
  }

  /**
   * Button caption for one session: `N. <name> <state>`. The name is the Web
   * session title (the catalog falls back to `workspace · date`), so the phone
   * list reads like the desktop sidebar instead of bare numbers.
   * ▶ = the session is live in memory, ▷ = parked (resumed on attach).
   */
  private sessionButtonText(row: SessionRow, index: number): string {
    const name = (row.title ?? '').trim() || `сессия …${row.sessionId.slice(-12)}`
    return `${index + 1}. ${name} ${row.running ? '▶' : '▷'}`
  }

  /**
   * Fill in real session names for the rows the picker is about to show.
   * `sessions.list` leaves cold sessions without a projection block, so ask the
   * host per session (cached by updatedAt) — that is what makes a button read
   * like the Web sidebar instead of "workspace · date".
   */
  private async ensureSessionNames(rows: SessionRow[]): Promise<void> {
    const pending = rows.filter((row) => !row.named)
    if (pending.length === 0) return
    await Promise.all(pending.map(async (row) => {
      const cached = this.titleCache.get(row.sessionId)
      if (cached && cached.at === row.updatedAt) {
        row.title = cached.title
        row.named = true
        return
      }
      const title = await resolveSessionTitle(this.ctx, row.sessionId)
      if (!title) return
      this.titleCache.set(row.sessionId, { at: row.updatedAt, title })
      row.title = title
      row.named = true
    }))
  }

  private async sendSessionPicker(chatId: number, workspaceIndex: number): Promise<void> {
    const picker = this.pickers.get(String(chatId))
    const catalog = picker?.catalog ?? await this.resolveCatalog()
    const workspaces = picker?.workspaces?.length
      ? picker.workspaces
      : catalog.workspaces
    const workspace = workspaces[workspaceIndex]
    if (!workspace) {
      await this.client.sendMessage(chatId, MSG.PICKER_STALE)
      return
    }
    const sessions = visibleSessionsForWorkspace(catalog, workspace)
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
    const shown = sessions.slice(0, MAX_BUTTONS)
    await this.ensureSessionNames(shown)
    this.pickers.set(String(chatId), { workspaces, workspaceIndex, sessions: shown, catalog })
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        ...shown.map((row, i) => ([
          { text: truncateButton(this.sessionButtonText(row, i)), callback_data: `${SID_CB}${i}` },
          { text: '🗄', callback_data: `${ARC_CB}${i}` },
        ])),
        [{ text: '➕ Новая сессия здесь', callback_data: `${NEW_SID_CB}${workspaceIndex}` }],
        [{ text: '← К областям', callback_data: BACK_WS_CB }],
      ],
    }
    if (sessions.length === 0) {
      const body = [
        `Рабочая область: ${workspace.title}`,
        workspace.path,
        '',
        MSG.NO_SESSIONS_IN_WS_EMPTY(workspace.title),
      ].join('\n')
      await this.client.sendMessage(chatId, body, undefined, keyboard)
      return
    }
    const body = [
      `Рабочая область: ${workspace.title}`,
      workspace.path,
      '',
      `Выберите сессию (всего ${sessions.length}):`,
      '',
      ...shown.map((row, i) => {
        const mark = row.running ? 'идёт работа' : 'не запущена'
        return `${i + 1}. ${row.title}\n   ${mark} · …${row.sessionId.slice(-12)}`
      }),
      sessions.length > MAX_BUTTONS ? `\nПоказаны первые ${MAX_BUTTONS} сессий.` : '',
      '',
      'Нажмите кнопку, чтобы привязать; неактивная сессия поднимется автоматически. 🗄 — убрать сессию в архив.',
    ].filter(Boolean).join('\n')
    await this.client.sendMessage(chatId, body, undefined, keyboard)
  }

  private async bindSession(chatId: number, callbackId: string, row: SessionRow): Promise<void> {
    const agent = await this.ensureLiveAgent(row.sessionId)
    if (!agent) {
      await this.client.answerCallbackQuery(callbackId, 'Не удалось привязать')
      await this.client.sendMessage(chatId, MSG.RESUME_FAILED)
      return
    }
    const parts = describeAgent(agent, 0, this.ctx)
    const label = row.title && row.title !== row.sessionId
      ? displayLabel({ ...parts, title: row.title })
      : displayLabel(parts)
    this.bindings.set(String(chatId), { chatId, sessionId: String(agent.id), label })
    // Drop stale pending asks when rebinding to another session; persist bindings.
    const stale = this.pendingAsks.get(String(chatId))
    if (stale && stale.sessionId !== String(agent.id)) this.pendingAsks.delete(String(chatId))
    this.saveBindings()
    await this.client.answerCallbackQuery(callbackId, 'Привязано')
    await this.client.sendMessage(chatId, MSG.BOUND(label), undefined, lastContextKeyboard())
    // Show where we left off: the last page of the conversation.
    await this.sendHistoryPage(chatId, String(agent.id))
  }

  private async sendLastTurn(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const agent = await this.ensureLiveAgent(binding.sessionId)
    try {
      const turn = await loadLastTurn(this.ctx, binding.sessionId, agent)
      const text = formatLastTurn(turn)
      await this.deliver(chatId, text)
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: /last failed: ${this.redact(err)}`)
      await this.client.sendMessage(chatId, MSG.LAST_FAILED)
    }
  }

  private async sendModelPicker(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const agent = await this.ensureLiveAgent(binding.sessionId)
    if (!agent) {
      this.bindings.delete(String(chatId))
      await this.client.sendMessage(chatId, MSG.GONE)
      return
    }
    try {
      const snap = await loadSessionModels(this.ctx, binding.sessionId)
      if (!snap.routable) {
        await this.client.sendMessage(chatId, MSG.MODEL_UNROUTABLE(formatModel(snap.current)))
        return
      }
      if (snap.options.length === 0) {
        await this.client.sendMessage(chatId, MSG.MODEL_EMPTY(formatModel(snap.current)))
        return
      }
      const shown = snap.options.slice(0, MAX_BUTTONS)
      const prev = this.pickers.get(String(chatId))
      this.pickers.set(String(chatId), {
        workspaces: prev?.workspaces ?? [],
        sessions: prev?.sessions ?? [],
        catalog: prev?.catalog,
        models: shown,
      })
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: shown.map((opt, i) => ([{
          text: truncateButton(
            `${opt.label}${opt.provider === snap.current.provider && opt.model === snap.current.model ? ' ✓' : ''}`,
          ),
          callback_data: `${MODEL_CB}${i}`,
        }])),
      }
      const body = [
        `Текущая модель: ${formatModel(snap.current)}`,
        `Сессия: ${binding.label}`,
        '',
        'Выберите модель (действует со следующего хода):',
      ].join('\n')
      await this.client.sendMessage(chatId, body, undefined, keyboard)
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: /model failed: ${this.redact(err)}`)
      const detail = err instanceof Error ? err.message : String(err)
      await this.client.sendMessage(chatId, MSG.MODEL_UNAVAILABLE(detail))
    }
  }

  private async sendEffortPicker(chatId: number, option: ModelOption): Promise<void> {
    const efforts = option.efforts ?? []
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: [
        ...efforts.map((e, i) => ([{
          text: truncateButton(e.name || e.id),
          callback_data: `${EFFORT_CB}${i}`,
        }])),
        [{ text: '← К списку моделей', callback_data: BACK_MODEL_CB }],
      ],
    }
    await this.client.sendMessage(
      chatId,
      `Выбрано: ${option.label}\nТеперь выберите глубину размышлений:`,
      undefined,
      keyboard,
    )
  }

  private async applyModel(
    chatId: number,
    callbackId: string,
    option: ModelOption,
    reasoningEffort?: string,
  ): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.answerCallbackQuery(callbackId, 'Нет привязки')
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    // Ensure session is live before selectModel (same as followup path).
    await this.ensureLiveAgent(binding.sessionId)
    try {
      const selected = await selectSessionModel(this.ctx, binding.sessionId, {
        provider: option.provider,
        model: option.model,
        reasoningEffort,
      })
      this.pendingModels.delete(String(chatId))
      const picker = this.pickers.get(String(chatId))
      if (picker) picker.pendingModel = undefined
      await this.client.answerCallbackQuery(callbackId, 'Переключено')
      await this.client.sendMessage(chatId, MSG.MODEL_SET(formatModel(selected)))
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: selectModel failed: ${this.redact(err)}`)
      const detail = err instanceof Error ? err.message : String(err)
      await this.client.answerCallbackQuery(callbackId, 'Не удалось переключить')
      await this.client.sendMessage(chatId, MSG.MODEL_FAILED(detail))
    }
  }

  private liveAgents(): Agent[] {
    const agents = this.ctx.agents
    if (typeof agents.roots === 'function') {
      const roots = agents.roots()
      if (roots.length > 0) return roots
    }
    if (typeof agents.list === 'function') return agents.list()
    return []
  }

  private findLiveAgent(sessionId: string): Agent | undefined {
    const agents = this.ctx.agents
    if (typeof agents.get === 'function') {
      try {
        const found = agents.get(SessionId(sessionId))
        if (found) return found
      } catch {
        // fall through to list scan
      }
    }
    return this.liveAgents().find((a) => String(a.id) === sessionId)
  }

  /** Resume cold sessions when needed; never dispose the returned handle. */
  private async ensureLiveAgent(sessionId: string): Promise<Agent | undefined> {
    const live = this.findLiveAgent(sessionId)
    if (live) return live
    const agents = this.ctx.agents as { resume?: (opts: { resumeSessionId: ReturnType<typeof SessionId> }) => Promise<{ agent: Agent }> }
    if (typeof agents.resume !== 'function') return undefined
    try {
      const handle = await agents.resume({ resumeSessionId: SessionId(sessionId) })
      return handle.agent
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: resume failed for ${sessionId}: ${this.redact(err)}`)
      return undefined
    }
  }

  private async sendStatus(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.STATUS_NONE)
      return
    }
    const info: StatusInfo = {
      label: binding.label,
      sessionId: binding.sessionId,
    }
    // 冷会话：不强制 resume（只读查询），给出可用的绑定/工作区信息即可。
    const agent = this.findLiveAgent(binding.sessionId)
    if (!agent) {
      info.live = false
      info.workspace = await this.workspaceOf(binding.sessionId, undefined)
      await this.client.sendMessage(chatId, formatStatusText(info))
      return
    }
    info.live = true
    info.workspace = await this.workspaceOf(binding.sessionId, agent)
    try {
      const snap = await loadSessionModels(this.ctx, binding.sessionId)
      if (snap.current) {
        info.model = {
          provider: snap.current.provider,
          model: snap.current.model,
          reasoningEffort: snap.current.reasoningEffort,
        }
      }
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: /status model read failed: ${this.redact(err)}`)
    }
    info.runtime = this.readRuntimeValues(agent)
    await this.client.sendMessage(chatId, formatStatusText(info))
  }

  /** 按 sessionId 解析工作区：apiProxy 目录优先，冷/热会话均可用；退化为 agent cwd。 */
  private async workspaceOf(sessionId: string, agent: Agent | undefined): Promise<StatusWorkspace | undefined> {
    try {
      const catalog = await this.resolveCatalog()
      const ws = (catalog?.workspaces ?? []).find((w) => (w.sessionIds ?? []).includes(sessionId))
      if (ws) {
        return { title: ws.title || undefined, path: ws.path || undefined }
      }
      const row = catalog?.sessionsById?.get(sessionId)
      if (row?.cwd) {
        return { title: workspaceName(row.cwd) || undefined, path: row.cwd }
      }
    } catch {
      // 目录不可用 → 继续走 agent 侧兜底
    }
    if (agent) {
      const parts = describeAgent(agent, 0, this.ctx)
      if (parts.cwd) {
        return { title: parts.workspace || undefined, path: parts.cwd }
      }
    }
    return undefined
  }

  /** 从 sessionProjections 快照读 Web 底部同款统计（sessionStats/tokenUsage/contextPressure）。 */
  private readRuntimeValues(agent: Agent): StatusRuntime | undefined {
    const registry = this.serviceOf<ProjectionRegistryLike>('sessionProjections')
    let values: Record<string, unknown> | undefined
    if (registry?.snapshot) {
      try {
        values = registry.snapshot(agent.session)?.values
      } catch (err) {
        this.ctx.logger.warn(`dsh-telegram-channel: projection snapshot failed: ${this.redact(err)}`)
      }
    }
    if (!values) return undefined

    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined
    const stats = (values['sessionStats'] ?? {}) as Record<string, unknown>
    const usage = (values['tokenUsage'] ?? {}) as Record<string, unknown>
    const pressure = (values['contextPressure'] ?? {}) as Record<string, unknown>

    const runtime: StatusRuntime = {
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
    }
    // 完全无数据时视为无统计块。
    const hasAny = Object.values(runtime).some((v) => v !== undefined)
    return hasAny ? runtime : undefined
  }

  /** 按名称解析宿主服务（Cordis 需 ctx.get；mock/plain ctx 走自有属性兜底）。 */
  private serviceOf<T>(name: string): T | undefined {
    const c = this.ctx as { get?: (name: string, strict?: boolean) => unknown }
    if (typeof c.get === 'function') {
      try {
        const via = c.get(name, false)
        if (via) return via as T
      } catch {
        // 服务未装配或当前 ctx 不可解析
      }
    }
    try {
      if (Object.prototype.hasOwnProperty.call(this.ctx, name)) {
        return (this.ctx as unknown as Record<string, unknown>)[name] as T
      }
    } catch {
      // proxy ctx：无 inject 直接读属性会抛错，忽略
    }
    return undefined
  }

  // ── /compact：手动压缩当前绑定会话（需会话空闲）──
  //
  // 压缩引擎（compaction-basic）挂载在隔离作用域，插件 ctx 拿不到；但宿主的
  // command-compact 已把 /compact 注册进命令运行时的按 agent 作用层（Web 端
  // 同款通道），因此这里复用它：语义、busy/错误映射、命令生命周期日志与 Web
  // 端 /compact 完全一致，且无需接触引擎内部。

  private async requestCompact(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    if (this.compacting.has(binding.sessionId)) {
      await this.client.sendMessage(chatId, MSG.COMPACT_INFLIGHT)
      return
    }
    const agent = await this.ensureLiveAgent(binding.sessionId)
    if (!agent) {
      this.bindings.delete(String(chatId))
      await this.client.sendMessage(chatId, MSG.GONE)
      return
    }
    const commands = this.serviceOf<CommandsRuntimeLike>('commands')
    if (!commands?.execute || typeof commands.find !== 'function' || !commands.find(agent, 'compact')) {
      await this.client.sendMessage(chatId, MSG.COMPACT_UNAVAILABLE)
      return
    }
    // 会话正在跑任务时压缩会被拒（runMaintenance 忙）；提前提示避免「已开始→失败」两步。
    const busy = this.busySessions.has(binding.sessionId)
      || Boolean((agent as { phase?: { kind?: string } }).phase?.kind
        && (agent as { phase?: { kind?: string } }).phase?.kind !== 'idle')
    if (busy) {
      await this.client.sendMessage(chatId, MSG.COMPACT_BUSY)
      return
    }
    const controller = new AbortController()
    this.compacting.add(binding.sessionId)
    this.compactAborts.set(binding.sessionId, controller)
    await this.client.sendMessage(chatId, MSG.COMPACT_STARTED)
    const operation = commands.execute(agent as never, '/compact', [], controller.signal)
    void this.runCompaction(chatId, binding.sessionId, operation, controller).catch((err) => {
      this.ctx.logger.error(`dsh-telegram-channel: /compact runner crashed: ${this.redact(err)}`)
    })
  }

  /** 等待压缩落定并汇报结果（不阻塞轮询循环）。 */
  private async runCompaction(
    chatId: number,
    sessionId: string,
    operation: Promise<{ commandId: string; result: { kind: string; text?: string } } | undefined>,
    controller: AbortController,
  ): Promise<void> {
    try {
      const execution = await operation
      if (execution === undefined) {
        // find() 通过但 execute 未命中：按未注册处理。
        await this.enqueueNotice(chatId, MSG.COMPACT_UNAVAILABLE)
        return
      }
      const translated = translateCompactResult(execution.result)
      if (translated !== undefined) {
        await this.enqueueNotice(chatId, translated)
        return
      }
      // 无法识别的结果：回退为通用失败 + 宿主原文。
      const raw = execution.result?.text
      await this.enqueueNotice(chatId, MSG.COMPACT_FAILED(raw))
    } catch (err) {
      if (controller.signal.aborted) {
        // 桥停止/热重载导致的取消：静默，不打扰（本实例正在退出）。
        this.ctx.logger.info('dsh-telegram-channel: compaction aborted by bridge stop')
        return
      }
      this.ctx.logger.warn(`dsh-telegram-channel: /compact failed: ${this.redact(err)}`)
      await this.enqueueNotice(chatId, MSG.COMPACT_FAILED(this.redact(err)))
    } finally {
      this.compacting.delete(sessionId)
      this.compactAborts.delete(sessionId)
    }
  }

  private async followupBound(chatId: number, text: string): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const agent = await this.ensureLiveAgent(binding.sessionId)
    if (!agent) {
      this.bindings.delete(String(chatId))
      await this.client.sendMessage(chatId, MSG.GONE)
      return
    }
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    // Busy feedback: mid-turn followups queue silently by design — tell the user.
    const busy = this.busySessions.has(binding.sessionId)
      || Boolean((agent as { phase?: { kind?: string } }).phase?.kind
        && (agent as { phase?: { kind?: string } }).phase?.kind !== 'idle')
    agent.followup(message)
    if (busy) {
      await this.enqueueNotice(chatId, 'В очереди: сообщение обработается после текущей задачи')
    }
  }

  /**
   * Extract wire prompt parts from a media message.
   * Returns undefined when the message carries no media at all; returns [] for
   * an unsupported media type (the user was already notified); otherwise the
   * caption text part (when present) followed by the image part.
   */
  private async collectMediaParts(chatId: number, message: TelegramMessage): Promise<WireContentPart[] | undefined> {
    const caption = message.caption?.trim()
    const textPart: WireContentPart | undefined = caption ? { type: 'text', text: caption } : undefined
    const withText = (part: WireContentPart): WireContentPart[] =>
      textPart ? [textPart, part] : [part]

    if (message.photo && message.photo.length > 0) {
      // TG photo sizes are ordered smallest → largest; the last is the best quality.
      const best = message.photo[message.photo.length - 1]!
      const part = await this.downloadImagePart(chatId, best.file_id, 'image/jpeg')
      return part ? withText(part) : []
    }

    const doc = message.document
    if (doc) {
      if (!doc.mime_type || !IMAGE_MEDIA_TYPES.includes(doc.mime_type)) {
        await this.enqueueNotice(chatId, MSG.MEDIA_UNSUPPORTED)
        return []
      }
      const part = await this.downloadImagePart(chatId, doc.file_id, doc.mime_type, doc.file_name)
      return part ? withText(part) : []
    }

    return undefined
  }

  /** Download one TG file and encode it as a canonical-base64 wire image part. */
  private async downloadImagePart(
    chatId: number,
    fileId: string,
    mediaType: string,
    name?: string,
  ): Promise<WireContentPart | undefined> {
    try {
      const file = await this.client.getFile(fileId)
      if (!file.file_path) throw new Error('Telegram не вернул путь к файлу')
      const bytes = await this.client.downloadFile(file.file_path)
      // Buffer base64 is canonical (standard alphabet, no whitespace) — the host
      // attachment admission rejects non-canonical forms outright.
      const data = Buffer.from(bytes).toString('base64')
      return { type: 'image', mediaType, data, ...(name === undefined ? {} : { name }) }
    } catch (err) {
      await this.enqueueNotice(chatId, MSG.IMAGE_FAILED(this.redact(err)))
      return undefined
    }
  }

  /**
   * Album photos arrive as separate updates sharing a media_group_id — debounce
   * them into ONE prompt so an album does not spawn N sequential turns.
   */
  private accumulateMediaGroup(chatId: number, groupId: string, parts: WireContentPart[]): void {
    const key = `${String(chatId)}:${groupId}`
    const existing = this.mediaGroups.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      existing.parts.push(...parts)
    }
    const entry = existing ?? { chatId, parts: [...parts] }
    entry.timer = setTimeout(() => {
      this.mediaGroups.delete(key)
      this.sendImageFollowup(entry.chatId, entry.parts).catch((err) => {
        this.ctx.logger.error(this.redact(err))
      })
    }, MEDIA_GROUP_WINDOW_MS)
    this.mediaGroups.set(key, entry)
  }

  /**
   * Dispatch an image-bearing message to the bound session through the host
   * prompt RPC — the exact channel the Web composer uses. The host checks
   * whether the current model accepts image input, admits the bytes into the
   * durable attachment store, then queues the message on the agent (mode
   * 'queue' — same semantics as the text path's agent.followup).
   */
  private async sendImageFollowup(chatId: number, parts: WireContentPart[]): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const agent = await this.ensureLiveAgent(binding.sessionId)
    if (!agent) {
      this.bindings.delete(String(chatId))
      await this.client.sendMessage(chatId, MSG.GONE)
      return
    }
    const proxy = resolveApiProxy(this.ctx)
    const controller = hostService<{
      prompt?: (request: {
        requestId: string
        sessionId: string
        mode: 'queue' | 'steer'
        content: WireContentPart[]
      }) => Promise<{ accepted?: boolean }>
    }>(this.ctx, 'sessionController')
    const hostPrompt = controller?.prompt
    if (!proxy?.sessions?.prompt && typeof hostPrompt !== 'function') {
      await this.enqueueNotice(chatId, 'Хост не поддерживает отправку изображений (нет ни apiProxy.sessions.prompt, ни sessionController.prompt).')
      return
    }
    const busy = this.busySessions.has(binding.sessionId)
      || Boolean((agent as { phase?: { kind?: string } }).phase?.kind
        && (agent as { phase?: { kind?: string } }).phase?.kind !== 'idle')
    // dsh 0.2: no apiProxy — the host session controller takes the same payload.
    if (!proxy?.sessions?.prompt) {
      try {
        const accepted = await hostPrompt!.call(controller, {
          requestId: randomUUID(),
          sessionId: binding.sessionId,
          mode: 'queue',
          content: parts,
        })
        if (!accepted?.accepted) throw new Error('хост не подтвердил приём')
      } catch (err) {
        await this.enqueueNotice(chatId, MSG.IMAGE_FAILED(this.redact(err)))
        return
      }
      if (busy) await this.enqueueNotice(chatId, 'В очереди: сообщение обработается после текущей задачи')
      return
    }
    type PromptResponse = { result?: { ok?: boolean; value?: { accepted?: boolean }; error?: { code?: string; message?: string; details?: { reason?: string } } } }
    let res: PromptResponse | undefined
    try {
      res = await proxy.sessions.prompt({
        rpcId: randomUUID(),
        payload: { sessionId: binding.sessionId, mode: 'queue', content: parts },
      }) as PromptResponse | undefined
    } catch (err) {
      await this.enqueueNotice(chatId, MSG.IMAGE_FAILED(this.redact(err)))
      return
    }
    const result = res?.result
    if (!result?.ok) {
      const code = result?.error?.code
      const message = String(result?.error?.message ?? 'хост не подтвердил приём')
      if (code === 'attachment-error' && result?.error?.details?.reason === 'MODEL_DOES_NOT_SUPPORT_IMAGES') {
        await this.enqueueNotice(chatId, MSG.IMAGE_MODEL_UNSUPPORTED)
      } else {
        const detail = `${code ? `[${code}] ` : ''}${message}`.trim()
        await this.enqueueNotice(chatId, MSG.IMAGE_FAILED(detail))
      }
      return
    }
    if (busy) {
      await this.enqueueNotice(chatId, 'В очереди: сообщение обработается после текущей задачи')
    }
  }

  private async pollLoop(): Promise<void> {
    const signal = this.pollAbort?.signal
    let errorCount = 0
    while (this.polling) {
      try {
        const updates = await this.client.getUpdates(this.offset)
        if (!this.polling) break
        errorCount = 0
        if (updates.length === 0) {
          await this.interruptibleDelay(50, signal)
          continue
        }
        for (const update of updates) {
          if (!this.polling) break
          await this.processUpdate(update)
          this.offset = update.update_id + 1
        }
      } catch (err) {
        if (!this.polling) break
        errorCount += 1
        this.ctx.logger.error(this.redact(err))
        await this.interruptibleSleep(Math.min(1000 * errorCount, 10_000), signal)
      }
    }
  }

  private interruptibleDelay(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !this.polling) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      }, { once: true })
    })
  }

  private async interruptibleSleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || !this.polling) return
    await Promise.race([
      this.sleep(ms),
      new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve()
          return
        }
        signal?.addEventListener('abort', () => resolve(), { once: true })
      }),
    ])
  }

  private async onSessionEvent(session: SessionLike, event: SessionEvent): Promise<void> {
    const id = String(session.id)
    const targets = [...this.bindings.values()].filter((b) => b.sessionId === id)
    const lifecycle = this.lifecycleTargets(id)
    // Content (assistant text, tool progress) stays bound-only; lifecycle goes wider.
    if (targets.length === 0 && !(lifecycle.length > 0 && event.type === 'turn/end')) return

    if (event.type === 'turn/start') {
      // Typing heartbeat — one sendChatAction expires in ~5s, so refresh it
      // for the whole turn instead of only at start.
      this.busySessions.add(id)
      for (const b of targets) this.startTypingHeartbeat(b.chatId)
      return
    }

    if (event.type === 'turn/end') {
      await this.flushReasoning(id)
      this.busySessions.delete(id)
      this.thinkingSessions.delete(id)
      for (const b of targets) this.stopTypingHeartbeat(b.chatId)
      if (!this.lastCatalog?.sessionsById.has(id)) this.prefetchCatalog()
      const label = await this.sessionLabelFor(id)
      // Abnormal endings (API failure / abort / crash-recovery) must be
      // visible on the phone — previously they ended in silence.
      const reason = event.data?.reason as { kind?: string; error?: { message?: string; code?: string }; reason?: { kind?: string } } | undefined
      const kind = reason?.kind
      const lifecycleSet = new Set(lifecycle)
      for (const chatId of lifecycleSet) {
        const mode = this.notificationMode(chatId)
        if (mode === 'off') continue
        if (kind === 'error') {
          this.enqueueNotice(chatId, `${this.describeTurnError(reason?.error)}\nСессия: ${label}`)
        } else if (kind === 'completed') {
          if (mode === 'all') this.enqueueNotice(chatId, `✅ Сессия завершила работу — ${label}`)
        } else if (kind === 'max-tokens') {
          this.enqueueNotice(chatId, `⚠️ Достигнут лимит выходных токенов — ход закрыт\nСессия: ${label}`)
        } else if (kind === 'blocked') {
          this.enqueueNotice(chatId, `⛔ Ход заблокирован хостом (сессия в архиве или работа остановлена)\nСессия: ${label}`)
        } else if (kind === 'aborted') {
          const manual = reason?.reason?.kind === 'user'
          if (mode === 'all') this.enqueueNotice(chatId, manual ? `⏹ Ход остановлен вручную — ${label}` : `⏹ Ход прерван — ${label}`)
        } else if (kind === 'interrupted') {
          this.enqueueNotice(chatId, `⚠️ Сессия оборвалась: аварийное завершение (восстановление после сбоя), ход помечен прерванным\nСессия: ${label}`)
        }
      }
      return
    }

    if (event.type === 'step/end') {
      await this.flushReasoning(id)
      return
    }

    if (event.type === 'tool/call') {
      // Progress summary; ask_user is owned by the provider hook (avoids duplicates).
      const name = event.data?.name ?? 'tool'
      if (name === 'ask_user_question') return
      this.thinkingSessions.set(id, false)
      if (event.data?.callId !== undefined) {
        if (this.callNames.size > 400) {
          const first = this.callNames.keys().next().value
          if (first !== undefined) this.callNames.delete(first)
        }
        this.callNames.set(String(event.data.callId), String(name))
      }
      const rawArgs = typeof event.data?.arguments === 'string'
        ? event.data.arguments
        : JSON.stringify(event.data?.arguments ?? {}, null, 2)
      for (const b of targets) {
        await this.sendHtml(
          b.chatId,
          this.spoilerBlock(`🛠 ${escapeHtml(String(name))}`, rawArgs?.trim() ? rawArgs : '(без аргументов)'),
        )
      }
      return
    }

    if (event.type === 'assistant/message') {
      const text = contentToText(event.data.message.content)
      this.thinkingSessions.set(id, false)
      if (!text) return
      await Promise.all(targets.map((b) => this.deliver(b.chatId, text)))
      return
    }

    if (event.type === 'assistant/chunk') {
      // Thinking indicator: once per reasoning phase, status only (no content).
      const chunk = event.data?.chunk as { type?: string; block?: { type?: string } } | undefined
      const ctype = String(chunk?.type ?? '')
      const btype = String(chunk?.block?.type ?? '')
      const isReasoning = ctype.includes('reasoning') || btype.includes('reasoning') || btype.includes('think')
      if (isReasoning) {
        const delta = (chunk as { text?: unknown } | undefined)?.text
        if (typeof delta === 'string' && delta.length > 0) {
          this.reasoningBuffers.set(id, (this.reasoningBuffers.get(id) ?? '') + delta)
        }
        if (this.thinkingSessions.get(id) !== true) {
          this.thinkingSessions.set(id, true)
          for (const b of targets)
            this.enqueueNotice(b.chatId, '> Думаю…')
        }
      }
      return
    }

    if (event.type === 'tool/result') {
      // Only failures — successful results are too noisy for the phone.
      const data = event.data as { error?: { name?: string; code?: string }; message?: { tool_use_id?: string; callId?: string } }
      if (data?.error) {
        const callKey = String(data.message?.tool_use_id ?? data.message?.callId ?? '')
        const name = this.callNames.get(callKey) ?? 'tool'
        for (const b of targets)
          this.enqueueNotice(b.chatId, `> Инструмент ${name} — ошибка: ${String(data.error.name ?? 'Error')}${data.error.code ? `/${String(data.error.code)}` : ''}`)
      }
      return
    }

    if (event.type === 'todo/write') {
      const todos = Array.isArray(event.data?.todos) ? event.data.todos : []
      this.lastTodos.set(id, todos as Array<{ content?: string; status?: string }>)
      if (todos.length === 0) return
      const done = todos.filter((t) => t?.status === 'completed').length
      const current = todos.find((t) => t?.status === 'in_progress') ?? todos.find((t) => t?.status === 'pending')
      const cur = current ? String(current.content ?? '').slice(0, 50) : ''
      for (const b of targets)
        this.enqueueNotice(b.chatId, `> Прогресс ${done}/${todos.length}${cur ? `：${cur}` : ''}`)
      return
    }
  }

  // ── /rich: per-chat rendering mode (persisted) ──
  //
  // Rich messages (Bot API sendRichMessage) only render on recent Telegram
  // clients; old ones (10.x) show the message as “not supported”. The bot cannot
  // detect the recipient's client version, so the choice is per-chat and manual,
  // remembered forever. HTML mode is the compat default and works everywhere.

  private async handleRichCommand(chatId: number, arg?: string): Promise<void> {
    const key = String(chatId)
    const setAndReply = async (mode: 'rich' | 'html'): Promise<void> => {
      this.renderPrefs.set(key, mode)
      this.saveBindings()
      await this.client.sendMessage(chatId, MSG.RICH_SET(mode))
    }
    switch (arg) {
      case 'on':
      case 'rich':
        await setAndReply('rich')
        return
      case 'off':
      case 'html':
      case 'compat':
        await setAndReply('html')
        return
      case 'auto':
      case 'default':
      case 'reset':
        this.renderPrefs.delete(key)
        this.saveBindings()
        await this.client.sendMessage(chatId, MSG.RICH_STATE(this.renderingMode))
        return
      case undefined:
        await this.client.sendMessage(chatId, MSG.RICH_STATE(this.modeFor(chatId)))
        return
      default:
        await this.client.sendMessage(chatId, MSG.RICH_USAGE)
    }
  }

  private async deliver(chatId: number, markdown: string): Promise<void> {
    if (this.modeFor(chatId) !== 'html') {
      let sentAny = false
      try {
        const chunks = splitRichMarkdown(markdown)
        for (const chunk of chunks) {
          try {
            // Per-chunk retry: transient network blips must not drop a reply.
            await this.withRetry(() => this.client.sendRichMessage(chatId, chunk))
            sentAny = true
          } catch (err) {
            if (!sentAny && isRichUnsupportedError(err)) {
              this.ctx.logger.warn(
                'dsh-telegram-channel: Rich Message API unavailable, falling back to HTML rendering',
              )
              this.renderingMode = 'html'
              // Rich API being gone is a server-wide fact: per-chat rich overrides
              // must not bypass the global downgrade (modeFor prefers the override).
              for (const [key, mode] of this.renderPrefs) {
                if (mode === 'rich') this.renderPrefs.delete(key)
              }
              this.saveBindings()
              await this.deliverHtml(chatId, markdown)
              return
            }
            throw err
          }
        }
        return
      } catch (err) {
        // Persistent rich failure → HTML fallback instead of dropping the message.
        this.ctx.logger.warn(`dsh-telegram-channel: rich deliver failed (${this.redact(err)}), falling back to HTML`)
      }
    }
    await this.deliverHtml(chatId, markdown)
  }

  private async deliverHtml(chatId: number, markdown: string): Promise<void> {
    const chunks = splitMessage(markdown, this.maxMessageLength)
    for (const chunk of chunks) {
      let html: string
      try {
        html = markdownToHtml(chunk)
      } catch {
        html = chunk // Pathological markdown input: degrade to plain text instead of dropping.
      }
      try {
        await this.withRetry(() => this.client.sendMessage(chatId, html, 'HTML'))
      } catch {
        try {
          await this.withRetry(() => this.client.sendMessage(chatId, chunk))
        } catch (err) {
          this.ctx.logger.error(this.redact(err))
        }
      }
    }
  }

  // ── Stability & interactivity helpers ──

  /** Retry an outbound call with capped linear backoff (500ms, 1s, 2s… max 4s). */
  private async withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
    let lastErr: unknown
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastErr = err
        if (attempt < tries) await this.sleep(Math.min(500 * 2 ** (attempt - 1), 4000))
      }
    }
    throw lastErr
  }

  /**
   * Send a notice; a leading `> ` keeps the quote look via a plain-text `> `
   * prefix. NB: NOT `<blockquote>` HTML — older Telegram clients cannot render
   * the blockquote entity at all and show the whole message as “not supported”.
   * Falls back to plain text when the send fails — a notice is never lost.
   */
  private async deliverNotice(chatId: number, text: string): Promise<void> {
    const quoted = text.startsWith('> ')
    const body = quoted ? text.slice(2) : text
    try {
      await this.withRetry(() => this.client.sendMessage(chatId, quoted ? `> ${body}` : body))
      return
    } catch (err) {
      this.ctx.logger.error(this.redact(err))
    }
  }

  /** Serialized per-chat notice chain — bursts can't race into Telegram 429s. */
  private enqueueNotice(chatId: number, text: string): Promise<void> {
    const key = String(chatId)
    const prev = this.noticeQueue.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.deliverNotice(chatId, text)).catch(() => {})
    this.noticeQueue.set(key, next)
    return next
  }

  private startTypingHeartbeat(chatId: number): void {
    this.stopTypingHeartbeat(chatId)
    const send = (): void => {
      void this.client.sendChatAction(chatId, 'typing').catch(() => {})
    }
    send()
    this.heartbeats.set(String(chatId), setInterval(send, 4000))
  }

  private stopTypingHeartbeat(chatId: number): void {
    const h = this.heartbeats.get(String(chatId))
    if (h) {
      clearInterval(h)
      this.heartbeats.delete(String(chatId))
    }
  }

  private stopAllHeartbeats(): void {
    for (const h of this.heartbeats.values()) clearInterval(h)
    this.heartbeats.clear()
  }

  // ── ask_user_question: TG answering via dual-path race with the UI ──

  /**
   * Mirror the host's agent-scoped waterfall request to Telegram. The next
   * handler remains the Web answer path; NO_PROVIDER means no Web answerer is
   * available, so keep waiting for Telegram instead of failing the request.
   */
  private async onUserQuestionRequest(
    request: UserQuestionRequestLike,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const sessionId = request?.agent?.id !== undefined ? String(request.agent.id) : undefined
    // Phone side is offered the question when the chat is bound to that session
    // OR follows every session (desktop-started tasks included).
    const wantedChat = sessionId !== undefined && this.lifecycleTargets(sessionId).length > 0
    if (!wantedChat || !Array.isArray(request.questions) || request.questions.length === 0) {
      return next()
    }

    const tg = this.registerTgAsk(request)
    let gui: Promise<unknown>
    try {
      gui = next()
    } catch (err) {
      this.discardTgAsk(request)
      tg.reject(err instanceof Error ? err : new Error(String(err)))
      throw err
    }

    const guiSafe = gui.catch((err: unknown) => {
      if (isNoQuestionAnswererError(err)) {
        return new Promise<never>(() => {})
      }
      this.discardTgAsk(request)
      tg.reject(err instanceof Error ? err : new Error(String(err)))
      throw err
    })
    void gui.then(
      () => this.settleGuiSide(request),
      (err: unknown) => {
        if (!isNoQuestionAnswererError(err)) this.discardTgAsk(request)
      },
    )
    return Promise.race([tg.promise, guiSafe])
  }

  private registerTgAsk(request: unknown): { promise: Promise<unknown>; reject: (err: Error) => void } {
    let resolveFn: (v: unknown) => void = () => {}
    let rejectFn: (err: Error) => void = () => {}
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    const ask: TgAnswerHandle = { resolve: resolveFn, reject: rejectFn, answered: false }
    const req = request as { agent?: Agent; questions?: TgQuestionItem[]; signal?: AbortSignal }
    const sessionId = req.agent?.id !== undefined ? String(req.agent.id) : undefined
    const questions = Array.isArray(req.questions) ? req.questions : []
    const onAbort = (): void => {
      for (const [chatId, p] of this.pendingAsks) {
        if (p.ask === ask) this.pendingAsks.delete(chatId)
      }
      rejectFn(new Error('ask aborted'))
    }
    if (req.signal?.aborted) {
      rejectFn(new Error('ask aborted'))
      return { promise, reject: rejectFn }
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })
    if (sessionId !== undefined && questions.length > 0) {
      const label = this.sessionLabel(sessionId)
      let asked = false
      for (const chatId of this.lifecycleTargets(sessionId)) {
        if (this.notificationMode(chatId) === 'off') continue
        this.pendingAsks.set(String(chatId), { req: request, sessionId, questions, ask, at: Date.now() })
        this.enqueueNotice(chatId, `${this.formatAskPending(questions)}\nСессия: ${label}`)
        asked = true
      }
      if (asked) return { promise, reject: rejectFn }
    }
    // No bound TG chat: never settle — the UI remains the only answer path.
    return { promise, reject: rejectFn }
  }

  private settleGuiSide(request: unknown): void {
    for (const [chatId, p] of [...this.pendingAsks]) {
      if (p.req !== request) continue
      this.pendingAsks.delete(chatId)
      if (!p.ask.answered) {
        this.enqueueNotice(Number(chatId), 'На вопрос уже ответили в Web — канал ответов в TG закрыт')
      }
    }
  }

  private discardTgAsk(request: unknown): void {
    for (const [chatId, pending] of [...this.pendingAsks]) {
      if (pending.req === request) this.pendingAsks.delete(chatId)
    }
  }

  private formatAskPending(questions: TgQuestionItem[]): string {
    const lines = ['❓ Сессия задала вопрос и ждёт ответа', 'Ответьте буквой варианта или введите свой ответ; /cancel — закрыть ответы в TG']
    questions.forEach((q, i) => {
      const prefix = questions.length > 1 ? `Q${i + 1}. ` : ''
      lines.push(`${prefix}${q.question ?? ''}`)
      const opts = Array.isArray(q.options) ? q.options : []
      if (opts.length === 0) {
        lines.push('  (открытый вопрос — просто введите ответ)')
      } else {
        opts.forEach((o, j) => lines.push(`  [${String.fromCharCode(65 + j)}] ${o.label}${o.description ? ` — ${o.description}` : ''}`))
        if (q.multiSelect) lines.push('  (можно несколько, например: A,B)')
      }
    })
    return lines.join('\n')
  }

  private async handleTgAnswer(chatId: number, pending: TgPendingAsk, text: string): Promise<void> {
    const { questions, ask } = pending
    let parts: Array<[number | null, string]>
    if (questions.length === 1) {
      parts = [[0, text.trim()]]
    } else {
      parts = []
      const lines = text.split(/\n|；|;/).map((s) => s.trim()).filter(Boolean)
      for (const line of lines) {
        const m = line.match(/^([0-9]+)\s*[:：.、)]\s*(.+)$/)
        if (m) parts.push([Number(m[1]) - 1, m[2]!.trim()])
        else parts.push([null, line])
      }
      if (parts.some(([idx]) => idx === null)) {
        await this.enqueueNotice(chatId, `Вопросов: ${questions.length} — отвечайте построчно с префиксом 1:/2:`)
        return
      }
    }
    const answers: Array<{ id?: string; selected: string[]; custom?: string }> = []
    for (const [idx, raw] of parts) {
      if (idx === null || idx < 0 || idx >= questions.length) {
        await this.enqueueNotice(chatId, `Вопроса №${(idx ?? 0) + 1} нет (всего ${questions.length})`)
        return
      }
      const q = questions[idx]!
      const cleaned = raw.replace(/^\[+/, '').replace(/\]+$/, '').trim()
      const letters = cleaned.split(/[,，、\s]+/).map((s) => s.trim()).filter(Boolean)
      const opts = Array.isArray(q.options) ? q.options : []
      const isLetterChoice = letters.length > 0
        && letters.every((s) => /^[a-zA-Z]$/.test(s))
        && opts.length > 0
      if (isLetterChoice) {
        const selected: string[] = []
        for (const s of letters) {
          const i = s.toUpperCase().charCodeAt(0) - 65
          if (i < 0 || i >= opts.length) {
            await this.enqueueNotice(chatId, `Варианта ${s.toUpperCase()} нет (доступно A-${String.fromCharCode(64 + opts.length)}). Ответьте снова или /cancel`)
            return
          }
          selected.push(opts[i]!.label)
        }
        answers.push({ id: q.id, selected })
      } else {
        answers.push({ id: q.id, selected: [], custom: cleaned })
      }
    }
    ask.answered = true
    for (const [cid, p] of this.pendingAsks) {
      if (p.ask === ask) this.pendingAsks.delete(cid)
    }
    ask.resolve({ answers })
    this.enqueueNotice(chatId, 'Ответ отправлен')
  }

  // ── approval: TG answering via dual-path race on the request waterfall ──

  private async onApprovalRequest(
    req: ApprovalRequestLike,
    next: () => Promise<string>,
  ): Promise<string> {
    const sessionId = req?.agent?.id !== undefined ? String(req.agent.id) : undefined
    const targets = sessionId !== undefined
      ? [...this.bindings.values()].filter((b) => b.sessionId === sessionId).map((b) => String(b.chatId))
      : []
    let resolveFn: (v: unknown) => void = () => {}
    let rejectFn: (err: Error) => void = () => {}
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    const ask: TgAnswerHandle = { resolve: resolveFn, reject: rejectFn, answered: false }
    const onAbort = (): void => {
      for (const [chatId, p] of this.pendingApprovalsTG) {
        if (p.ask === ask) this.pendingApprovalsTG.delete(chatId)
      }
      rejectFn(new Error('approval withdrawn'))
    }
    if (req?.signal?.aborted) {
      rejectFn(new Error('approval withdrawn'))
      return next()
    }
    req?.signal?.addEventListener('abort', onAbort, { once: true })
    if (targets.length > 0) {
      const toolName = String(req?.toolName ?? 'tool')
      const reason = req?.reason ? String(req.reason).slice(0, 200) : ''
      for (const chatId of targets) {
        this.pendingApprovalsTG.set(chatId, { toolName, ask })
        this.enqueueNotice(Number(chatId), `Запрос разрешения: ${toolName}${reason ? `\n(${reason})` : ''}\nОтветьте [A] — разрешить один раз / [B] — отклонить (/cancel — закрыть в TG)`)
      }
    }
    // No bound TG chat: promise never settles — the UI remains the only answer path.
    const gui = next()
    void gui.then(() => {
      for (const [chatId, p] of [...this.pendingApprovalsTG]) {
        if (p.ask !== ask) continue
        this.pendingApprovalsTG.delete(chatId)
        if (!p.ask.answered) {
          p.ask.reject(new Error('superseded-by-gui'))
          this.enqueueNotice(Number(chatId), 'Это разрешение уже обработано в Web')
        }
      }
    }, () => {
      for (const [chatId, p] of [...this.pendingApprovalsTG]) {
        if (p.ask === ask) this.pendingApprovalsTG.delete(chatId)
      }
    })
    return Promise.race([promise, gui]) as Promise<string>
  }

  private async handleTgApproval(chatId: number, approval: TgPendingApproval, text: string): Promise<void> {
    const cleaned = text.trim().replace(/^\[+/, '').replace(/\]+$/, '').toUpperCase()
    if (cleaned === 'A' || cleaned === 'B') {
      approval.ask.answered = true
      for (const [cid, p] of this.pendingApprovalsTG) {
        if (p.ask === approval.ask) this.pendingApprovalsTG.delete(cid)
      }
      if (cleaned === 'A') {
        approval.ask.resolve('allowed-once')
        await this.enqueueNotice(chatId, `Разрешён один запуск: ${approval.toolName}`)
      } else {
        approval.ask.resolve('rejected')
        await this.enqueueNotice(chatId, 'Запуск инструмента отклонён')
      }
      return
    }
    await this.enqueueNotice(chatId, 'Ответьте [A] — разрешить один раз или [B] — отклонить (/cancel — закрыть)')
  }

  // ── /stop /mission /new commands ──

  private async stopBound(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const agent = this.findLiveAgent(binding.sessionId)
    if (!agent) {
      await this.client.sendMessage(chatId, 'В сессии нет выполняющейся задачи')
      return
    }
    try {
      agent.cancel({ kind: 'user' })
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: stop failed: ${this.redact(err)}`)
    }
    await this.enqueueNotice(chatId, 'Запрошена остановка текущего хода…')
  }

  private async sendMission(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const todos = this.lastTodos.get(binding.sessionId) ?? []
    const lines = ['Список задач']
    if (todos.length === 0) {
      lines.push('(записей пока нет — появятся, когда агент воспользуется todo)')
    } else {
      const mark: Record<string, string> = { completed: '✓', in_progress: '⟳', pending: '·' }
      todos.forEach((t, i) => lines.push(`${mark[t?.status ?? ''] ?? '·'} ${i + 1}. ${String(t?.content ?? '')}`))
      const done = todos.filter((t) => t?.status === 'completed').length
      lines.push(`— выполнено ${done}/${todos.length}`)
    }
    lines.push(this.busySessions.has(binding.sessionId) ? '(идёт задача: /stop прервёт её)' : '(свободна)')
    await this.client.sendMessage(chatId, lines.join('\n'))
  }

  /** /history [beforeSeq]: показать предыдущие сообщения сессии. */
  private async handleHistoryCommand(chatId: number, arg?: string): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    const raw = Number((arg ?? '').trim())
    await this.sendHistoryPage(chatId, binding.sessionId, Number.isFinite(raw) && raw > 0 ? raw : undefined)
  }

  /** /new: create a session in the bound session's workspace and attach to it. */
  private async newSessionHere(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.NEED_BIND)
      return
    }
    let workspaceId: string | undefined
    let fallbackCwd: string | undefined
    try {
      const catalog = await this.resolveCatalog()
      for (const ws of catalog?.workspaces ?? []) {
        if ((ws.sessionIds ?? []).includes(binding.sessionId)) {
          workspaceId = ws.id
          break
        }
      }
      if (workspaceId === undefined)
        fallbackCwd = catalog?.sessionsById?.get(binding.sessionId)?.cwd
    } catch {
      // Catalog unavailable → fall back to the host default workspace.
    }
    await this.createSessionInTarget(chatId, { workspaceId, cwd: fallbackCwd })
  }

  /**
   * Create a session in a workspace (or a directory) and bind the chat to it.
   * Works on both host generations: `sessionController.create` on DSH 0.2 and
   * `apiProxy.sessions.create` on 0.1.x.
   */
  private async createSessionInTarget(
    chatId: number,
    target: { workspaceId?: string; cwd?: string },
  ): Promise<void> {
    const proxy = resolveApiProxy(this.ctx)
    const payload = target.workspaceId !== undefined
      ? { workspaceId: target.workspaceId }
      : (target.cwd ? { cwd: target.cwd } : {})
    let newId: string | undefined
    if (!proxy?.sessions?.create) {
      // dsh 0.2: no apiProxy — `sessionController.create` is the host's own route.
      const controller = hostService<{
        create?: (request: typeof payload) => Promise<{ sessionId?: string }>
      }>(this.ctx, 'sessionController')
      if (typeof controller?.create !== 'function') {
        await this.client.sendMessage(chatId, 'Хост не поддерживает создание сессий')
        return
      }
      try {
        const created = await controller.create.call(controller, payload)
        newId = created?.sessionId
        if (!newId) throw new Error('хост не вернул идентификатор сессии')
      } catch (err) {
        await this.client.sendMessage(chatId, `Не удалось создать: ${this.redact(err)}`)
        return
      }
    } else {
      let res: { result?: { ok?: boolean; value?: { sessionId?: string }; error?: { message?: string } } } | undefined
      try {
        res = await proxy.sessions.create({
          rpcId: `tg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          payload,
        }) as typeof res
      } catch (err) {
        await this.client.sendMessage(chatId, `Не удалось создать: ${this.redact(err)}`)
        return
      }
      newId = res?.result?.ok ? res.result.value?.sessionId : undefined
      if (!newId) {
        const detail = res?.result?.error?.message ?? JSON.stringify(res?.result ?? res)
        await this.client.sendMessage(chatId, `Не удалось создать: ${String(detail).slice(0, 200)}`)
        return
      }
    }
    const stale = this.pendingAsks.get(String(chatId))
    if (stale && stale.sessionId !== String(newId)) this.pendingAsks.delete(String(chatId))
    const label = target.workspaceId !== undefined
      ? (this.pickers.get(String(chatId))?.workspaces.find((w) => w.id === target.workspaceId)?.title ?? 'новая сессия')
      : (target.cwd ?? 'новая сессия')
    this.bindings.set(String(chatId), { chatId, sessionId: String(newId), label })
    this.saveBindings()
    const where = target.workspaceId !== undefined
      ? `рабочая область ${label}`
      : (target.cwd ? `каталог ${target.cwd}` : 'рабочая область по умолчанию')
    await this.client.sendMessage(chatId, `Новый диалог создан и привязан (${where}):\n${String(newId)}\nПросто отправьте сообщение`)
  }

  /** /newproject: add a directory to the workspace registry (DSH 0.2). */
  private async createWorkspaceFromText(chatId: number, raw: string): Promise<void> {
    const text = raw.trim()
    if (!text) {
      await this.client.sendMessage(chatId, MSG.NEWPROJECT_USAGE)
      return
    }
    const sep = text.indexOf(' | ')
    const pathPart = (sep >= 0 ? text.slice(0, sep) : text).trim()
    const titlePart = sep >= 0 ? text.slice(sep + 3).trim() : ''
    if (!pathPart) {
      await this.client.sendMessage(chatId, MSG.NEWPROJECT_USAGE)
      return
    }
    const registry = hostService<{
      create?: (path: string, title?: string) => Promise<{ id?: string; path?: string; title?: string }>
    }>(this.ctx, 'workspaceRegistry')
    if (typeof registry?.create !== 'function') {
      await this.client.sendMessage(
        chatId,
        MSG.NEWPROJECT_FAILED('хост не умеет создавать рабочие области (нет workspaceRegistry)'),
      )
      return
    }
    try {
      const created = await registry.create.call(registry, pathPart, titlePart || undefined)
      this.pickers.delete(String(chatId))
      await this.client.sendMessage(
        chatId,
        MSG.NEWPROJECT_CREATED(created?.title ?? titlePart ?? pathPart, created?.path ?? pathPart),
      )
    } catch (err) {
      await this.client.sendMessage(chatId, MSG.NEWPROJECT_FAILED(this.redact(err)))
    }
  }

  /** /archive: move the bound session to the archive and unbind the chat. */
  private async archiveBound(chatId: number): Promise<void> {
    const binding = this.bindings.get(String(chatId))
    if (!binding) {
      await this.client.sendMessage(chatId, MSG.ARCHIVE_NONE)
      return
    }
    await this.archiveSessionById(chatId, binding.sessionId, binding.label)
  }

  /**
   * Archive one session through the host registry. `stopActivity` is requested
   * so a running session is stopped instead of being refused: an archived
   * session must not keep burning tokens.
   */
  private async archiveSessionById(
    chatId: number,
    sessionId: string,
    label?: string,
  ): Promise<boolean> {
    const registry = hostService<{
      archiveSession?: (id: string, options?: { stopActivity?: boolean }) => Promise<void>
    }>(this.ctx, 'workspaceRegistry')
    const call = registry?.archiveSession
    if (typeof call !== 'function') {
      await this.client.sendMessage(
        chatId,
        MSG.ARCHIVE_FAILED('хост не умеет архивировать (нет workspaceRegistry)'),
      )
      return false
    }
    try {
      await call.call(registry, sessionId, { stopActivity: true })
    } catch (err) {
      await this.client.sendMessage(chatId, MSG.ARCHIVE_FAILED(this.redact(err)))
      return false
    }
    const binding = this.bindings.get(String(chatId))
    if (binding?.sessionId === sessionId) {
      this.bindings.delete(String(chatId))
      this.pendingAsks.delete(String(chatId))
      this.saveBindings()
    }
    await this.client.sendMessage(chatId, MSG.ARCHIVE_DONE(label ?? sessionId))
    return true
  }

  /** /notify: what this chat receives, and about which sessions. */
  private async handleNotifyCommand(chatId: number, arg?: string): Promise<void> {
    const current = this.notificationMode(chatId)
    const wanted = (arg ?? '').trim().toLowerCase()
    if (wanted === 'every' || wanted === 'all-sessions' || wanted === 'watch') {
      this.notifyScope.set(String(chatId), 'every')
      if (this.notificationMode(chatId) === 'off') this.notifyPrefs.set(String(chatId), 'all')
      this.saveBindings()
      await this.client.sendMessage(chatId, 'Уведомления: слежу за ВСЕМИ сессиями (включая запущенные с компьютера).')
      return
    }
    if (wanted === 'bound' || wanted === 'session') {
      this.notifyScope.set(String(chatId), 'bound')
      this.saveBindings()
      await this.client.sendMessage(chatId, 'Уведомления: только за привязанной сессией.')
      return
    }
    if (wanted === 'on' || wanted === 'all') {
      this.notifyPrefs.set(String(chatId), 'all')
      this.saveBindings()
      await this.client.sendMessage(chatId, MSG.NOTIFY_SET('all'))
      return
    }
    if (wanted === 'errors' || wanted === 'error') {
      this.notifyPrefs.set(String(chatId), 'errors')
      this.saveBindings()
      await this.client.sendMessage(chatId, MSG.NOTIFY_SET('errors'))
      return
    }
    if (wanted === 'off' || wanted === 'none') {
      this.notifyPrefs.set(String(chatId), 'off')
      this.saveBindings()
      await this.client.sendMessage(chatId, MSG.NOTIFY_SET('off'))
      return
    }
    const scope = this.notifyScopeFor(chatId) === 'every' ? 'все сессии' : 'только привязанная'
    await this.client.sendMessage(chatId, `${MSG.NOTIFY_STATE(current)}\nОбласть: ${scope}.\nСменить: /notify every | bound`)
  }

  private notificationMode(chatId: number): 'all' | 'errors' | 'off' {
    return this.notifyPrefs.get(String(chatId)) ?? 'all'
  }

  /** Human explanation for a failed turn, with a hint for the usual causes. */
  private describeTurnError(error?: { message?: string; code?: string }): string {
    const raw = String(error?.message ?? '').replace(/\s+/g, ' ').trim()
    const code = String(error?.code ?? '').trim()
    const probe = `${code} ${raw}`.toLowerCase()
    let hint = ''
    if (/quota|credit|balance|insufficient|402|payment|token.?limit/.test(probe)) {
      hint = 'похоже, закончились токены или квота провайдера'
    } else if (/429|rate.?limit|too many requests|overload/.test(probe)) {
      hint = 'похоже, упёрлись в лимит запросов — попробуйте позже'
    } else if (/404|model.?not.?found|no such model|model.*(unavailable|not available|disabled)/.test(probe)) {
      hint = 'похоже, модель недоступна — смените её через /model'
    } else if (/context|too long|maximum.*token|overflow/.test(probe)) {
      hint = 'похоже, переполнен контекст — поможет /compact'
    } else if (/timeout|timed out|econnreset|econnrefused|network|fetch failed|dns/.test(probe)) {
      hint = 'похоже, сеть или недоступный провайдер'
    } else if (/401|403|unauthor|forbidden|api.?key|credential/.test(probe)) {
      hint = 'похоже, ключ или доступ к провайдеру не принят'
    }
    const tail = [code ? `Код: ${code}` : '', hint ? `Похоже: ${hint}` : ''].filter(Boolean).join(' · ')
    const head = raw || code || 'причина не сообщена'
    return `⚠️ Сессия упала: ${head}${tail ? `\n${tail}` : ''}`
  }

  /** «1 сессия / 2 сессии / 5 сессий» */
  private ruCount(n: number, one: string, few: string, many: string): string {
    const mod10 = n % 10
    const mod100 = n % 100
    const word = mod10 === 1 && mod100 !== 11
      ? one
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)
        ? few
        : many
    return `${n} ${word}`
  }

  // ── вывод: HTML, спойлеры, архив, история ──

  /** Send pre-built HTML; if Telegram rejects the markup, fall back to plain. */
  private async sendHtml(chatId: number, html: string, keyboard?: InlineKeyboardMarkup): Promise<void> {
    try {
      await this.withRetry(() => this.client.sendMessage(chatId, html, 'HTML', keyboard))
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: HTML send failed, falling back: ${this.redact(err)}`)
      await this.client.sendMessage(chatId, html.replace(/<[^>]+>/g, ''), undefined, keyboard)
    }
  }

  /** Collapsible block: Telegram shows it as "expandable quote", hidden by default. */
  private spoilerBlock(title: string, body: string, limit = 3000): string {
    const text = body.length > limit ? `${body.slice(0, limit)}\n… (обрезано)` : body
    return `<blockquote expandable>${title}\n<pre>${escapeHtml(text)}</pre></blockquote>`
  }

  /** Flush accumulated reasoning of one session as a spoiler block. */
  private async flushReasoning(sessionId: string): Promise<void> {
    const buffered = this.reasoningBuffers.get(sessionId)
    this.reasoningBuffers.delete(sessionId)
    if (!buffered || buffered.trim().length === 0) return
    const targets = [...this.bindings.values()].filter((b) => b.sessionId === sessionId)
    for (const b of targets) {
      await this.sendHtml(b.chatId, this.spoilerBlock('🧠 Рассуждения', buffered.trim()))
    }
  }

  /** List archived sessions with one-tap restore. */
  private async sendArchivedPicker(chatId: number): Promise<void> {
    const catalog = await this.resolveCatalog()
    const rows: SessionRow[] = []
    for (const rawId of catalog.archivedIds) {
      const row = catalog.sessionsById.get(rawId)
      if (row) rows.push(row)
      else rows.push({
        sessionId: rawId,
        title: `сессия …${String(rawId).slice(-8)}`,
        named: false,
        blank: false,
        running: false,
        updatedAt: 0,
      })
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt)
    if (rows.length === 0) {
      await this.client.sendMessage(chatId, 'Архив пуст.')
      return
    }
    const shown = rows.slice(0, MAX_BUTTONS)
    this.pickers.set(String(chatId), { workspaces: [], sessions: shown, catalog })
    const keyboard: InlineKeyboardMarkup = {
      inline_keyboard: shown.map((row, i) => ([{
        text: truncateButton(`↩ ${i + 1}. ${row.title}`),
        callback_data: `${UNARC_CB}${i}`,
      }])),
    }
    const body = [
      `Архив: ${this.ruCount(rows.length, 'сессия', 'сессии', 'сессий')}${rows.length > MAX_BUTTONS ? ` (показаны первые ${MAX_BUTTONS})` : ''}.`,
      '',
      ...shown.map((row, i) => {
        const project = this.projectLabel(row.sessionId, row.cwd)
        return `${i + 1}. ${row.title}${project ? ` · проект ${project}` : ''}`
      }),
      '',
      'Нажмите кнопку, чтобы вернуть сессию из архива.',
    ].join('\n')
    await this.client.sendMessage(chatId, body, undefined, keyboard)
  }

  /** Restore one session from the archive (host registry, DSH 0.2). */
  private async unarchiveSessionById(chatId: number, sessionId: string, label?: string): Promise<boolean> {
    const registry = hostService<{
      unarchiveSession?: (id: string) => Promise<void>
    }>(this.ctx, 'workspaceRegistry')
    const call = registry?.unarchiveSession
    if (typeof call !== 'function') {
      await this.client.sendMessage(chatId, 'Хост не умеет возвращать сессии из архива (нет workspaceRegistry).')
      return false
    }
    try {
      await call.call(registry, sessionId)
    } catch (err) {
      await this.client.sendMessage(chatId, `Не удалось вернуть из архива: ${this.redact(err)}`)
      return false
    }
    this.lastCatalog = undefined
    await this.client.sendMessage(chatId, `↩ Сессия возвращена из архива: ${label ?? `…${sessionId.slice(-8)}`}`)
    return true
  }

  /**
   * One page of real session history (user/assistant messages and tool calls as
   * spoilers) via the host session controller, newest page by default.
   */
  private async fetchHistoryPage(
    sessionId: string,
    beforeSeq?: number,
    maxMessages = 10,
  ): Promise<{ blocks: string[]; earliestSeq?: number; hasMore: boolean } | undefined> {
    const controller = hostService<{
      page?: (
        request: {
          address: { kind: 'session'; sessionId: string }
          throughSeq: number
          maxMessages?: number
          beforeSeq?: number
        },
      ) => Promise<{
        records?: Array<{ event?: { type?: string; seq?: number; data?: Record<string, unknown> } }>
        hasMore?: boolean
      }>
    }>(this.ctx, 'sessionController')
    const page = controller?.page
    if (typeof page !== 'function') return undefined
    try {
      const res = await page.call(controller, {
        address: { kind: 'session', sessionId },
        throughSeq: -1,
        maxMessages,
        ...(beforeSeq !== undefined ? { beforeSeq } : {}),
      })
      const records = res?.records ?? []
      const blocks: string[] = []
      let earliest: number | undefined
      for (const record of records) {
        const event = record?.event
        if (!event?.type) continue
        if (typeof event.seq === 'number' && (earliest === undefined || event.seq < earliest)) earliest = event.seq
        const data = (event.data ?? {}) as {
          message?: { content?: unknown }
          source?: { kind?: string }
          name?: string
          arguments?: unknown
        }
        if (event.type === 'user/message') {
          if (data.source?.kind !== undefined && data.source.kind !== 'user') continue
          const text = contentToText(data.message?.content)
          if (text.trim()) blocks.push(`👤 <b>Вы</b>\n${escapeHtml(text)}`)
        } else if (event.type === 'assistant/message') {
          const text = contentToText(data.message?.content)
          if (text.trim()) blocks.push(`🤖 <b>Ассистент</b>\n${escapeHtml(text)}`)
        } else if (event.type === 'tool/call') {
          const args = typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
          blocks.push(this.spoilerBlock(`🛠 ${escapeHtml(String(data.name ?? 'tool'))}`, args))
        }
      }
      return { blocks, earliestSeq: earliest, hasMore: Boolean(res?.hasMore) }
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: history page failed: ${this.redact(err)}`)
      return undefined
    }
  }

  /** Send a history page to the chat, with a "earlier" button when available. */
  private async sendHistoryPage(chatId: number, sessionId: string, beforeSeq?: number): Promise<void> {
    const page = await this.fetchHistoryPage(sessionId, beforeSeq)
    if (!page) {
      await this.client.sendMessage(chatId, 'История недоступна: хост не отдал страницу сессии.')
      return
    }
    if (page.blocks.length === 0) {
      await this.client.sendMessage(chatId, beforeSeq === undefined ? 'Сообщений в сессии пока нет.' : 'Раньше сообщений нет.')
      return
    }
    // Group events into messages below the Telegram limit.
    let buffer = ''
    const flush = async (): Promise<void> => {
      if (!buffer.trim()) return
      await this.sendHtml(chatId, buffer)
      buffer = ''
    }
    for (const block of page.blocks) {
      if (buffer.length + block.length > 3500) await flush()
      buffer = buffer ? `${buffer}\n\n${block}` : block
    }
    await flush()
    this.historyCursors.set(String(chatId), { sessionId, beforeSeq: page.earliestSeq })
    if (page.hasMore && page.earliestSeq !== undefined) {
      await this.client.sendMessage(chatId, 'Показаны последние сообщения. Ранее:', undefined, {
        inline_keyboard: [[{ text: '⬅ Раньше', callback_data: `${HIST_CB}${page.earliestSeq}` }]],
      })
    }
  }

  private bindingsPath(): string {
    // DSH_TELEGRAM_BINDINGS_FILE overrides the location (tests must isolate
    // from the real profile data — parallel test files share this file).
    const override = process.env.DSH_TELEGRAM_BINDINGS_FILE
    if (override) return override
    const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
    return join(home, 'telegram-channel-bindings.json')
  }

  private saveBindings(): void {
    try {
      const obj = {
        bindings: Object.fromEntries(this.bindings),
        renderPrefs: Object.fromEntries(this.renderPrefs),
        notifyPrefs: Object.fromEntries(this.notifyPrefs),
        notifyScope: Object.fromEntries(this.notifyScope),
        knownChats: [...this.knownChats],
      }
      mkdirSync(dirname(this.bindingsPath()), { recursive: true })
      writeFileSync(this.bindingsPath(), JSON.stringify(obj, null, 2))
    } catch (err) {
      this.ctx.logger.warn(`dsh-telegram-channel: saveBindings failed: ${this.redact(err)}`)
    }
  }

  private loadBindings(): void {
    try {
      const raw = readFileSync(this.bindingsPath(), 'utf8')
      const parsed = JSON.parse(raw) as unknown
      const data = parsed as {
        bindings?: Record<string, { chatId?: number; sessionId?: string; label?: string }>
        renderPrefs?: Record<string, string>
        notifyPrefs?: Record<string, string>
        notifyScope?: Record<string, string>
        knownChats?: number[]
      }
      // Legacy files (pre-renderPrefs) stored the bindings flat at the top level.
      const flat = parsed as Record<string, { chatId?: number; sessionId?: string; label?: string }>
      const bindingEntries = data.bindings ?? flat
      let n = 0
      for (const [chatId, b] of Object.entries(bindingEntries ?? {})) {
        if (b && b.sessionId) {
          this.bindings.set(String(chatId), {
            chatId: b.chatId ?? Number(chatId),
            sessionId: String(b.sessionId),
            label: b.label ?? String(b.sessionId),
          })
          n += 1
        }
      }
      for (const [chatId, mode] of Object.entries(data.renderPrefs ?? {})) {
        if (mode === 'rich' || mode === 'html') {
          this.renderPrefs.set(String(chatId), mode)
        }
      }
      for (const [chatId, mode] of Object.entries(data.notifyPrefs ?? {})) {
        if (mode === 'all' || mode === 'errors' || mode === 'off') {
          this.notifyPrefs.set(String(chatId), mode)
        }
      }
      for (const [chatId, scope] of Object.entries(data.notifyScope ?? {})) {
        if (scope === 'every' || scope === 'bound') {
          this.notifyScope.set(String(chatId), scope)
        }
      }
      for (const chatId of data.knownChats ?? []) {
        if (Number.isFinite(chatId)) this.knownChats.add(Number(chatId))
      }
      if (n > 0)
        this.ctx.logger.info(`dsh-telegram-channel: restored ${n} binding(s) from disk`)
    } catch {
      // First run: no file yet.
    }
  }

  private redact(value: unknown): string {
    const message = value instanceof Error ? value.message : String(value)
    return message.split(this.token).join('***')
  }
}

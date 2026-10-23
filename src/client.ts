import { EnvHttpProxyAgent, fetch as undiciFetch } from 'undici'

export interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  username?: string
}

export interface TelegramChat {
  id: number
  type: string
  title?: string
  username?: string
}

/** `getChat` result for a private chat: the user's display fields ride on the chat. */
export interface TelegramChatInfo extends TelegramChat {
  first_name?: string
  last_name?: string
}
export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramDocument {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  date: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  /** Media caption (photos/documents); TG puts it here, not in `text`. */
  caption?: string
  photo?: TelegramPhotoSize[]
  document?: TelegramDocument
  /** Album grouping id: several photo updates share one media_group_id. */
  media_group_id?: string
}

export interface TelegramFile {
  file_id: string
  file_unique_id: string
  file_size?: number
  file_path?: string
}

export interface TelegramCallbackQuery {
  id: string
  from: TelegramUser
  message?: TelegramMessage
  data?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: TelegramCallbackQuery
}

export interface InlineKeyboardButton {
  text: string
  callback_data: string
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][]
}

export interface TelegramBotCommand {
  command: string
  description: string
}

export interface TelegramInputRichMessage {
  markdown: string
  skip_entity_detection?: boolean
}

export interface TelegramClientOptions {
  fetch?: typeof fetch
  baseUrl?: string
  pollingTimeoutSec?: number
}

export interface TelegramClientLike {
  getMe(): Promise<TelegramUser>
  /** `getChat` — resolves an id or `@username`; optional so partial mocks still satisfy the type. */
  getChat?(chatId: number | string): Promise<TelegramChatInfo>
  getUpdates(offset?: number, signal?: AbortSignal): Promise<TelegramUpdate[]>
  sendMessage(
    chatId: number,
    text: string,
    parseMode?: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<TelegramMessage>
  /** Rewrite a sent message (used to mark an answered question). */
  editMessageText?(
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: string,
    replyMarkup?: InlineKeyboardMarkup | null,
  ): Promise<TelegramMessage | boolean>
  /** Replace/remove the inline keyboard of a sent message. */
  editMessageReplyMarkup?(
    chatId: number,
    messageId: number,
    replyMarkup?: InlineKeyboardMarkup | null,
  ): Promise<boolean>
  sendRichMessage(chatId: number, markdown: string): Promise<TelegramMessage>
  sendChatAction(chatId: number, action: string): Promise<boolean>
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>
  setMyCommands(commands: TelegramBotCommand[]): Promise<boolean>
  /** Russian profile text shown on the bot's card before the first message. */
  setMyDescription(description: string): Promise<boolean>
  /** One-line blurb used in bot lists and shares. */
  setMyShortDescription(shortDescription: string): Promise<boolean>
  /** Resolve a file_id to a file_path (downloadable URL suffix). */
  getFile(fileId: string): Promise<TelegramFile>
  /** Download file bytes from the Bot API file endpoint (GET, proxy-aware). */
  downloadFile(filePath: string): Promise<Uint8Array>
}

function resolveProxyUrl(): string | undefined {
  return (
    process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.https_proxy
    || process.env.http_proxy
    || undefined
  )
}

/**
 * Node's global `fetch` ignores HTTP(S)_PROXY unless `NODE_USE_ENV_PROXY=1`.
 * Undici's EnvHttpProxyAgent honors the env vars (and NO_PROXY).
 */
function createDefaultFetch(): typeof fetch {
  if (!resolveProxyUrl()) return globalThis.fetch
  const agent = new EnvHttpProxyAgent()
  const proxied = ((input: RequestInfo | URL, init?: RequestInit) =>
    undiciFetch(input as string | URL, {
      ...(init as Record<string, unknown>),
      dispatcher: agent,
    })) as unknown as typeof fetch
  return proxied
}

export class TelegramClient implements TelegramClientLike {
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly baseUrl: string
  private readonly pollingTimeoutSec: number

  constructor(token: string, options: TelegramClientOptions = {}) {
    if (!token) {
      throw new Error('bot token is required')
    }
    this.token = token
    this.fetchImpl = options.fetch ?? createDefaultFetch()
    this.baseUrl = options.baseUrl ?? 'https://api.telegram.org'
    this.pollingTimeoutSec = options.pollingTimeoutSec ?? 30
  }

  private redact(message: string): string {
    return message.split(this.token).join('***')
  }

  private async call<T>(method: string, body?: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`
    try {
      const init: RequestInit = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }
      if (body !== undefined) {
        init.body = JSON.stringify(body)
      }
      // A long poll holds the request open for `pollingTimeoutSec`; without the
      // signal a config reload (or shutdown) would wait for it to return.
      if (signal !== undefined) init.signal = signal
      const response = await this.fetchImpl(url, init)
      const json = (await response.json()) as { ok: boolean; result: T; description?: string }
      if (!json.ok) {
        throw new Error(json.description ?? 'Telegram API error')
      }
      return json.result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(this.redact(message))
    }
  }

  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe')
  }

  async getChat(chatId: number | string): Promise<TelegramChatInfo> {
    return this.call<TelegramChatInfo>('getChat', { chat_id: chatId })
  }

  async getUpdates(offset?: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    const body: Record<string, unknown> = {
      timeout: this.pollingTimeoutSec,
      allowed_updates: ['message', 'callback_query'],
    }
    if (offset !== undefined) {
      body.offset = offset
    }
    return this.call<TelegramUpdate[]>('getUpdates', body, signal)
  }

  async sendMessage(
    chatId: number,
    text: string,
    parseMode?: string,
    replyMarkup?: InlineKeyboardMarkup,
  ): Promise<TelegramMessage> {
    const body: Record<string, unknown> = { chat_id: chatId, text }
    if (parseMode !== undefined) {
      body.parse_mode = parseMode
    }
    if (replyMarkup !== undefined) {
      body.reply_markup = replyMarkup
    }
    return this.call<TelegramMessage>('sendMessage', body)
  }

  async editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    parseMode?: string,
    replyMarkup?: InlineKeyboardMarkup | null,
  ): Promise<TelegramMessage | boolean> {
    const body: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text }
    if (parseMode !== undefined) body.parse_mode = parseMode
    if (replyMarkup !== undefined) body.reply_markup = replyMarkup ?? { inline_keyboard: [] }
    return this.call<TelegramMessage | boolean>('editMessageText', body)
  }

  async editMessageReplyMarkup(
    chatId: number,
    messageId: number,
    replyMarkup?: InlineKeyboardMarkup | null,
  ): Promise<boolean> {
    return this.call<boolean>('editMessageReplyMarkup', {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: replyMarkup ?? { inline_keyboard: [] },
    })
  }

  async sendRichMessage(chatId: number, markdown: string): Promise<TelegramMessage> {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      rich_message: {
        markdown,
        skip_entity_detection: true,
      },
    }
    return this.call<TelegramMessage>('sendRichMessage', body)
  }

  async sendChatAction(chatId: number, action: string): Promise<boolean> {
    return this.call<boolean>('sendChatAction', { chat_id: chatId, action })
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean> {
    const body: Record<string, unknown> = { callback_query_id: callbackQueryId }
    if (text !== undefined) body.text = text
    return this.call<boolean>('answerCallbackQuery', body)
  }

  async setMyCommands(commands: TelegramBotCommand[]): Promise<boolean> {
    return this.call<boolean>('setMyCommands', { commands })
  }

  async setMyDescription(description: string): Promise<boolean> {
    return this.call<boolean>('setMyDescription', { description })
  }

  async setMyShortDescription(shortDescription: string): Promise<boolean> {
    return this.call<boolean>('setMyShortDescription', { short_description: shortDescription })
  }

  async getFile(fileId: string): Promise<TelegramFile> {
    return this.call<TelegramFile>('getFile', { file_id: fileId })
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const url = `${this.baseUrl}/file/bot${this.token}/${filePath}`
    try {
      const response = await this.fetchImpl(url)
      if (!response.ok) {
        throw new Error(`Telegram file download failed: HTTP ${String(response.status)}`)
      }
      return new Uint8Array(await response.arrayBuffer())
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(this.redact(message))
    }
  }
}

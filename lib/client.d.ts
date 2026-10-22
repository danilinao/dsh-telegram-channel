export interface TelegramUser {
    id: number;
    is_bot?: boolean;
    first_name?: string;
    username?: string;
}
export interface TelegramChat {
    id: number;
    type: string;
    title?: string;
    username?: string;
}
/** `getChat` result for a private chat: the user's display fields ride on the chat. */
export interface TelegramChatInfo extends TelegramChat {
    first_name?: string;
    last_name?: string;
}
export interface TelegramPhotoSize {
    file_id: string;
    file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
}
export interface TelegramDocument {
    file_id: string;
    file_unique_id: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
}
export interface TelegramMessage {
    message_id: number;
    date: number;
    chat: TelegramChat;
    from?: TelegramUser;
    text?: string;
    /** Media caption (photos/documents); TG puts it here, not in `text`. */
    caption?: string;
    photo?: TelegramPhotoSize[];
    document?: TelegramDocument;
    /** Album grouping id: several photo updates share one media_group_id. */
    media_group_id?: string;
}
export interface TelegramFile {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    file_path?: string;
}
export interface TelegramCallbackQuery {
    id: string;
    from: TelegramUser;
    message?: TelegramMessage;
    data?: string;
}
export interface TelegramUpdate {
    update_id: number;
    message?: TelegramMessage;
    callback_query?: TelegramCallbackQuery;
}
export interface InlineKeyboardButton {
    text: string;
    callback_data: string;
}
export interface InlineKeyboardMarkup {
    inline_keyboard: InlineKeyboardButton[][];
}
export interface TelegramBotCommand {
    command: string;
    description: string;
}
export interface TelegramInputRichMessage {
    markdown: string;
    skip_entity_detection?: boolean;
}
export interface TelegramClientOptions {
    fetch?: typeof fetch;
    baseUrl?: string;
    pollingTimeoutSec?: number;
}
export interface TelegramClientLike {
    getMe(): Promise<TelegramUser>;
    /** `getChat` — resolves an id or `@username`; optional so partial mocks still satisfy the type. */
    getChat?(chatId: number | string): Promise<TelegramChatInfo>;
    getUpdates(offset?: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
    sendMessage(chatId: number, text: string, parseMode?: string, replyMarkup?: InlineKeyboardMarkup): Promise<TelegramMessage>;
    sendRichMessage(chatId: number, markdown: string): Promise<TelegramMessage>;
    sendChatAction(chatId: number, action: string): Promise<boolean>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    setMyCommands(commands: TelegramBotCommand[]): Promise<boolean>;
    /** Russian profile text shown on the bot's card before the first message. */
    setMyDescription(description: string): Promise<boolean>;
    /** One-line blurb used in bot lists and shares. */
    setMyShortDescription(shortDescription: string): Promise<boolean>;
    /** Resolve a file_id to a file_path (downloadable URL suffix). */
    getFile(fileId: string): Promise<TelegramFile>;
    /** Download file bytes from the Bot API file endpoint (GET, proxy-aware). */
    downloadFile(filePath: string): Promise<Uint8Array>;
}
export declare class TelegramClient implements TelegramClientLike {
    private readonly token;
    private readonly fetchImpl;
    private readonly baseUrl;
    private readonly pollingTimeoutSec;
    constructor(token: string, options?: TelegramClientOptions);
    private redact;
    private call;
    getMe(): Promise<TelegramUser>;
    getChat(chatId: number | string): Promise<TelegramChatInfo>;
    getUpdates(offset?: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
    sendMessage(chatId: number, text: string, parseMode?: string, replyMarkup?: InlineKeyboardMarkup): Promise<TelegramMessage>;
    sendRichMessage(chatId: number, markdown: string): Promise<TelegramMessage>;
    sendChatAction(chatId: number, action: string): Promise<boolean>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    setMyCommands(commands: TelegramBotCommand[]): Promise<boolean>;
    setMyDescription(description: string): Promise<boolean>;
    setMyShortDescription(shortDescription: string): Promise<boolean>;
    getFile(fileId: string): Promise<TelegramFile>;
    downloadFile(filePath: string): Promise<Uint8Array>;
}

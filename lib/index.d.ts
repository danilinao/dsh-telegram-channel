import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "dsh-telegram-channel-ru";
/** agents: followup; apiProxy and userQuestions are optional runtime services. */
export declare const inject: string[];
export interface TelegramChannelConfig {
    token?: string;
    allowedUserIds?: number[];
    allowAllUsers?: boolean;
    maxMessageLength?: number;
    pollingTimeoutSec?: number;
    /** 'rich' = Telegram native Rich Messages (needs a recent client);
     *  anything else (default) = HTML compatibility mode that renders on all clients. */
    rendering?: string;
}
export declare const Config: Schema<TelegramChannelConfig>;
export declare function apply(ctx: Context, config: TelegramChannelConfig): void;
export * from './format.js';
export * from './client.js';
export * from './auth.js';
export * from './commands.js';
export * from './label.js';
export * from './bridge.js';

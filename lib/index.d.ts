import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
import { type RawTelegramChannelConfig, type TelegramChannelConfig } from './config.js';
import { type TelegramClientLike } from './client.js';
export declare const name = "dsh-telegram-channel-ru";
/** agents: followup; apiProxy and userQuestions are optional runtime services. */
export declare const inject: string[];
/**
 * The loader announces live config writes with this event. Its declaration
 * lives in `@deepseek-ai/cordis-plugin-loader`, which this package does not
 * depend on, so the shape is restated here — identical to the loader's own.
 */
declare module '@deepseek-ai/cordis' {
    interface Events {
        'loader/volatile-update'(paths: readonly (readonly string[])[]): void;
    }
}
export type { TelegramChannelConfig, TelegramUserEntry } from './config.js';
/**
 * Plugin configuration.
 *
 * Every field is `.volatile()`: DSH 0.2 only builds a Web settings form for a
 * plugin whose Config has at least one volatile field, and only volatile paths
 * may be written from the GUI. Volatile fields reach `apply` as live boxes
 * (read with `readVolatile`), and `loader/volatile-update` tells this plugin to
 * rebuild its bridge with the new values — saving in the Web UI applies
 * immediately, without restarting `dsh`.
 *
 * `token` is `.role('secret')`: DSH strips it before the settings document ever
 * reaches the browser, so the page can replace it but never read it.
 *
 * `users` is the list the Web UI edits (several people, each switchable);
 * `allowedUserIds` is the pre-0.9.0 flat list, kept as a fallback for existing
 * profiles. See `./config.ts` for the precedence rules.
 */
export declare const Config: Schema<TelegramChannelConfig>;
/** Extra seams for tests: none of these are part of the plugin contract. */
export interface ApplyOptions {
    /** Factory for the Telegram client (defaults to the real Bot API client). */
    clientFor?: (token: string) => TelegramClientLike;
    /** Skip the coalescing delay before a live config restart (tests). */
    restartDelayMs?: number;
}
export declare function apply(ctx: Context, config?: RawTelegramChannelConfig): void;
/**
 * The plugin's real body, with the client factory exposed for tests so a case
 * never talks to Telegram.
 * @param ctx - the Cordis context (or a structural double in tests).
 * @param config - the config `apply` received, volatile fields still boxed.
 * @param options - client factory and restart delay overrides.
 */
export declare function applyWith(ctx: Context, config: RawTelegramChannelConfig, options: ApplyOptions): void;
export { envUserIds, resolveConfig, resolveEffectiveUserIds, normalizeUsers, configSignature } from './config.js';
export * from './format.js';
export * from './client.js';
export * from './auth.js';
export * from './commands.js';
export * from './label.js';
export * from './bridge.js';
export * from './settings-api.js';

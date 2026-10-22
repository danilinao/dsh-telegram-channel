/**
 * Configuration resolution for the Telegram channel plugin.
 *
 * DSH 0.2 hands `apply` a `.volatile()` config field as a live reference
 * (`Volatile<T>`: a stable box whose `get()` returns the current value) so the
 * Web GUI can edit it without remounting the plugin. Every field this plugin
 * exposes in the GUI is volatile — the settings form only ever lists volatile
 * fields — so the plugin keeps the boxes and re-reads them whenever the loader
 * reports `loader/volatile-update`.
 *
 * The same functions are used by the plain (non-volatile) unit tests and by the
 * legacy `DSH_TELEGRAM_*` environment fallbacks, so nothing here assumes a DSH
 * host is present.
 *
 * Two allowlists exist on purpose:
 *   - `users` is what the Web GUI edits: `{ id, name?, enabled? }`, several
 *     people, each individually switchable;
 *   - `allowedUserIds` is the pre-0.9.0 flat number list, still honoured so an
 *     existing `cordis.patch.yml` keeps authorizing the same people.
 * `users` wins as soon as it has an entry; the flat list is the fallback, and
 * the environment list is the last resort. The GUI writes `users` and clears
 * `allowedUserIds` in the same atomic mutation, so the two never disagree.
 */
import type { Volatile } from '@deepseek-ai/cordis';
/** One person allowed to talk to the bot. */
export interface TelegramUserEntry {
    /** Telegram numeric user id (never a chat id: groups are not supported). */
    id: number;
    /** Optional label shown in the Web settings and in logs; falls back to the Telegram name. */
    name?: string;
    /** `false` keeps the person listed but unauthorized (default `true`). */
    enabled?: boolean;
}
/** The plugin's Config, as authored (plain values). */
export interface TelegramChannelConfig {
    token?: string;
    users?: TelegramUserEntry[];
    allowedUserIds?: number[];
    allowAllUsers?: boolean;
    maxMessageLength?: number;
    pollingTimeoutSec?: number;
    /** 'rich' = Telegram native Rich Messages (needs a recent client);
     *  anything else (default) = HTML compatibility mode that renders on all clients. */
    rendering?: string;
}
/**
 * A config value DSH may hand `apply` either plainly (hosts without volatile
 * config support, unit tests) or as a live box.
 */
export type MaybeVolatile<T> = T | Volatile<T>;
/** The runtime shape `apply` actually receives. */
export interface RawTelegramChannelConfig {
    token?: MaybeVolatile<string>;
    users?: MaybeVolatile<TelegramUserEntry[]>;
    allowedUserIds?: MaybeVolatile<number[]>;
    allowAllUsers?: MaybeVolatile<boolean>;
    maxMessageLength?: MaybeVolatile<number>;
    pollingTimeoutSec?: MaybeVolatile<number>;
    rendering?: MaybeVolatile<string>;
}
/** Fully resolved values the bridge is built from. */
export interface ResolvedConfig {
    token: string;
    /** Normalized user entries (only finite positive ids, deduplicated). */
    users: TelegramUserEntry[];
    /** Normalized legacy flat allowlist. */
    allowedUserIds: number[];
    /** The list the authorization gate uses: enabled users, else the legacy list, else the env list. */
    effectiveUserIds: number[];
    allowAllUsers: boolean;
    maxMessageLength: number;
    pollingTimeoutSec: number;
    rendering: 'html' | 'rich';
}
/** Defensive cap: a settings page cannot grow the allowlist without bound. */
export declare const MAX_USERS = 200;
/** Is this value one of DSH's live config references? */
export declare function isVolatile(value: unknown): boolean;
/** Read one config value, unwrapping a live reference when the host supplied one. */
export declare function readVolatile(value: unknown): unknown;
/**
 * Normalize one user list: drop ids that are not positive integers, keep the
 * first occurrence of a duplicated id, trim labels, and cap the length.
 * @param value - whatever the config/JSON held for `users`.
 */
export declare function normalizeUsers(value: unknown): TelegramUserEntry[];
/** Normalize the legacy flat allowlist (`[1, 2]`, `["1"]`, mixed). */
export declare function normalizeUserIds(value: unknown): number[];
/** Read the environment fallback allowlist (`DSH_TELEGRAM_ALLOWED_USER_IDS`). */
export declare function envUserIds(env?: NodeJS.ProcessEnv): number[];
/** Ids of the entries that are not switched off. */
export declare function enabledUserIds(users: readonly TelegramUserEntry[]): number[];
/**
 * Resolve the authorization list from the three sources, in order:
 * the GUI-managed `users`, the legacy flat `allowedUserIds`, the environment.
 * @param users - normalized user entries (GUI-managed list).
 * @param allowedUserIds - normalized legacy list.
 * @param env - process environment used for the last-resort fallback.
 */
export declare function resolveEffectiveUserIds(users: readonly TelegramUserEntry[], allowedUserIds: readonly number[], env?: NodeJS.ProcessEnv): number[];
/**
 * Unwrap every field of the runtime config and normalize it into the values the
 * bridge is constructed from. Called once at start and again on every live
 * config update.
 * @param config - the config object `apply` received.
 * @param env - environment used for the token and allowlist fallbacks.
 */
export declare function resolveConfig(config?: RawTelegramChannelConfig, env?: NodeJS.ProcessEnv): ResolvedConfig;
/**
 * Stable identity of the values a running bridge depends on. Two resolutions
 * with the same signature need no restart; anything else (token, allowlist,
 * limits, rendering) rebuilds the bridge. The token is part of the signature
 * but is never logged.
 * @param resolved - a resolved configuration.
 */
export declare function configSignature(resolved: ResolvedConfig): string;

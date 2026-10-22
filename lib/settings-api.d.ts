/**
 * The two tiny HTTP routes the Web settings page uses.
 *
 * The settings *form* itself is DSH's own (`plugins.bundle.config` slot writing
 * through `ctx.configForms`), but two facts cannot come from the config
 * document: who the token belongs to (`getMe`) and the people Telegram knows
 * (`getChat`). Both live in the running bridge, so the host half exposes them
 * here.
 *
 * Everything is read-only metadata: the bot token never crosses this boundary.
 * The routes are plain host routes (`/plugins/<package>/settings/...`), not
 * `/api`, so they are same-origin but not session-gated — hence the narrow
 * payload, `no-store`, and the same-origin check on the one POST.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** Where the settings page asks for bot identity, allowlist and known people. */
export declare const SETTINGS_INFO_PATH = "/plugins/dsh-telegram-channel-ru/settings/info";
/** Where the settings page resolves `@username` → numeric id when adding a person. */
export declare const SETTINGS_RESOLVE_PATH = "/plugins/dsh-telegram-channel-ru/settings/resolve";
/** What the info route returns. */
export interface SettingsInfo {
    ok: true;
    running: boolean;
    tokenSet: boolean;
    bot?: {
        id: number;
        username?: string;
        name?: string;
    };
    /** Human-readable reason the token could not be used (bad token, network). */
    error?: string;
    allowAllUsers: boolean;
    users: Array<{
        id: number;
        name?: string;
        username?: string;
        enabled?: boolean;
        bound?: boolean;
    }>;
    people: Array<{
        id: number;
        name?: string;
        username?: string;
        at: number;
    }>;
    bindings: Array<{
        chatId: number;
        sessionId: string;
        label: string;
    }>;
}
/** What the resolve route answers for one `@username` / id. */
export interface ResolvedPerson {
    id: number;
    name?: string;
    username?: string;
}
export interface SettingsApiDeps {
    /** Everything the page shows; may fail on its own (a dead token is data, not an error). */
    describe: () => Promise<SettingsInfo>;
    /** Resolve one person the owner typed. */
    resolve: (query: string) => Promise<ResolvedPerson>;
    logger: {
        warn: (message: string) => void;
    };
}
export interface SettingsApiHandlers {
    info: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
    resolve: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}
/**
 * Build the route handlers over the plugin's current state.
 * @param deps - state readers owned by the host half.
 * @returns the two `webServer.register` handlers.
 */
export declare function createSettingsApi(deps: SettingsApiDeps): SettingsApiHandlers;

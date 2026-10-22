import Schema from '@deepseek-ai/schemastery';
import { TelegramBridge } from './bridge.js';
import { configSignature, resolveConfig, } from './config.js';
import { TelegramClient } from './client.js';
import { SETTINGS_INFO_PATH, SETTINGS_RESOLVE_PATH, createSettingsApi, } from './settings-api.js';
export const name = 'dsh-telegram-channel-ru';
/** agents: followup; apiProxy and userQuestions are optional runtime services. */
export const inject = ['agents'];
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
export const Config = Schema.object({
    token: Schema.string().role('secret').volatile().default(''),
    users: Schema.array(Schema.object({
        id: Schema.number(),
        name: Schema.string().default(''),
        enabled: Schema.boolean().default(true),
    })).volatile().default([]),
    allowedUserIds: Schema.array(Schema.number()).volatile().default([]),
    allowAllUsers: Schema.boolean().volatile().default(false),
    maxMessageLength: Schema.number().volatile().default(4096),
    pollingTimeoutSec: Schema.number().volatile().default(30),
    rendering: Schema.string().volatile().default('html'),
});
export function apply(ctx, config = {}) {
    applyWith(ctx, config, {});
}
/**
 * The plugin's real body, with the client factory exposed for tests so a case
 * never talks to Telegram.
 * @param ctx - the Cordis context (or a structural double in tests).
 * @param config - the config `apply` received, volatile fields still boxed.
 * @param options - client factory and restart delay overrides.
 */
export function applyWith(ctx, config, options) {
    const clientFor = options.clientFor ?? ((token) => new TelegramClient(token));
    const restartDelayMs = options.restartDelayMs ?? 150;
    let resolved = resolveConfig(config);
    let bridge;
    /** Confirmed `getUpdates` offset, carried across live config reloads. */
    let offset;
    /** Signature of the configuration the running bridge was built from. */
    let running = '';
    /** Token the running bridge polls with; a new bot starts from a clean offset. */
    let runningToken = '';
    let disposed = false;
    let restartTimer;
    let restartChain = Promise.resolve();
    const probes = new Map();
    const describeFailure = (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const token = resolved.token;
        return token.length > 0 ? message.split(token).join('***') : message;
    };
    /** Build and start a bridge from the current resolution. */
    const startBridge = () => {
        if (resolved.token.length === 0) {
            running = configSignature(resolved);
            ctx.logger.error('dsh-telegram-channel: missing bot token (set config.token or DSH_TELEGRAM_TOKEN); polling not started');
            return;
        }
        const next = new TelegramBridge(ctx, {
            token: resolved.token,
            allowedUserIds: resolved.effectiveUserIds,
            allowAllUsers: resolved.allowAllUsers,
            users: resolved.users,
            maxMessageLength: resolved.maxMessageLength,
            pollingTimeoutSec: resolved.pollingTimeoutSec,
            rendering: resolved.rendering,
            client: clientFor(resolved.token),
            ...(offset === undefined ? {} : { offset }),
        });
        bridge = next;
        running = configSignature(resolved);
        runningToken = resolved.token;
        next.start();
    };
    /** Stop the running bridge, keeping its confirmed offset for the successor. */
    const stopBridge = async () => {
        const current = bridge;
        bridge = undefined;
        if (current === undefined)
            return;
        offset = current.currentOffset ?? offset;
        await current.stop();
    };
    /** Stop + start once, unless the running bridge already matches the config. */
    const applyLive = async () => {
        if (disposed)
            return;
        if (configSignature(resolved) === running)
            return;
        // Updates confirmed by one bot mean nothing to another: a token change
        // starts from whatever Telegram still has pending.
        if (resolved.token !== runningToken)
            offset = undefined;
        await stopBridge();
        if (disposed)
            return;
        startBridge();
        ctx.logger.info('dsh-telegram-channel: settings applied without a restart');
    };
    ctx.effect(() => {
        startBridge();
        return () => {
            disposed = true;
            if (restartTimer !== undefined) {
                clearTimeout(restartTimer);
                restartTimer = undefined;
            }
            void stopBridge();
        };
    }, 'dsh-telegram-channel.serve');
    // A save in the Web settings writes the profile patch; the loader updates the
    // volatile boxes in place and announces the paths. Rebuild the bridge with the
    // new token/allowlist, coalescing a batch of writes into one restart.
    ctx.on('loader/volatile-update', () => {
        const next = resolveConfig(config);
        const changed = configSignature(next) !== configSignature(resolved);
        resolved = next;
        if (!changed || disposed)
            return;
        if (restartTimer !== undefined)
            clearTimeout(restartTimer);
        restartTimer = setTimeout(() => {
            restartTimer = undefined;
            restartChain = restartChain.then(applyLive).catch((err) => {
                ctx.logger.error(`dsh-telegram-channel: applying settings failed: ${describeFailure(err)}`);
            });
        }, restartDelayMs);
        if (typeof restartTimer.unref === 'function') {
            restartTimer.unref();
        }
    });
    /** Probe one token with `getMe`, cached for a minute (never logs the token). */
    const probeToken = async (token) => {
        const cached = probes.get(token);
        if (cached !== undefined && Date.now() - cached.at < 60_000)
            return cached;
        const result = { at: Date.now() };
        try {
            const me = await clientFor(token).getMe();
            result.bot = {
                id: me.id,
                ...(me.username === undefined ? {} : { username: me.username }),
                ...(me.first_name === undefined ? {} : { name: me.first_name }),
            };
        }
        catch (err) {
            result.error = describeFailure(err);
        }
        probes.clear();
        probes.set(token, result);
        return result;
    };
    /** Everything the settings page shows; works with or without a running bridge. */
    const describeSettings = async () => {
        const current = bridge;
        if (current !== undefined)
            return { ok: true, ...(await current.describeSettings()) };
        const token = resolved.token;
        const allowAllUsers = resolved.allowAllUsers;
        const users = resolved.effectiveUserIds.map((id) => ({ id }));
        if (token.length === 0) {
            return { ok: true, running: false, tokenSet: false, allowAllUsers, users, people: [], bindings: [] };
        }
        const probe = await probeToken(token);
        return {
            ok: true,
            running: false,
            tokenSet: true,
            ...(probe.bot === undefined ? {} : { bot: probe.bot }),
            ...(probe.error === undefined ? {} : { error: probe.error }),
            allowAllUsers,
            users,
            people: [],
            bindings: [],
        };
    };
    /** Resolve `@username` / numeric id for the “add a user” field. */
    const resolvePerson = async (query) => {
        const current = bridge;
        if (current !== undefined)
            return current.resolvePerson(query);
        if (resolved.token.length === 0)
            throw new Error('сначала задайте токен бота');
        const chat = await clientFor(resolved.token).getChat?.(/^\d+$/.test(query) ? Number(query) : query);
        if (chat === undefined)
            throw new Error('этот клиент Telegram не умеет искать пользователей');
        const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
        return {
            id: chat.id,
            ...(name.length > 0 ? { name } : {}),
            ...(chat.username === undefined ? {} : { username: chat.username }),
        };
    };
    // The Web settings page needs bot identity and resolved Telegram names, which
    // only the host can read. `webServer` is optional: a composition without the
    // Web carrier simply has no settings page, and the bot works as before.
    ctx.inject(['webServer'], (scoped) => {
        const webServer = scoped.webServer;
        if (webServer === undefined)
            return;
        const api = createSettingsApi({
            describe: describeSettings,
            resolve: resolvePerson,
            logger: { warn: (message) => ctx.logger.warn(message) },
        });
        ctx.effect(() => webServer.register({ kind: 'exact', path: SETTINGS_INFO_PATH, handler: api.info }), 'dsh-telegram-channel.settings-info');
        ctx.effect(() => webServer.register({ kind: 'exact', path: SETTINGS_RESOLVE_PATH, handler: api.resolve }), 'dsh-telegram-channel.settings-resolve');
    });
}
export { envUserIds, resolveConfig, resolveEffectiveUserIds, normalizeUsers, configSignature } from './config.js';
export * from './format.js';
export * from './client.js';
export * from './auth.js';
export * from './commands.js';
export * from './label.js';
export * from './bridge.js';
export * from './settings-api.js';

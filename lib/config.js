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
/** Defensive cap: a settings page cannot grow the allowlist without bound. */
export const MAX_USERS = 200;
/** Is this value one of DSH's live config references? */
export function isVolatile(value) {
    return (value !== null
        && typeof value === 'object'
        && typeof value.get === 'function'
        && !Array.isArray(value));
}
/** Read one config value, unwrapping a live reference when the host supplied one. */
export function readVolatile(value) {
    return isVolatile(value) ? value.get() : value;
}
/** Trimmed non-empty text or `''`. */
function asText(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/** Non-negative integer from a number or a numeric string, else `undefined`. */
function asPositiveInt(value) {
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof n !== 'number' || !Number.isFinite(n))
        return undefined;
    const id = Math.trunc(n);
    return id > 0 ? id : undefined;
}
/** Cap a positive finite number between `min` and `max` (inclusive). */
function asClamped(value, min, max, fallback) {
    const n = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof n !== 'number' || !Number.isFinite(n))
        return fallback;
    return Math.min(max, Math.max(min, Math.trunc(n)));
}
/**
 * Normalize one user list: drop ids that are not positive integers, keep the
 * first occurrence of a duplicated id, trim labels, and cap the length.
 * @param value - whatever the config/JSON held for `users`.
 */
export function normalizeUsers(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const out = [];
    for (const raw of value) {
        if (out.length >= MAX_USERS)
            break;
        const source = raw !== null && typeof raw === 'object' ? raw : {};
        // A bare number (or numeric string) is accepted too: hand-written YAML often
        // has `- 123`.
        const id = asPositiveInt(typeof raw === 'number' || typeof raw === 'string' ? raw : source.id);
        if (id === undefined || seen.has(id))
            continue;
        seen.add(id);
        const name = asText(source.name);
        const entry = { id };
        if (name.length > 0)
            entry.name = name;
        entry.enabled = source.enabled !== false;
        out.push(entry);
    }
    return out;
}
/** Normalize the legacy flat allowlist (`[1, 2]`, `["1"]`, mixed). */
export function normalizeUserIds(value) {
    if (!Array.isArray(value))
        return [];
    const seen = new Set();
    const out = [];
    for (const raw of value) {
        const id = asPositiveInt(raw);
        if (id === undefined || seen.has(id))
            continue;
        seen.add(id);
        out.push(id);
        if (out.length >= MAX_USERS)
            break;
    }
    return out;
}
/** Read the environment fallback allowlist (`DSH_TELEGRAM_ALLOWED_USER_IDS`). */
export function envUserIds(env = process.env) {
    const raw = env.DSH_TELEGRAM_ALLOWED_USER_IDS ?? '';
    return normalizeUserIds(raw.split(/[,;\s]+/).filter(Boolean));
}
/** Ids of the entries that are not switched off. */
export function enabledUserIds(users) {
    return users.filter((user) => user.enabled !== false).map((user) => user.id);
}
/**
 * Resolve the authorization list from the three sources, in order:
 * the GUI-managed `users`, the legacy flat `allowedUserIds`, the environment.
 * @param users - normalized user entries (GUI-managed list).
 * @param allowedUserIds - normalized legacy list.
 * @param env - process environment used for the last-resort fallback.
 */
export function resolveEffectiveUserIds(users, allowedUserIds, env = process.env) {
    if (users.length > 0)
        return enabledUserIds(users);
    if (allowedUserIds.length > 0)
        return [...allowedUserIds];
    return envUserIds(env);
}
/**
 * Unwrap every field of the runtime config and normalize it into the values the
 * bridge is constructed from. Called once at start and again on every live
 * config update.
 * @param config - the config object `apply` received.
 * @param env - environment used for the token and allowlist fallbacks.
 */
export function resolveConfig(config = {}, env = process.env) {
    const token = asText(readVolatile(config.token)) || asText(env.DSH_TELEGRAM_TOKEN);
    const users = normalizeUsers(readVolatile(config.users));
    const allowedUserIds = normalizeUserIds(readVolatile(config.allowedUserIds));
    return {
        token,
        users,
        allowedUserIds,
        effectiveUserIds: resolveEffectiveUserIds(users, allowedUserIds, env),
        allowAllUsers: readVolatile(config.allowAllUsers) === true,
        maxMessageLength: asClamped(readVolatile(config.maxMessageLength), 100, 4096, 4096),
        pollingTimeoutSec: asClamped(readVolatile(config.pollingTimeoutSec), 0, 120, 30),
        rendering: readVolatile(config.rendering) === 'rich' ? 'rich' : 'html',
    };
}
/**
 * Stable identity of the values a running bridge depends on. Two resolutions
 * with the same signature need no restart; anything else (token, allowlist,
 * limits, rendering) rebuilds the bridge. The token is part of the signature
 * but is never logged.
 * @param resolved - a resolved configuration.
 */
export function configSignature(resolved) {
    return JSON.stringify([
        resolved.token,
        resolved.allowAllUsers,
        resolved.maxMessageLength,
        resolved.pollingTimeoutSec,
        resolved.rendering,
        resolved.effectiveUserIds,
        resolved.users.map((user) => [user.id, user.name ?? '', user.enabled !== false]),
    ]);
}

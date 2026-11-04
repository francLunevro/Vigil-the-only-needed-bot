// ──────────────────── Custom Commands & Autoresponders ────────────────────
// Two per-guild features that share one storage story (SQLite) and one
// execution point (an ordinary message):
//
//   • Custom commands — `;rules` answers with text the server wrote. They only
//     fire on the configured prefix, and a built-in command always wins, so a
//     server can never shadow `/ban` with something silly.
//   • Autoresponders — trigger text (exact / starts-with / contains / regex)
//     that answers anywhere in the server, optionally scoped to one channel.
//
// Responses are expanded through the same placeholder table the welcome/goodbye
// messages use (helpers.replacePlaceholders) plus {channel} and {args}, and
// every outgoing payload allows user mentions only — never @everyone/@here.
//
// Autoresponders are the loop-shaped feature here: a trigger that matches its
// own response would answer forever. Three things stop that — the bot's own
// messages never reach the matcher, at most one responder fires per message,
// and each (responder, user) pair has a cooldown.

const { getDb } = require('./db');
const { logError } = require('./logError');
const { replacePlaceholders, truncate } = require('./helpers');
const { makeEmbed } = require('./embeds');
const { regexIssue } = require('./regexGuard');

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const MATCH_TYPES = ['exact', 'contains', 'startswith', 'regex'];
const MAX_RESPONSE = 2000;
const MAX_TRIGGER = 200;
const MAX_PER_GUILD = 50;
const DEFAULT_COOLDOWN_MS = 10000;
// Regex triggers run against at most this much of the message — the same
// bounded-haystack defense the automod regex filters use (see regexGuard.js
// for the full story: static scan at add-time + cap at match-time).
const REGEX_INPUT_CAP = 500;

// ──────────────────── Validation ────────────────────

// A custom command must not collide with a real command name — the prefix
// dispatcher resolves built-ins first, so a shadowed name would look broken
// ("I set it up and it runs /help instead"). The registry is required lazily:
// commands/* requires this module back, and a top-level require here would be
// a cycle at load time.
function isReservedName(name) {
    try {
        const { commandRegistry } = require('./commands/registry');
        return Object.prototype.hasOwnProperty.call(commandRegistry, name);
    } catch (err) {
        logError(err, 'customCommands', 'reserved_name_lookup');
        return false;
    }
}

function validateName(raw) {
    const name = String(raw || '').trim().toLowerCase();
    if (!name) return { error: 'A command name is required.' };
    if (!NAME_RE.test(name)) return { error: 'Names can use letters, numbers, `-` and `_` (max 32 characters).' };
    if (isReservedName(name)) return { error: '`' + name + '` is already a built-in command. Pick another name.' };
    return { name };
}

function validateResponse(raw) {
    const response = String(raw || '').trim();
    if (!response) return { error: 'A response is required.' };
    if (response.length > MAX_RESPONSE) return { error: 'Responses are capped at ' + MAX_RESPONSE + ' characters.' };
    return { response };
}

function validateTrigger(matchType, raw) {
    const trigger = String(raw || '').trim();
    if (!trigger) return { error: 'A trigger is required.' };
    if (trigger.length > MAX_TRIGGER) return { error: 'Triggers are capped at ' + MAX_TRIGGER + ' characters.' };
    // The guard rejects invalid syntax AND catastrophic-backtracking shapes —
    // a regex autoresponder runs on every message in the server, so a
    // `(a+)+`-style trigger could freeze the whole bot on one crafted reply.
    if (matchType === 'regex') {
        const issue = regexIssue(trigger);
        if (issue) return { error: issue };
    }
    return { trigger };
}

// ──────────────────── Custom commands ────────────────────

function mapCustomCommand(r) {
    return {
        guildId: r.guild_id,
        name: r.name,
        response: r.response,
        asEmbed: !!r.as_embed,
        uses: r.uses || 0,
        createdBy: r.created_by || null,
        createdAt: r.created_at,
    };
}

// ──────────────────── Per-Guild Read Cache ────────────────────
// Both message-path lookups (`getCustomCommand` per prefixed message,
// `listAutoresponders` for every message at all) were a SQLite query each. The
// lists only change when a moderator edits them, so they are cached per guild
// and dropped by every write below; the TTL is a backstop for writes made
// outside this module. `uses` counters are deliberately not invalidated — the
// matching path never reads them, and a display-only count may lag by the TTL.
const CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 500;
const commandsCache = new Map();   // guildId -> { value, ts }
const respondersCache = new Map(); // guildId -> { value, ts }

function readThrough(map, key, load) {
    const hit = map.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.value;
    const value = load();
    if (map.size >= CACHE_MAX) map.delete(map.keys().next().value);
    map.set(key, { value, ts: Date.now() });
    return value;
}

// With no argument it clears everything — for tests that write SQL by hand.
function invalidateCustomCommandsCache(guildId) {
    if (guildId === undefined || guildId === null) {
        commandsCache.clear();
        respondersCache.clear();
        return;
    }
    commandsCache.delete(guildId);
    respondersCache.delete(guildId);
}

function listCustomCommands(guildId) {
    // Shared array of shared objects: read-only.
    return readThrough(commandsCache, guildId, () => getDb()
        .prepare('SELECT * FROM custom_commands WHERE guild_id = ? ORDER BY name ASC')
        .all(guildId).map(mapCustomCommand));
}

function getCustomCommand(guildId, name) {
    const wanted = String(name || '').toLowerCase();
    return listCustomCommands(guildId).find((c) => c.name === wanted) || null;
}

// Insert or replace. Returns { error } for anything the caller should show the
// user; validation lives here so the slash command, the dashboard route, and
// the importer all enforce the same rules.
function setCustomCommand(guildId, name, opts, createdBy) {
    const nameCheck = validateName(name);
    if (nameCheck.error) return { error: nameCheck.error };
    const responseCheck = validateResponse(opts && opts.response);
    if (responseCheck.error) return { error: responseCheck.error };

    const db = getDb();
    const existing = getCustomCommand(guildId, nameCheck.name);
    if (!existing) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM custom_commands WHERE guild_id = ?').get(guildId).n;
        if (count >= MAX_PER_GUILD) return { error: 'This server already has the maximum of ' + MAX_PER_GUILD + ' custom commands.' };
    }
    db.prepare(`INSERT INTO custom_commands (guild_id, name, response, as_embed, uses, created_by, created_at)
        VALUES (?, ?, ?, ?, 0, ?, ?)
        ON CONFLICT(guild_id, name) DO UPDATE SET response = excluded.response, as_embed = excluded.as_embed`)
        .run(guildId, nameCheck.name, responseCheck.response, opts && opts.asEmbed ? 1 : 0,
            existing ? existing.createdBy : (createdBy || null),
            existing ? existing.createdAt : Date.now());
    invalidateCustomCommandsCache(guildId);
    return { command: getCustomCommand(guildId, nameCheck.name), created: !existing };
}

function deleteCustomCommand(guildId, name) {
    const result = getDb().prepare('DELETE FROM custom_commands WHERE guild_id = ? AND name = ?')
        .run(guildId, String(name || '').toLowerCase());
    if (result.changes > 0) invalidateCustomCommandsCache(guildId);
    return result.changes > 0;
}

function bumpCustomCommandUses(guildId, name) {
    try {
        const info = getDb().prepare('UPDATE custom_commands SET uses = uses + 1 WHERE guild_id = ? AND name = ?').run(guildId, name);
        // Mirror the counter into the cached row instead of dropping the cache:
        // this runs on every matching message, so invalidating here would undo
        // the cache entirely. Guarded by changes so a stale cache can't drift.
        if (info.changes > 0) bumpCachedUses(commandsCache.get(guildId), (c) => c.name === name);
    } catch (err) {
        logError(err, 'customCommands', 'bump_uses');
    }
}

// Shared by both use counters: keep the cached row's `uses` in step with the
// database. The matching path never reads it, so a miss here is harmless.
function bumpCachedUses(hit, match) {
    const row = hit && hit.value ? hit.value.find(match) : null;
    if (row) row.uses += 1;
}

// ──────────────────── Autoresponders ────────────────────

function mapAutoresponder(r) {
    return {
        id: r.id,
        guildId: r.guild_id,
        trigger: r.trigger,
        matchType: r.match_type,
        response: r.response,
        channelId: r.channel_id || null,
        enabled: !!r.enabled,
        cooldownMs: r.cooldown_ms || DEFAULT_COOLDOWN_MS,
        uses: r.uses || 0,
        createdBy: r.created_by || null,
        createdAt: r.created_at,
    };
}

// (responderId + ':' + userId) -> timestamp of the last reply. An in-memory
// throttle, not state: losing it on restart only means one extra reply.
const lastResponded = new Map();
const MAX_THROTTLE_ENTRIES = 2000;

function resetAutoresponderThrottle() {
    lastResponded.clear();
}

// Oldest first, tie-broken by rowid: several responders created in the same
// millisecond must still have a stable order, because the first match wins.
function listAutoresponders(guildId) {
    // Shared array of shared objects: read-only.
    return readThrough(respondersCache, guildId, () => getDb()
        .prepare('SELECT * FROM autoresponders WHERE guild_id = ? ORDER BY created_at ASC, rowid ASC')
        .all(guildId).map(mapAutoresponder));
}

function getAutoresponder(guildId, id) {
    return listAutoresponders(guildId).find((r) => r.id === id) || null;
}

function addAutoresponder(guildId, opts, createdBy) {
    const matchType = MATCH_TYPES.includes(opts && opts.matchType) ? opts.matchType : 'contains';
    const triggerCheck = validateTrigger(matchType, opts && opts.trigger);
    if (triggerCheck.error) return { error: triggerCheck.error };
    const responseCheck = validateResponse(opts && opts.response);
    if (responseCheck.error) return { error: responseCheck.error };

    const db = getDb();
    const count = db.prepare('SELECT COUNT(*) AS n FROM autoresponders WHERE guild_id = ?').get(guildId).n;
    if (count >= MAX_PER_GUILD) return { error: 'This server already has the maximum of ' + MAX_PER_GUILD + ' autoresponders.' };

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const cooldownMs = Number.isFinite(Number(opts && opts.cooldownMs)) && Number(opts.cooldownMs) >= 0
        ? Number(opts.cooldownMs)
        : DEFAULT_COOLDOWN_MS;
    db.prepare(`INSERT INTO autoresponders (id, guild_id, trigger, match_type, response, channel_id, enabled, cooldown_ms, uses, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, 0, ?, ?)`)
        .run(id, guildId, triggerCheck.trigger, matchType, responseCheck.response,
            (opts && opts.channelId) || null, cooldownMs, createdBy || null, Date.now());
    invalidateCustomCommandsCache(guildId);
    return { responder: getAutoresponder(guildId, id) };
}

function updateAutoresponder(guildId, id, patch) {
    const current = getAutoresponder(guildId, id);
    if (!current) return { error: 'Autoresponder not found.' };
    const next = {
        trigger: patch && patch.trigger !== undefined ? patch.trigger : current.trigger,
        matchType: patch && patch.matchType !== undefined ? patch.matchType : current.matchType,
        response: patch && patch.response !== undefined ? patch.response : current.response,
        channelId: patch && patch.channelId !== undefined ? (patch.channelId || null) : current.channelId,
        enabled: patch && patch.enabled !== undefined ? !!patch.enabled : current.enabled,
        cooldownMs: patch && patch.cooldownMs !== undefined ? patch.cooldownMs : current.cooldownMs,
    };
    if (!MATCH_TYPES.includes(next.matchType)) return { error: 'Unknown match type.' };
    const triggerCheck = validateTrigger(next.matchType, next.trigger);
    if (triggerCheck.error) return { error: triggerCheck.error };
    const responseCheck = validateResponse(next.response);
    if (responseCheck.error) return { error: responseCheck.error };

    getDb().prepare(`UPDATE autoresponders SET trigger = ?, match_type = ?, response = ?, channel_id = ?, enabled = ?, cooldown_ms = ?
        WHERE guild_id = ? AND id = ?`)
        .run(triggerCheck.trigger, next.matchType, responseCheck.response, next.channelId,
            next.enabled ? 1 : 0, next.cooldownMs, guildId, id);
    invalidateCustomCommandsCache(guildId);
    return { responder: getAutoresponder(guildId, id) };
}

function deleteAutoresponder(guildId, id) {
    const db = getDb();
    const result = db.prepare('DELETE FROM autoresponders WHERE guild_id = ? AND id = ?').run(guildId, id);
    // Drop any throttle rows for the deleted rule so the map can't grow from
    // rules that no longer exist.
    for (const key of lastResponded.keys()) {
        if (key.startsWith(id + ':')) lastResponded.delete(key);
    }
    if (result.changes > 0) invalidateCustomCommandsCache(guildId);
    return result.changes > 0;
}

function bumpAutoresponderUses(guildId, id) {
    try {
        const info = getDb().prepare('UPDATE autoresponders SET uses = uses + 1 WHERE guild_id = ? AND id = ?').run(guildId, id);
        if (info.changes > 0) bumpCachedUses(respondersCache.get(guildId), (r) => r.id === id);
    } catch (err) {
        logError(err, 'customCommands', 'bump_uses');
    }
}

// ──────────────────── Matching ────────────────────

const regexCache = new Map();

function compileRegex(pattern) {
    if (regexCache.has(pattern)) return regexCache.get(pattern);
    let re = null;
    try { re = new RegExp(pattern, 'i'); } catch { re = null; }
    if (regexCache.size > 200) regexCache.clear();
    regexCache.set(pattern, re);
    return re;
}

// Exported for tests and the dashboard's "test this trigger" affordance.
function triggerMatches(responder, content) {
    const text = String(content || '');
    const trigger = responder.trigger.toLowerCase();
    switch (responder.matchType) {
        case 'exact':
            return text.trim().toLowerCase() === trigger;
        case 'startswith':
            return text.trim().toLowerCase().startsWith(trigger);
        case 'regex': {
            const re = compileRegex(responder.trigger);
            return re ? re.test(text.slice(0, REGEX_INPUT_CAP)) : false;
        }
        case 'contains':
        default:
            return text.toLowerCase().includes(trigger);
    }
}

// ──────────────────── Response expansion ────────────────────

function expandResponse(text, { member, channel, args } = {}) {
    // replacePlaceholders() covers the whole welcome/goodbye table ({user},
    // {username}, {server}, {membercount}, {date}…); it no-ops without a real
    // member, so the extra tokens below still apply.
    let out = replacePlaceholders(text, member, 'custom');
    if (channel) out = out.split('{channel}').join('<#' + channel.id + '>');
    if (channel) out = out.split('{channelname}').join(channel.name || '');
    out = out.split('{args}').join(args || '');
    return out;
}

// User mentions are allowed so {user} reads as a mention; @everyone/@here and
// role pings are not, and a reply never pings the author again.
function responsePayload(response, asEmbed) {
    const allowedMentions = { parse: ['users'], repliedUser: false };
    if (asEmbed) return { embeds: [makeEmbed({ description: truncate(response, 4096) })], allowedMentions };
    return { content: truncate(response, 2000), allowedMentions };
}

async function sendResponse(message, payload) {
    const target = message.channel;
    if (!target || typeof target.send !== 'function') return false;
    await target.send(payload);
    return true;
}

// ──────────────────── Message path ────────────────────

async function handleCustomCommand(message, prefix) {
    if (!message || !message.guild || typeof message.content !== 'string') return false;
    if (!prefix || !message.content.startsWith(prefix)) return false;

    const after = message.content.slice(prefix.length).trim();
    if (!after) return false;
    const name = after.split(/\s+/)[0].toLowerCase();
    const command = getCustomCommand(message.guild.id, name);
    if (!command) return false;

    const args = after.slice(name.length).trim();
    const response = expandResponse(command.response, { member: message.member, channel: message.channel, args });
    try {
        await sendResponse(message, responsePayload(response, command.asEmbed));
        bumpCustomCommandUses(message.guild.id, name);
    } catch (err) {
        logError(err, 'customCommands', 'custom_command:' + name);
    }
    // Recognized either way — a failed send must not fall through to the
    // autoresponder matcher and answer twice.
    return true;
}

async function handleAutoresponders(message) {
    if (!message || !message.guild || typeof message.content !== 'string') return false;
    if (!message.content.trim()) return false;
    if (message.author && message.author.bot) return false;

    let responders;
    try {
        responders = listAutoresponders(message.guild.id);
    } catch (err) {
        logError(err, 'customCommands', 'autoresponder_load');
        return false;
    }

    const now = Date.now();
    // Oldest rule wins, so a server can put a specific trigger above a broad one.
    for (const responder of responders) {
        if (!responder.enabled) continue;
        if (responder.channelId && responder.channelId !== message.channelId) continue;
        if (!triggerMatches(responder, message.content)) continue;

        const key = responder.id + ':' + (message.author ? message.author.id : 'unknown');
        if (now - (lastResponded.get(key) || 0) < responder.cooldownMs) return false;

        lastResponded.set(key, now);
        if (lastResponded.size > MAX_THROTTLE_ENTRIES) {
            for (const [k, ts] of lastResponded) {
                if (now - ts > 60 * 60 * 1000) lastResponded.delete(k);
            }
        }

        const response = expandResponse(responder.response, { member: message.member, channel: message.channel, args: message.content });
        try {
            await sendResponse(message, responsePayload(response, false));
            bumpAutoresponderUses(message.guild.id, responder.id);
        } catch (err) {
            logError(err, 'customCommands', 'autoresponder:' + responder.id);
        }
        // One response per message, always.
        return true;
    }
    return false;
}

module.exports = {
    NAME_RE,
    MATCH_TYPES,
    MAX_PER_GUILD,
    DEFAULT_COOLDOWN_MS,
    invalidateCustomCommandsCache,
    validateName,
    triggerMatches,
    expandResponse,
    listCustomCommands,
    getCustomCommand,
    setCustomCommand,
    deleteCustomCommand,
    listAutoresponders,
    getAutoresponder,
    addAutoresponder,
    updateAutoresponder,
    deleteAutoresponder,
    handleCustomCommand,
    handleAutoresponders,
    resetAutoresponderThrottle,
};

// ──────────────────── Live Server Stats Channels ────────────────────
// Voice/text channels whose names show a live value (members, humans, bots,
// online, boosts, channels, roles, emojis, boost tier). Values refresh:
//   • on member join / leave / boost changes (hooks in index.js), debounced
//     per guild so a raid collapses into a single refresh
//   • on a 10-minute timer (catches anything that drifted, incl. offline time)
// A channel is renamed only when its value actually changed, and never more
// often than every MIN_RENAME_INTERVAL_MS: Discord allows roughly two channel
// renames per ten minutes. Renaming on every event spent that budget within
// seconds of a join raid, after which every rename 429'd and the counter froze
// on a stale number. Skipped renames are not dropped — they are re-queued for
// when the budget refills. If a configured channel is deleted, its config row
// is dropped on the next refresh.

const { getDb } = require('./db');
const { logError } = require('./logError');

// ──────────────────── Stat Types ────────────────────
// compute(guild, members) receives the guild plus its member cache, so the
// helpers are pure-ish and unit-testable with mocks.
const STAT_TYPES = {
    members:    { emoji: '👥', label: 'Members',    needsMembers: false, compute: (g) => g.memberCount || 0 },
    humans:     { emoji: '🧑', label: 'Humans',     needsMembers: true,  compute: (g, m) => (m ? Array.from(m.cache.values()).filter(x => x && !x.user.bot).length : 0) },
    bots:       { emoji: '🤖', label: 'Bots',       needsMembers: true,  compute: (g, m) => (m ? Array.from(m.cache.values()).filter(x => x && x.user.bot).length : 0) },
    online:     { emoji: '🟢', label: 'Online',     needsMembers: true,  compute: (g, m) => (m ? Array.from(m.cache.values()).filter(x => x && x.presence && x.presence.status && x.presence.status !== 'offline').length : 0) },
    boosting:   { emoji: '🚀', label: 'Boosts',     needsMembers: false, compute: (g) => g.premiumSubscriptionCount || 0 },
    boost_tier: { emoji: '💎', label: 'Boost Tier', needsMembers: false, compute: (g) => g.premiumTier || 0 },
    channels:   { emoji: '📁', label: 'Channels',   needsMembers: false, compute: (g) => (g.channels && g.channels.cache ? g.channels.cache.size : 0) },
    roles:      { emoji: '🎭', label: 'Roles',      needsMembers: false, compute: (g) => (g.roles && g.roles.cache ? g.roles.cache.size : 0) },
    emojis:     { emoji: '😀', label: 'Emojis',     needsMembers: false, compute: (g) => (g.emojis && g.emojis.cache ? g.emojis.cache.size : 0) },
};

// Channel names cannot contain @ # : — use a bullet separator.
const NAME_SEPARATOR = ' • ';
const MAX_CHANNEL_NAME = 100;

function computeStat(guild, members, statType) {
    const type = STAT_TYPES[statType];
    if (!type || !guild) return 0;
    try { return type.compute(guild, members); } catch (err) {
        logError(err, 'serverstats', 'compute_' + statType);
        return 0;
    }
}

function formatStatName(statType, value, labelOverride) {
    const type = STAT_TYPES[statType];
    if (!type) return '';
    const label = (labelOverride && String(labelOverride).trim()) || type.label;
    let text;
    if (statType === 'boost_tier') {
        text = 'Tier ' + value;
    } else {
        try { text = Number(value || 0).toLocaleString('en-US'); } catch { text = String(value || 0); }
    }
    return (type.emoji + ' ' + label + NAME_SEPARATOR + text).slice(0, MAX_CHANNEL_NAME);
}

// ──────────────────── DB Access ────────────────────

function getServerStats(guildId) {
    try {
        return getDb().prepare('SELECT guild_id, channel_id, stat_type, label FROM server_stats WHERE guild_id = ?').all(guildId);
    } catch (err) {
        logError(err, 'serverstats', 'getServerStats');
        return [];
    }
}

function setServerStat(guildId, channelId, statType, label) {
    if (!STAT_TYPES[statType]) return { error: 'Unknown stat type: ' + statType + '. Valid: ' + Object.keys(STAT_TYPES).join(', ') };
    try {
        getDb().prepare(
            'INSERT OR REPLACE INTO server_stats (guild_id, channel_id, stat_type, label) VALUES (?, ?, ?, ?)'
        ).run(guildId, channelId, statType, (label && String(label).trim()) || null);
        return { success: true };
    } catch (err) {
        logError(err, 'serverstats', 'setServerStat');
        return { error: err.message || 'Failed to save stat config' };
    }
}

function removeServerStat(guildId, channelId) {
    try {
        getDb().prepare('DELETE FROM server_stats WHERE guild_id = ? AND channel_id = ?').run(guildId, channelId);
        return { success: true };
    } catch (err) {
        logError(err, 'serverstats', 'removeServerStat');
        return { error: err.message || 'Failed to remove stat config' };
    }
}

// ──────────────────── Rename Pacing ────────────────────

// One rename per channel per five minutes is exactly Discord's refill rate for
// channel edits (two per ten minutes), so it can be kept up indefinitely
// instead of draining the bucket and getting 429'd.
const MIN_RENAME_INTERVAL_MS = 5 * 60 * 1000;

// A join/leave burst collapses into one refresh. A single event still fires
// straight away (leading edge); a second event inside the window waits.
const REFRESH_DEBOUNCE_MS = 10 * 1000;

const pendingRefresh = new Map(); // guildId  -> timer for a queued run
const lastRefreshAt = new Map();  // guildId  -> ms of the last scheduled run
const lastRenameAt = new Map();   // channelId -> ms of the last rename we sent
const refreshChain = new Map();   // guildId  -> tail promise, serialises a guild

// ──────────────────── Refreshing ────────────────────

// Update every configured stat channel for one guild. Never throws — every
// failure is logged so one bad channel can't take down the whole refresh.
// Returns { renamed, deferred } (channel ids) so callers can tell the truth
// when Discord's rename budget forced an update to wait.
async function refreshGuildStats(guild) {
    const result = { renamed: [], deferred: [] };
    if (!guild || !guild.id) return result;
    const rows = getServerStats(guild.id);
    if (!rows.length) return result;

    // If any stat needs member presence data and the cache is incomplete,
    // bulk-fetch once. Wrapped so rate limits / partial caches can't break us.
    const needMembers = rows.some(r => STAT_TYPES[r.stat_type] && STAT_TYPES[r.stat_type].needsMembers);
    if (needMembers && guild.members && guild.memberCount && guild.members.cache.size < guild.memberCount) {
        try { await guild.members.fetch(); } catch { /* cache may stay partial — fine */ }
    }

    let retryAfter = null;
    for (const row of rows) {
        const type = STAT_TYPES[row.stat_type];
        if (!type) continue;
        const channel = guild.channels && guild.channels.cache ? guild.channels.cache.get(row.channel_id) : null;
        if (!channel) {
            // Channel was deleted — stop tracking it.
            removeServerStat(guild.id, row.channel_id);
            continue;
        }
        if (!channel.manageable || typeof channel.setName !== 'function') continue;
        const value = computeStat(guild, guild.members, row.stat_type);
        const name = formatStatName(row.stat_type, value, row.label);
        if (channel.name === name) continue; // only rename when changed

        const since = Date.now() - (lastRenameAt.get(row.channel_id) || 0);
        if (since < MIN_RENAME_INTERVAL_MS) {
            // The budget for this channel hasn't refilled. Don't drop the
            // update — remember it's stale and come back when a rename would
            // actually be accepted.
            result.deferred.push(row.channel_id);
            const wait = MIN_RENAME_INTERVAL_MS - since;
            retryAfter = retryAfter === null ? wait : Math.max(retryAfter, wait);
            continue;
        }
        try {
            await channel.setName(name, 'Server stats auto-update');
            lastRenameAt.set(row.channel_id, Date.now());
            result.renamed.push(row.channel_id);
        } catch (err) {
            logError(err, 'serverstats', 'rename_' + row.channel_id);
            // A rejected rename means the budget is spent: back off the whole
            // interval, otherwise a 429 turns into a retry storm.
            lastRenameAt.set(row.channel_id, Date.now());
            result.deferred.push(row.channel_id);
            retryAfter = retryAfter === null ? MIN_RENAME_INTERVAL_MS : Math.max(retryAfter, MIN_RENAME_INTERVAL_MS);
        }
    }

    if (retryAfter !== null) queueGuildRefresh(guild, retryAfter);
    return result;
}

// Run one refresh for a guild, serialised: two passes at once would compute the
// same new name and each send a rename for one visible change, spending two
// budget slots instead of one.
function runGuildStatsRefresh(guild) {
    if (!guild || !guild.id) return Promise.resolve(null);
    const id = guild.id;
    lastRefreshAt.set(id, Date.now());
    // `run` is what we store, and it never rejects (see the catch below), so a
    // failed pass can't poison the queue for the next one.
    const previous = refreshChain.get(id) || Promise.resolve();
    const run = previous
        .then(() => refreshGuildStats(guild))
        .catch((err) => {
            logError(err, 'serverstats', 'scheduled_' + id);
            return null;
        });
    refreshChain.set(id, run);
    run.then(() => {
        // Only clear if nothing queued behind us in the meantime.
        if (refreshChain.get(id) === run) refreshChain.delete(id);
    });
    return run;
}

// Queue a single refresh for `delayMs` from now, deduplicated per guild: an
// event arriving while a run is already queued just joins that one.
function queueGuildRefresh(guild, delayMs) {
    if (!guild || !guild.id || pendingRefresh.has(guild.id)) return;
    const id = guild.id;
    const timer = setTimeout(() => {
        pendingRefresh.delete(id);
        runGuildStatsRefresh(guild);
    }, Math.max(0, delayMs));
    if (typeof timer.unref === 'function') timer.unref();
    pendingRefresh.set(id, timer);
}

// Entry point for the join / leave / boost hooks. The first event after a quiet
// period refreshes immediately so single joins still look instant; every event
// inside the debounce window is coalesced into one trailing run.
function scheduleGuildStatsRefresh(guild) {
    if (!guild || !guild.id || pendingRefresh.has(guild.id)) return;
    const since = Date.now() - (lastRefreshAt.get(guild.id) || 0);
    if (since >= REFRESH_DEBOUNCE_MS) {
        runGuildStatsRefresh(guild);
        return;
    }
    queueGuildRefresh(guild, REFRESH_DEBOUNCE_MS - since);
}

// Refresh every guild the bot is in, one at a time (gentler on rate limits).
async function updateAllServerStats(client) {
    if (!client || !client.guilds || !client.guilds.cache) return;
    for (const guild of client.guilds.cache.values()) {
        try {
            await runGuildStatsRefresh(guild);
        } catch (err) {
            logError(err, 'serverstats', 'guild_' + guild.id);
        }
    }
}

// ──────────────────── Timer ────────────────────

let statTimer = null;

function startServerStats(client) {
    if (statTimer) return;
    // First sweep shortly after boot (guilds are usually ready by then).
    setTimeout(() => updateAllServerStats(client).catch((err) => logError(err, 'serverstats', 'updateAll')), 10 * 1000);
    // Keep counters fresh — the join/leave hooks handle most cases instantly.
    statTimer = setInterval(() => updateAllServerStats(client).catch((err) => logError(err, 'serverstats', 'updateAll')), 10 * 60 * 1000);
    statTimer.unref();
}

function stopServerStats() {
    if (statTimer) {
        clearInterval(statTimer);
        statTimer = null;
    }
    for (const timer of pendingRefresh.values()) clearTimeout(timer);
    pendingRefresh.clear();
}

// Shutdown/test helper: also forget the local rename history, so a fresh boot
// doesn't inherit a budget that no longer reflects reality.
function resetStatsScheduler() {
    stopServerStats();
    lastRenameAt.clear();
    lastRefreshAt.clear();
    refreshChain.clear();
}

module.exports = {
    STAT_TYPES,
    MIN_RENAME_INTERVAL_MS,
    REFRESH_DEBOUNCE_MS,
    computeStat,
    formatStatName,
    getServerStats,
    setServerStat,
    removeServerStat,
    refreshGuildStats,
    scheduleGuildStatsRefresh,
    updateAllServerStats,
    startServerStats,
    stopServerStats,
    resetStatsScheduler,
};

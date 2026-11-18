// ──────────────────── Bot activity log ────────────────────
// One table feeds every "what has the bot been doing" view: the dashboard
// activity feed (/api/activity), the event-by-event timeline
// (/api/activity/timeline) and the live SSE card. Until now the writer existed
// only as `global.logBotActivity` and nothing ever called it, so the table was
// permanently empty and those screens had nothing to show. Events are recorded
// here, at the place the event actually happens, instead of being inferred from
// all-time counters after the fact.
const { getDb } = require('./db');
const { logError } = require('./logError');

// Matches the retention the dashboard always described: enough history to be
// useful, bounded so the table cannot grow without limit.
const MAX_ROWS = 10000;

function logActivity(type, data = {}) {
    try {
        const db = getDb();
        const payload = { ...data };
        if (payload.guildId !== undefined && payload.guildId !== null) payload.guildId = String(payload.guildId);
        db.prepare('INSERT INTO bot_activity (type, data, timestamp) VALUES (?, ?, ?)')
            .run(String(type), JSON.stringify(payload), Date.now());
        db.prepare('DELETE FROM bot_activity WHERE id NOT IN (SELECT id FROM bot_activity ORDER BY timestamp DESC, id DESC LIMIT ?)')
            .run(MAX_ROWS);
        return true;
    } catch (err) {
        // Activity is a nicety; losing one event must never break the event
        // that produced it (a join, a leave, a punishment).
        logError(err, 'botActivity', 'log');
        return false;
    }
}

// Newest first, guild-filtered when a scope is supplied. Rows without a guild
// id are withheld from scoped callers (fail closed), matching the SSE stream.
function getActivity({ scopedGuildIds = null, limit = 50, since = 0 } = {}) {
    try {
        const db = getDb();
        const rows = db.prepare('SELECT id, type, data, timestamp FROM bot_activity WHERE timestamp > ? ORDER BY timestamp DESC, id DESC LIMIT 1000')
            .all(since);
        const events = [];
        for (const row of rows) {
            let data;
            try { data = JSON.parse(row.data || '{}'); } catch { continue; }
            if (!data || data.guildId === undefined || data.guildId === null) continue;
            const guildId = String(data.guildId);
            if (scopedGuildIds && !scopedGuildIds.has(guildId)) continue;
            events.push({
                id: row.id,
                type: row.type,
                guildId,
                guildName: data.guildName || guildId,
                userId: data.userId || null,
                userTag: data.userTag || null,
                time: row.timestamp,
            });
            if (events.length >= limit) break;
        }
        return events;
    } catch (err) {
        logError(err, 'botActivity', 'read');
        return [];
    }
}

module.exports = { logActivity, getActivity, MAX_ROWS };

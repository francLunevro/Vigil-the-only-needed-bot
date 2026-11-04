const { randomUUID } = require('node:crypto');
const { getDb } = require('./db');
const { MAX_ATTEMPTS, STALE_DISPATCH_MS, wasRejected, retryAt } = require('./scheduledExecution');
const { logError } = require('./logError');

let client = null;
let sweepInterval = null;

const UNKNOWN_BAN_CODE = 10026;

function setTempBanClient(discordClient) {
    client = discordClient;
}

// The member's pending temporary ban, or null. Read-only and guild-scoped —
// the member file (src/memberFile.js) shows a live temp ban as an active
// punishment without waiting for the sweeper to lift it.
function getActiveTempBan(guildId, userId) {
    const db = getDb();
    return db.prepare('SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ?').get(guildId, userId) || null;
}

async function applyTempBan(guild, userId, reason, durationLabel, durationMs, deleteMessageSeconds) {
    const db = getDb();
    const bannedAt = Date.now();
    const unbanAt = bannedAt + durationMs;
    const marker = randomUUID();
    db.prepare(`
        INSERT INTO temp_bans (guild_id, user_id, reason, banned_at, unban_at, ban_marker)
        VALUES (?, ?, ?, ?, ?, ?)
    `).run(guild.id, userId, reason, bannedAt, unbanAt, marker);
    try {
        const auditReason = '[Vigil temp ban ' + marker + '] ' + durationLabel + ': ' + reason;
        await guild.bans.create(userId, { reason: Array.from(auditReason).slice(0, 512).join(''), deleteMessageSeconds });
    } catch (err) {
        if (wasRejected(err)) {
            db.prepare('DELETE FROM temp_bans WHERE guild_id = ? AND user_id = ? AND ban_marker = ?')
                .run(guild.id, userId, marker);
        }
        // On a lost response retain the row. The expiry worker can verify the
        // actual ban marker instead of leaving an accepted temporary ban permanent.
        throw err;
    }
    return unbanAt;
}

let sweeping = false;

async function sweepExpiredTempBans() {
    if (!client || sweeping) return;
    sweeping = true;
    try {
        const db = getDb();
        const now = Date.now();
        const due = db.prepare(`
            SELECT * FROM temp_bans WHERE unban_at <= ? AND
            ((delivery_state = 'dispatching' AND dispatch_started_at <= ?) OR
             (delivery_state IN ('pending', 'retry') AND attempts < ? AND retry_at <= ?))
        `).all(now, now - STALE_DISPATCH_MS, MAX_ATTEMPTS, now);
        const remove = db.prepare(`
            DELETE FROM temp_bans WHERE guild_id = ? AND user_id = ? AND banned_at = ?
              AND unban_at = ? AND ban_marker IS ? AND delivery_state = ? AND dispatch_started_at IS ?
        `);
        const record = db.prepare(`
            UPDATE temp_bans SET delivery_state = ?, dispatch_started_at = NULL, attempts = ?, retry_at = ?
            WHERE guild_id = ? AND user_id = ? AND banned_at = ? AND unban_at = ?
              AND ban_marker IS ? AND delivery_state = ? AND dispatch_started_at IS ?
        `);
        const claim = db.prepare(`
            UPDATE temp_bans SET delivery_state = 'dispatching', dispatch_started_at = ?, attempts = attempts + 1
            WHERE guild_id = ? AND user_id = ? AND banned_at = ? AND unban_at = ?
              AND ban_marker IS ? AND delivery_state = ? AND dispatch_started_at IS ?
              AND attempts = ? AND retry_at <= ?
        `);

        for (const ban of due) {
            const guild = client.guilds.cache.get(ban.guild_id);
            if (!guild || guild.available === false) continue;
            const identity = [ban.guild_id, ban.user_id, ban.banned_at, ban.unban_at, ban.ban_marker];
            const original = [...identity, ban.delivery_state, ban.dispatch_started_at];
            let current;
            try {
                current = await guild.bans.fetch({ user: ban.user_id, force: true, cache: false });
            } catch (err) {
                if (err.code === UNKNOWN_BAN_CODE) {
                    remove.run(...original);
                } else {
                    const attempts = ban.attempts + 1;
                    const state = ban.delivery_state === 'dispatching' ? 'uncertain'
                        : attempts < MAX_ATTEMPTS ? 'retry' : 'failed';
                    record.run(state, attempts, retryAt(attempts), ...original);
                    logError(err, 'tempBans', 'lookup');
                }
                continue;
            }

            const currentReason = current?.reason || '';
            const matches = ban.ban_marker
                ? currentReason.startsWith('[Vigil temp ban ' + ban.ban_marker + '] ')
                : /^\[Temp Ban [^\]]+\] /.test(currentReason) && currentReason.replace(/^\[Temp Ban [^\]]+\] /, '') === ban.reason;
            if (!matches || ban.delivery_state === 'dispatching') {
                record.run('uncertain', ban.attempts, 0, ...original);
                logError(new Error('Temporary ban requires manual reconciliation'), 'tempBans', 'reconcile',
                    { guildId: ban.guild_id, userId: ban.user_id });
                continue;
            }

            const started = Date.now();
            if (!claim.run(started, ...original, ban.attempts, started).changes) continue;
            const dispatched = [...identity, 'dispatching', started];
            try {
                await guild.bans.remove(ban.user_id, 'Temp ban expired');
            } catch (err) {
                if (err.code === UNKNOWN_BAN_CODE) {
                    remove.run(...dispatched);
                } else if (wasRejected(err)) {
                    const attempts = ban.attempts + 1;
                    const state = attempts < MAX_ATTEMPTS ? 'retry' : 'failed';
                    record.run(state, attempts, retryAt(attempts), ...dispatched);
                }
                // A lost response leaves the dispatch claim in place so the
                // read-only reconciliation can check whether the ban is gone.
                logError(err, 'tempBans', 'autoUnban');
                continue;
            }
            remove.run(...dispatched);
        }
    } catch (err) {
        logError(err, 'tempBans', 'sweep');
    } finally {
        sweeping = false;
    }
}

function startTempBanSweeper() {
    if (sweepInterval) clearInterval(sweepInterval);
    void sweepExpiredTempBans();
    sweepInterval = setInterval(sweepExpiredTempBans, 30 * 1000);
}

function stopTempBanSweeper() {
    if (sweepInterval) clearInterval(sweepInterval);
    sweepInterval = null;
}

module.exports = { setTempBanClient, getActiveTempBan, applyTempBan, sweepExpiredTempBans, startTempBanSweeper, stopTempBanSweeper };

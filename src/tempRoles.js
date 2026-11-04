// ──────────────────── Temporary Roles ────────────────────
// Grant a role for a fixed window — "muted for 24h", "trial mod for 7 days" —
// and have it stripped automatically when the window closes.
//
// Unlike temp bans, nothing in Discord expires a role for us: the role stays
// until something removes it. So the sweep is the feature, and it has to
// survive three awkward cases:
//
//   • the bot was offline when the role expired  → sweep on boot, not just on
//     the interval (rows live in SQLite, so a restart loses nothing),
//   • the member left and rejoined (roles are dropped on leave) → the join
//     handler re-applies anything still in date,
//   • removing the role fails permanently (role deleted, bot demoted, member
//     gone) → stop retrying instead of looping every 30s forever, and say so
//     in the error log, because a role that outlives its window is silent.
//
// One row per (guild, user, role): re-granting extends the existing row rather
// than stacking duplicates that would each need stripping later.

const { PermissionFlagsBits } = require('discord.js');
const { getDb } = require('./db');
const { logError } = require('./logError');
const { checkHierarchy } = require('./modGuard');

let client = null;
let sweepInterval = null;

const SWEEP_INTERVAL_MS = 30 * 1000;
// Give up after this many failed removals so a permanently-stuck row can't
// retry forever. Five sweeps is two and a half minutes of trying.
const MAX_ATTEMPTS = 5;
const MIN_DURATION_MS = 60 * 1000;
const MAX_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

// Discord error codes that mean "this can never succeed" — retrying is noise.
const TERMINAL_CODES = new Set([
    10007, // Unknown Member
    10011, // Unknown Role
    10013, // Unknown User
    50013, // Missing Permissions
    50035, // Invalid Form Body
]);

function setTempRoleClient(discordClient) {
    client = discordClient;
}

function mapRow(r) {
    return {
        id: r.id,
        guildId: r.guild_id,
        userId: r.user_id,
        roleId: r.role_id,
        grantedBy: r.granted_by || null,
        grantedAt: r.granted_at,
        expiresAt: r.expires_at,
        attempts: r.attempts || 0,
    };
}

// ──────────────────── Storage ────────────────────

function listTempRoles(guildId) {
    return getDb().prepare('SELECT * FROM temp_roles WHERE guild_id = ? ORDER BY expires_at ASC')
        .all(guildId).map(mapRow);
}

function listTempRolesForUser(guildId, userId) {
    return getDb().prepare('SELECT * FROM temp_roles WHERE guild_id = ? AND user_id = ? ORDER BY expires_at ASC')
        .all(guildId, userId).map(mapRow);
}

function getTempRole(guildId, userId, roleId) {
    const row = getDb().prepare('SELECT * FROM temp_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?')
        .get(guildId, userId, roleId);
    return row ? mapRow(row) : null;
}

function deleteTempRoleRow(id) {
    getDb().prepare('DELETE FROM temp_roles WHERE id = ?').run(id);
}

function deleteTempRole(guildId, userId, roleId) {
    return getDb().prepare('DELETE FROM temp_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?')
        .run(guildId, userId, roleId).changes > 0;
}

// Duration rules live in one place so the grant path can refuse a bad window
// BEFORE it touches Discord. The dashboard used to add the role first and roll
// it back when the duration failed validation — a pointless role update that
// could leave the role stuck (and untracked) if the rollback itself failed.
function validateDuration(durationMs) {
    const ms = Number(durationMs);
    if (!Number.isFinite(ms) || ms < MIN_DURATION_MS) return { error: 'The duration must be at least 1 minute.' };
    if (ms > MAX_DURATION_MS) return { error: 'The duration is capped at 365 days.' };
    return { ms };
}

function addTempRole({ guildId, userId, roleId, durationMs, grantedBy }) {
    if (!guildId || !userId || !roleId) return { error: 'A member and a role are required.' };
    const duration = validateDuration(durationMs);
    if (duration.error) return { error: duration.error };
    const ms = duration.ms;

    const db = getDb();
    const now = Date.now();
    const existing = getTempRole(guildId, userId, roleId);
    if (existing) {
        // "Granted again" means another full window from now, not from the old
        // expiry — a mod re-applying a mute wants the clock restarted.
        db.prepare('UPDATE temp_roles SET expires_at = ?, attempts = 0, granted_by = ? WHERE id = ?')
            .run(now + ms, grantedBy || existing.grantedBy, existing.id);
        return { entry: getTempRole(guildId, userId, roleId), extended: true };
    }

    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    db.prepare(`INSERT INTO temp_roles (id, guild_id, user_id, role_id, granted_by, granted_at, expires_at, attempts)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)`)
        .run(id, guildId, userId, roleId, grantedBy || null, now, now + ms);
    return { entry: getTempRole(guildId, userId, roleId), extended: false };
}

// ──────────────────── Role helpers ────────────────────

// Can this role actually be handed out? Called before adding so the user gets a
// real reason instead of a Discord "Missing Permissions" later. `actorId` is
// the invoker when there is one: a `/perm` grant must not become a way to hand
// out roles that outrank the person granting them.
function checkAssignable(guild, role, actorId) {
    if (!role) return { error: 'That role no longer exists.' };
    if (role.id === guild.roles.everyone.id) return { error: "You can't schedule the @everyone role." };
    if (role.managed) return { error: 'That role is managed by an integration and cannot be assigned.' };
    const me = guild.members.me;
    if (!me) return { error: 'The bot is not cached in this server yet — try again in a moment.' };
    if (me.permissions && !me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        return { error: 'I need the **Manage Roles** permission to do that.' };
    }
    if (me.roles && me.roles.highest && role.comparePositionTo && role.comparePositionTo(me.roles.highest) >= 0) {
        return { error: 'That role sits above my highest role, so I cannot assign it.' };
    }
    if (actorId) {
        const blocked = checkHierarchy({ guild, actorId, role });
        if (blocked) return { error: blocked };
    }
    return {};
}

async function findMember(guild, userId) {
    if (guild.members.cache.has(userId)) return guild.members.cache.get(userId);
    return guild.members.fetch(userId).catch(() => null);
}

// ──────────────────── Grant / revoke ────────────────────

// Adds the role and records the expiry. Returns { error } when either step
// can't happen, so command and dashboard share one implementation.
async function grantTempRole({ guild, role, userId, durationMs, grantedBy, actorId }) {
    // Validate the window before anything reaches Discord, so a bad duration
    // never adds a role that then has to be rolled back.
    const duration = validateDuration(durationMs);
    if (duration.error) return { error: duration.error };

    const check = checkAssignable(guild, role, actorId);
    if (check.error) return { error: check.error };

    const member = await findMember(guild, userId);
    if (!member) return { error: 'That member is not in this server.' };
    if (actorId) {
        const blocked = checkHierarchy({ guild, actorId, target: member });
        if (blocked) return { error: blocked };
    }

    try {
        await member.roles.add(role.id, 'Temporary role granted' + (grantedBy ? ' by ' + grantedBy : ''));
    } catch (err) {
        logError(err, 'tempRoles', 'grant');
        return { error: 'Discord refused the role: ' + (err.message || err) };
    }

    const result = addTempRole({ guildId: guild.id, userId, roleId: role.id, durationMs: duration.ms, grantedBy });
    if (result.error) {
        // The role is already on the member but we couldn't record it — undo,
        // otherwise it would be permanent and untracked.
        await member.roles.remove(role.id, 'Temporary role could not be recorded').catch((err) => logError(err, 'tempRoles', 'grant_rollback'));
        return { error: result.error };
    }
    return result;
}

async function revokeTempRole({ guild, userId, roleId, reason, actorId }) {
    const row = getTempRole(guild.id, userId, roleId);
    if (!row) return { error: 'No temporary role is pending for that member and role.' };

    const member = await findMember(guild, userId);
    if (actorId) {
        const role = guild.roles && guild.roles.cache ? guild.roles.cache.get(roleId) : null;
        const blocked = checkHierarchy({ guild, actorId, target: member, role });
        if (blocked) return { error: blocked };
    }
    if (member) {
        try {
            await member.roles.remove(roleId, reason || 'Temporary role revoked');
        } catch (err) {
            // Keep the row: the sweeper retries, and the expiry is still real.
            logError(err, 'tempRoles', 'revoke');
            return { error: 'Could not remove the role: ' + (err.message || err) };
        }
    }
    deleteTempRoleRow(row.id);
    return { entry: row };
}

// ──────────────────── Sweeper ────────────────────

async function sweepExpiredTempRoles() {
    if (!client) return 0;
    const db = getDb();
    const now = Date.now();
    const due = db.prepare('SELECT * FROM temp_roles WHERE expires_at <= ?').all(now);
    let stripped = 0;

    for (const raw of due) {
        const row = mapRow(raw);
        const guild = client.guilds.cache.get(row.guildId);
        if (!guild) {
            // Bot removed from the server — nothing left to strip.
            deleteTempRoleRow(row.id);
            continue;
        }

        const member = await findMember(guild, row.userId);
        if (!member) {
            // They're gone. Drop the row: if they rejoin while still in date,
            // restoreTempRolesForMember() re-applies it from a matching row, and
            // once expired there is nothing to restore.
            deleteTempRoleRow(row.id);
            continue;
        }

        try {
            await member.roles.remove(row.roleId, 'Temporary role expired');
            deleteTempRoleRow(row.id);
            stripped++;
            console.log('[TempRole] Stripped role', row.roleId, 'from', row.userId, 'in', row.guildId);
        } catch (err) {
            if (TERMINAL_CODES.has(err && err.code)) {
                // The role or the member is gone, or we lost the permission.
                // Retrying can't help, and the row is what makes the expiry
                // visible, so log loudly and drop it.
                console.error('[TempRole] Could not strip role', row.roleId, 'from', row.userId, '- giving up (' + (err.message || err) + ')');
                logError(err, 'tempRoles', 'expire_terminal');
                deleteTempRoleRow(row.id);
                continue;
            }
            const attempts = row.attempts + 1;
            if (attempts >= MAX_ATTEMPTS) {
                console.error('[TempRole] Giving up on role', row.roleId, 'for', row.userId, 'after', attempts, 'attempts');
                logError(err, 'tempRoles', 'expire_giveup');
                deleteTempRoleRow(row.id);
            } else {
                db.prepare('UPDATE temp_roles SET attempts = ? WHERE id = ?').run(attempts, row.id);
                logError(err, 'tempRoles', 'expire_retry');
            }
        }
    }
    return stripped;
}

// A member's roles are dropped when they leave, so anything still in date is
// re-applied on rejoin. Expired rows are cleaned up here instead of waiting for
// the next sweep.
async function restoreTempRolesForMember(member) {
    if (!member || !member.guild || !member.user || member.user.bot) return 0;
    let restored = 0;
    const now = Date.now();

    for (const row of listTempRolesForUser(member.guild.id, member.user.id)) {
        if (row.expiresAt <= now) {
            deleteTempRoleRow(row.id);
            continue;
        }
        const role = member.guild.roles.cache.get(row.roleId);
        if (!role) {
            deleteTempRoleRow(row.id);
            continue;
        }
        try {
            await member.roles.add(row.roleId, 'Temporary role restored after rejoin');
            restored++;
        } catch (err) {
            logError(err, 'tempRoles', 'restore');
        }
    }
    return restored;
}

function startTempRoleSweeper() {
    if (sweepInterval) clearInterval(sweepInterval);
    // Boot sweep first: roles that expired while the bot was offline must not
    // wait for the interval.
    sweepExpiredTempRoles().catch((err) => logError(err, 'tempRoles', 'sweep_boot'));
    sweepInterval = setInterval(() => {
        sweepExpiredTempRoles().catch((err) => logError(err, 'tempRoles', 'sweep'));
    }, SWEEP_INTERVAL_MS);
    // The interval must not be the reason the process stays alive.
    if (sweepInterval.unref) sweepInterval.unref();
}

function stopTempRoleSweeper() {
    if (sweepInterval) clearInterval(sweepInterval);
    sweepInterval = null;
}

module.exports = {
    MIN_DURATION_MS,
    MAX_DURATION_MS,
    MAX_ATTEMPTS,
    validateDuration,
    setTempRoleClient,
    checkAssignable,
    addTempRole,
    getTempRole,
    listTempRoles,
    listTempRolesForUser,
    deleteTempRole,
    grantTempRole,
    revokeTempRole,
    sweepExpiredTempRoles,
    restoreTempRolesForMember,
    startTempRoleSweeper,
    stopTempRoleSweeper,
};

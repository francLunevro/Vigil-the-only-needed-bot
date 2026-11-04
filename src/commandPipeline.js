// ──────────────────── Command Pipeline ────────────────────
// The single execution path for BOTH command surfaces:
//   • slash interactions arrive straight from Discord (index.js)
//   • prefix messages arrive wrapped in an interaction shim
//     (src/prefixAdapter.js), parsed against the same deploy.js schema
// Pipeline: cooldown check → owner guard → handler → cooldown charge + usage
// tracking → friendly errors. Fixing behavior here fixes it everywhere; the two
// surfaces cannot drift apart.

const { commandRegistry, publicCommands } = require('./commands/registry');
const { ownerGuard } = require('./commands/_guard');
const { logError } = require('./logError');

// ──────────────────── Cooldown System (Persistent) ────────────────────

const DEFAULT_COOLDOWN = 3; // seconds
const COOLDOWN_OVERRIDES = {
    ping: 2,
    help: 2,
    status: 5,
    shutdown: 0,
    deploy: 30,
    purge: 5,
    say: 3,
    embed: 3,
    announce: 5,
    poll: 5,
    botname: 10,
    botavatar: 10,
    presence: 5,
};

// In-memory cache for hot cooldowns (falls back to DB)
const cooldownCache = new Map();

// The window for a command: an override of 0 means "no cooldown" (shutdown),
// not "fall back to the default". Nullish coalescing matters here — a logical
// OR would turn the explicit 0 into 3s and rate-limit /shutdown anyway.
function cooldownWindowMs(commandName) {
    const override = COOLDOWN_OVERRIDES[commandName];
    return (override === undefined ? DEFAULT_COOLDOWN : override) * 1000;
}

// Reading and charging are separate on purpose. The check runs before the
// handler so a spammed command is refused early; the charge runs after the
// handler has actually run, so a command that throws — a Discord blip, an
// unhandled edge case — doesn't leave the user locked out of retrying it.
//
// Because the check has no side effects, it also has to be paired with a
// reservation: two invocations racing on it (two prefix messages sent back to
// back) would both pass and both run. beginAttempt books the slot, and it is
// given back either when the window is charged or when the command fails.
const attemptsInFlight = new Map(); // cacheKey -> ms the reservation expires
const IN_FLIGHT_MAX = 500;

// true when the user may run the command now, otherwise { remaining } seconds.
// Read-only: nothing here starts a window (that is chargeCooldown).
async function cooldownRemaining(commandName, userId, guildId) {
    const cooldownTime = cooldownWindowMs(commandName);
    if (cooldownTime <= 0) return true; // no cooldown

    const cacheKey = `${guildId}:${commandName}:${userId}`;
    const now = Date.now();

    // Check in-memory cache first
    const cached = cooldownCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
        return { remaining: ((cached.expiresAt - now) / 1000).toFixed(1) };
    }

    const { getDb } = require('./db');
    const row = getDb()
        .prepare('SELECT expires_at FROM command_cooldowns WHERE guild_id = ? AND command = ? AND user_id = ?')
        .get(guildId, commandName, userId);

    if (row && now < row.expires_at) {
        cooldownCache.set(cacheKey, { expiresAt: row.expires_at });
        return { remaining: ((row.expires_at - now) / 1000).toFixed(1) };
    }
    return true;
}

// Book the attempt: null when the caller may run the command (and now holds the
// slot), otherwise { remaining } when they have to wait.
async function beginAttempt(commandName, userId, guildId) {
    const wait = await cooldownRemaining(commandName, userId, guildId);
    if (wait !== true) return wait;

    const cooldownTime = cooldownWindowMs(commandName);
    if (cooldownTime <= 0) return null; // no cooldown, nothing to book

    const cacheKey = `${guildId}:${commandName}:${userId}`;
    const now = Date.now();

    const heldUntil = attemptsInFlight.get(cacheKey);
    if (heldUntil && now < heldUntil) {
        return { remaining: ((heldUntil - now) / 1000).toFixed(1) };
    }

    if (attemptsInFlight.size >= IN_FLIGHT_MAX) {
        for (const [key, expiresAt] of attemptsInFlight.entries()) {
            if (expiresAt <= now) attemptsInFlight.delete(key);
        }
    }
    attemptsInFlight.set(cacheKey, now + cooldownTime);
    return null;
}

// Hand the slot back without starting a window — the command failed, so the
// failure shouldn't cost the user anything.
function releaseAttempt(commandName, userId, guildId) {
    attemptsInFlight.delete(`${guildId}:${commandName}:${userId}`);
}

// Start (or restart) the window for this user. No-op for zero-cooldown
// commands, so callers never have to special-case them.
async function chargeCooldown(commandName, userId, guildId) {
    const cooldownTime = cooldownWindowMs(commandName);
    if (cooldownTime <= 0) return;

    const cacheKey = `${guildId}:${commandName}:${userId}`;
    const now = Date.now();
    const expiresAt = now + cooldownTime;

    const { getDb } = require('./db');
    getDb().prepare('INSERT OR REPLACE INTO command_cooldowns (guild_id, command, user_id, expires_at) VALUES (?, ?, ?, ?)')
        .run(guildId, commandName, userId, expiresAt);
    cooldownCache.set(cacheKey, { expiresAt });
    // The window covers this key now, so the reservation is redundant. Done
    // after the write: if the write throws, the slot stays held.
    attemptsInFlight.delete(cacheKey);

    // Periodic cleanup of expired cache entries
    if (cooldownCache.size > 500) {
        for (const [key, val] of cooldownCache.entries()) {
            if (val.expiresAt <= now) cooldownCache.delete(key);
        }
    }
}

// A refused attempt is still an attempt: charge it, so someone without the
// permission can't spam the refusal reply. A handler that *throws* is not —
// that is the case this split exists for.
async function chargeAfterRefusal(commandName, interaction) {
    try {
        await chargeCooldown(commandName, interaction.user.id, interaction.guild.id);
    } catch (err) {
        logError(err, 'commands', 'cooldown_charge_refusal');
    }
}

// ──────────────────── Friendly Error Messages ────────────────────

function getFriendlyError(err, commandName) {
    const msg = err.message || String(err);

    // Discord API errors
    if (msg.includes('Missing Access')) return '❌ The bot doesn\'t have access to that resource. Check permissions.';
    if (msg.includes('Missing Permissions')) return '❌ The bot doesn\'t have the required permission to do that.';
    if (msg.includes('rate limited') || msg.includes('rate limit')) return '❌ Too many requests. Please slow down.';
    if (msg.includes('Unknown User') || msg.includes('Unknown Member')) return '❌ That user was not found. They may have left the server.';
    if (msg.includes('Unknown Channel')) return '❌ That channel no longer exists.';
    if (msg.includes('Unknown Role')) return '❌ That role no longer exists.';
    if (msg.includes('Unknown Guild') || msg.includes('Unknown Server')) return '❌ That server was not found.';
    if (msg.includes('Cannot edit a message')) return '❌ Could not edit that message. It may have been deleted.';
    if (msg.includes('Target user is not a member')) return '❌ That user is not in this server.';
    if (msg.includes('Prune') || msg.includes('prune')) return '❌ Could not prune members. Check the bot\'s role position.';
    if (msg.includes('TIMEOUT') || msg.includes('timeout')) return '❌ The request timed out. Please try again.';
    if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED')) return '❌ Could not reach Discord. The bot may be reconnecting.';

    // Generic fallback — include the actual error for debugging
    console.error('[Unhandled] ' + commandName + ':', msg);
    return '❌ An error occurred while running `' + commandName + '`. The issue has been logged.';
}

// ──────────────────── Shared Dispatch ────────────────────
// Runs one command through cooldown → guard → handler → tracking → errors.
// `invoke` lets callers bypass the registry (used by the four bespoke
// prefix handlers); without it the registry is the source of handlers.
// Returns true if the command was recognized (even when blocked by
// cooldown/permission), false when unknown.

async function runCommand(interaction, invoke) {
    const commandName = interaction.commandName;

    let handler = invoke;
    if (!handler) handler = commandRegistry[commandName];
    if (!handler) return false;

    // Cooldown check plus reservation. The window itself is charged once the
    // command has actually run, so a failure doesn't lock the user out of
    // retrying — but the slot is held meanwhile, so a second invocation can't
    // start on top of this one.
    const cooldownResult = await beginAttempt(commandName, interaction.user.id, interaction.guild.id);
    if (cooldownResult !== null) {
        await interaction.reply({
            content: '⏳ Please wait **' + cooldownResult.remaining + 's** before using `' + commandName + '` again.',
            ephemeral: true,
        });
        return true;
    }

    // Owner guard for non-public commands
    if (!publicCommands.includes(commandName) && !ownerGuard(interaction)) {
        await chargeAfterRefusal(commandName, interaction);
        return true;
    }

    try {
        await handler(interaction);
        // The command ran: start the cooldown window. Wrapped so a cooldown
        // write can never turn a successful command into an error reply.
        try {
            await chargeCooldown(commandName, interaction.user.id, interaction.guild.id);
        } catch (err) {
            logError(err, 'commands', 'cooldown_charge');
        }
        // Track command usage (fire-and-forget)
        try {
            const { getDb } = require('./db');
            const db = getDb();
            db.prepare('INSERT INTO command_usage (guild_id, command, user_id, used_at) VALUES (?, ?, ?, ?)')
                .run(interaction.guild.id, commandName, interaction.user.id, Date.now());
        } catch {}
    } catch (err) {
        // Give the slot back: the command failed, so no window is charged and
        // the user can retry immediately.
        releaseAttempt(commandName, interaction.user.id, interaction.guild.id);
        console.error('[Command Error] ' + commandName + ':', err);
        const errorMsg = getFriendlyError(err, commandName);
        const reply = interaction.deferred || interaction.replied
            ? interaction.editReply.bind(interaction)
            : interaction.reply.bind(interaction);
        reply({ content: errorMsg, ephemeral: true }).catch(e => logError(e, 'commands', 'reply_fallback'));
    }
    return true;
}

module.exports = {
    runCommand,
    cooldownRemaining,
    beginAttempt,
    releaseAttempt,
    chargeCooldown,
    getFriendlyError,
};

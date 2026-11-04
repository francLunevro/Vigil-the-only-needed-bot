// ──────────────────── Moderation DM receipts ────────────────────
// One place that tells a member what happened to them and how to appeal.
//
// Every punishment path calls sendPunishmentDm(): /warn, /timeout and their
// dashboard twins, the kick/ban/temp-ban confirm buttons, and the automatic
// warning-threshold punishments. Each caller has already performed the action
// and written the case — this module only notifies, so it is built to fail
// quietly:
//
//   • sendPunishmentDm() never throws. A closed DM, a blocked bot or a
//     Discord outage cannot turn a successful punishment into a failed
//     command, and cannot roll anything back.
//   • A refusal is an expected condition, not an incident. Discord's own
//     "Cannot send messages to this user" (50007) is recorded with logWarn —
//     visible in the dashboard error log, but not fired at the error-alert
//     channel. Anything genuinely unexpected goes through logError.
//
// The receipt is deliberately not the staff log embed: modActionLogEmbed()
// names the moderator, and the recipient of a punishment shouldn't be handed
// their name. The fields here are the ones the member is owed — action, reason,
// case number, duration, appeal route — and the moderator stays visible to
// staff exactly where they are today, in the log channel embed.

const { EmbedBuilder } = require('discord.js');
const { getGuildConfig, updateGuildConfig } = require('./config');
const { logError, logWarn } = require('./logError');
const { sanitizeForDM, truncate } = require('./helpers');

// Shades match the existing staff log embeds so staff and member see the same
// action described the same way (red = removal, amber = warning).
const ACTIONS = {
    warn: { color: 0xF1C40F, title: '⚠️ Warning received', sentence: 'A moderator warned you in' },
    timeout: { color: 0xE74C3C, title: '⏱️ You were timed out', sentence: 'You were timed out in' },
    kick: { color: 0xE74C3C, title: '👢 You were kicked', sentence: 'You were removed from' },
    ban: { color: 0xE74C3C, title: '🔨 You were banned', sentence: 'You were banned from' },
    tempban: { color: 0xE74C3C, title: '🔨 You were temporarily banned', sentence: 'You were temporarily banned from' },
};

const DEFAULT_APPEAL_TEXT =
    'If you believe this was a mistake, you can appeal — reply to this message or contact the server staff.';

const DEFAULT_CONFIG = { enabled: true, appealInfo: null };
const APPEAL_MAX_LENGTH = 500;
const REASON_MAX_LENGTH = 1000;

// ──────────────────── Config ────────────────────

// Normalizes whatever is in guild_config.mod_dm_config. Receipts default to ON:
// the feature exists to tell people why they were punished, so a guild that has
// never opened the setting still gets it.
function normalizeModDmConfig(raw) {
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const appealInfo = typeof cfg.appealInfo === 'string' ? cfg.appealInfo.trim() : '';
    return {
        enabled: cfg.enabled === undefined ? DEFAULT_CONFIG.enabled : cfg.enabled !== false,
        appealInfo: appealInfo ? appealInfo.slice(0, APPEAL_MAX_LENGTH) : null,
    };
}

function getModDmConfig(guildId) {
    if (!guildId) return { ...DEFAULT_CONFIG };
    try {
        return normalizeModDmConfig(getGuildConfig(guildId).modDmConfig);
    } catch (err) {
        // A config read must never break a punishment — fall back to the
        // default (on) and record why.
        logError(err, 'modDm', 'config_read:' + guildId);
        return { ...DEFAULT_CONFIG };
    }
}

function setModDmConfig(guildId, updates = {}) {
    const merged = normalizeModDmConfig({ ...getModDmConfig(guildId), ...updates });
    updateGuildConfig(guildId, (cfg) => {
        cfg.modDmConfig = merged;
        return cfg;
    });
    return merged;
}

// ──────────────────── Embed ────────────────────

function buildPunishmentDm(opts) {
    const {
        guild, action, reason, caseNumber = null,
        durationLabel = null, expiresAt = null, appealInfo = null,
    } = opts;
    const meta = ACTIONS[action] || ACTIONS.warn;
    const guildName = (guild && guild.name) || 'the server';

    const embed = new EmbedBuilder()
        .setColor(meta.color)
        .setTitle(meta.title)
        .setDescription(meta.sentence + ' **' + guildName + '**. This is the record of that action.')
        .addFields({
            name: 'Reason',
            value: truncate(sanitizeForDM(reason, REASON_MAX_LENGTH) || 'No reason provided', REASON_MAX_LENGTH),
        });

    // The case number is how staff and the member talk about the same incident.
    // It is absent only if the case row itself failed to write.
    embed.addFields({ name: 'Case', value: caseNumber ? '#' + caseNumber : 'Not recorded' });

    if (durationLabel) {
        const ends = expiresAt
            ? ' — ends <t:' + Math.floor(expiresAt / 1000) + ':R>'
            : '';
        embed.addFields({ name: 'Duration', value: String(durationLabel) + ends });
    }

    embed.addFields({
        name: 'Appeal',
        value: truncate(sanitizeForDM(appealInfo || DEFAULT_APPEAL_TEXT, APPEAL_MAX_LENGTH), APPEAL_MAX_LENGTH),
    });

    embed.setFooter({ text: guildName + (caseNumber ? ' · Case #' + caseNumber : '') });
    embed.setTimestamp();
    return embed;
}

// ──────────────────── Send ────────────────────

// Discord's "Cannot send messages to this user" — DMs closed, or the bot no
// longer shares a server with them (common right after a kick or a ban).
function isDmBlocked(err) {
    if (!err) return false;
    if (err.code === 50007) return true;
    return /cannot send messages to this user|cannot send messages to this user|dm blocked/i.test(String(err.message || ''));
}

// Callers pass whichever user object they already have. When they only have an
// id (the dashboard routes, the ban path), the helper resolves it once.
async function resolveTargetUser(guild, user, userId) {
    if (user && typeof user.send === 'function') return user;
    const id = userId || (user && user.id);
    const users = guild && guild.client && guild.client.users;
    if (!id || !users || typeof users.fetch !== 'function') return null;
    return users.fetch(id).catch(() => null);
}

// Returns { delivered, reason } and never throws:
//   delivered:true             — the DM left the bot
//   reason 'blocked'           — closed DMs / no mutual server (recorded, warn)
//   reason 'disabled'          — the guild switched receipts off
//   reason 'no-user'           — nothing sendable to (recorded)
//   reason 'no-guild'          — called without a guild
//   reason 'error'             — anything else (recorded, error)
async function sendPunishmentDm(opts = {}) {
    const { guild, user = null, userId = null, action = 'warn' } = opts;

    try {
        if (!guild || !guild.id) return { delivered: false, reason: 'no-guild' };

        const config = getModDmConfig(guild.id);
        if (!config.enabled) return { delivered: false, reason: 'disabled' };

        const target = await resolveTargetUser(guild, user, userId);
        if (!target || typeof target.send !== 'function') {
            logWarn('no sendable user for a moderation receipt', 'modDm', 'action=' + action + ' guild=' + guild.id);
            return { delivered: false, reason: 'no-user' };
        }

        const embed = buildPunishmentDm({
            guild,
            action,
            reason: opts.reason,
            caseNumber: opts.caseNumber || null,
            durationLabel: opts.durationLabel || null,
            expiresAt: opts.expiresAt || null,
            appealInfo: config.appealInfo,
        });

        try {
            await target.send({ embeds: [embed] });
            return { delivered: true, reason: null };
        } catch (err) {
            if (isDmBlocked(err)) {
                logWarn('moderation receipt not delivered (DMs closed or no shared server)', 'modDm',
                    'action=' + action + ' user=' + (target.id || 'unknown'));
                return { delivered: false, reason: 'blocked' };
            }
            logError(err, 'modDm', action + ':' + (target.id || 'unknown'));
            return { delivered: false, reason: 'error' };
        }
    } catch (err) {
        logError(err, 'modDm', 'unexpected');
        return { delivered: false, reason: 'error' };
    }
}

module.exports = {
    ACTIONS,
    DEFAULT_APPEAL_TEXT,
    DEFAULT_CONFIG,
    normalizeModDmConfig,
    getModDmConfig,
    setModDmConfig,
    buildPunishmentDm,
    sendPunishmentDm,
    isDmBlocked,
};

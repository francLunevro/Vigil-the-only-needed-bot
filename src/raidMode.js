const { getDb } = require('./db');
const { getGuildConfig } = require('./config');
const { logError } = require('./logError');
const { EmbedBuilder } = require('discord.js');

const DEFAULT_DURATION_MINUTES = 60;
const LOCKDOWN_SLOWMODE_SECONDS = 30;

// ──────────────────── Config ────────────────────

function getRaidConfig(guildId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM raid_config WHERE guild_id = ?').get(guildId);
    if (!row) {
        return { enabled: false, durationMinutes: DEFAULT_DURATION_MINUTES, noticeChannel: null, startedAt: null };
    }
    return {
        enabled: !!row.enabled,
        durationMinutes: row.duration_minutes || DEFAULT_DURATION_MINUTES,
        noticeChannel: row.notice_channel || null,
        startedAt: row.started_at || null,
    };
}

function isRaidModeEnabled(guildId) {
    return getRaidConfig(guildId).enabled;
}

function setRaidMode(guildId, updates) {
    const db = getDb();
    const current = getRaidConfig(guildId);
    const merged = {
        enabled: updates.enabled !== undefined ? updates.enabled : current.enabled,
        durationMinutes: updates.durationMinutes !== undefined ? updates.durationMinutes : current.durationMinutes,
        noticeChannel: updates.noticeChannel !== undefined ? updates.noticeChannel : current.noticeChannel,
    };
    const startedAt = merged.enabled ? (current.startedAt || Date.now()) : null;
    db.prepare('INSERT OR REPLACE INTO raid_config (guild_id, enabled, duration_minutes, notice_channel, started_at) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, merged.enabled ? 1 : 0, merged.durationMinutes, merged.noticeChannel || null, startedAt);
    return { ...merged, startedAt };
}

// ──────────────────── Join Lockdown ────────────────────

// Called from the guildMemberAdd event. While raid mode is on, new (human)
// members are timed out so they can't spam while staff sort things out.
async function handleRaidModeJoin(member) {
    if (!member || member.user?.bot) return;
    try {
        const cfg = getRaidConfig(member.guild.id);
        if (!cfg.enabled) return;
        if (!member.moderatable) return;
        const durationMs = (cfg.durationMinutes || DEFAULT_DURATION_MINUTES) * 60000;
        await member.timeout(durationMs, 'Raid mode active — new member lockdown');
    } catch (err) {
        logError(err, 'raidMode', 'joinTimeout');
    }
}

// ──────────────────── Lockdown / Notice ────────────────────

// Best-effort: set a short slowmode on every text channel (skips channels the
// bot can't edit). Rolls back to 0 when raid mode is turned off.
async function applyChannelLockdown(guild, enabled) {
    // Array.from keeps this working whether channels.cache is a discord.js
    // Collection (has .filter) or a plain Map (used in tests).
    const textChannels = Array.from(guild.channels.cache.values() || [])
        .filter(c => c.type === 0 || c.type === 5);
    for (const channel of textChannels) {
        try {
            await channel.setRateLimitPerUser(enabled ? LOCKDOWN_SLOWMODE_SECONDS : 0, 'Raid mode');
        } catch { /* channel not editable — skip */ }
    }
}

function resolveNoticeChannel(guild, cfg) {
    if (cfg.noticeChannel && guild.channels.cache.get(cfg.noticeChannel)) {
        return guild.channels.cache.get(cfg.noticeChannel);
    }
    const g = getGuildConfig(guild.id);
    const defaultLogId = g?.logChannelId;
    if (defaultLogId && guild.channels.cache.get(defaultLogId)) {
        return guild.channels.cache.get(defaultLogId);
    }
    return null;
}

async function postRaidNotice(guild, enabled, cfg) {
    const channel = resolveNoticeChannel(guild, cfg);
    if (!channel) return false;
    try {
        const embed = new EmbedBuilder()
            .setColor(enabled ? 0xED4245 : 0x3BA55C)
            .setTitle(enabled ? '🚨 RAID MODE ENGAGED' : '✅ RAID MODE DISENGAGED')
            .setDescription(enabled
                ? 'The server is in lockdown. New members will be **timed out** for **' + (cfg.durationMinutes || DEFAULT_DURATION_MINUTES) + ' min** and text channels have been slowed down.'
                : 'The lockdown has been lifted. New members can talk normally and slowmode has been reset.')
            .addFields(
                { name: 'Duration', value: String(cfg.durationMinutes || DEFAULT_DURATION_MINUTES) + ' min', inline: true },
                { name: 'Started', value: enabled && cfg.startedAt ? '<t:' + Math.floor(cfg.startedAt / 1000) + ':R>' : '—', inline: true },
            )
            .setTimestamp();
        await channel.send({ embeds: [embed] });
        return true;
    } catch (err) {
        logError(err, 'raidMode', 'notice');
        return false;
    }
}

// Enable raid mode: set config, post notice, apply slowmode lockdown.
async function enableRaidMode(guild, opts = {}) {
    const cfg = setRaidMode(guild.id, {
        enabled: true,
        durationMinutes: opts.durationMinutes,
        noticeChannel: opts.noticeChannel,
    });
    await postRaidNotice(guild, true, cfg);
    await applyChannelLockdown(guild, true);
    return cfg;
}

// Disable raid mode: set config, post notice, reset slowmode.
async function disableRaidMode(guild) {
    const cfg = setRaidMode(guild.id, { enabled: false });
    await postRaidNotice(guild, false, cfg);
    await applyChannelLockdown(guild, false);
    return cfg;
}

module.exports = {
    getRaidConfig,
    isRaidModeEnabled,
    setRaidMode,
    handleRaidModeJoin,
    enableRaidMode,
    disableRaidMode,
    postRaidNotice,
    applyChannelLockdown,
};
const { EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('./config');
const { logError } = require('./logError');
const { formatUptime } = require('./helpers');

let client = null;

// ════════════════════════════════════════════
//  Wick-style log embed builders
// ════════════════════════════════════════════

// "2 years ago" / "24 days ago" / "13 days ago" — for the chip-style stats.
function relativeTime(timestamp) {
    if (!timestamp) return null;
    const diff = Date.now() - timestamp;
    const future = diff < 0;
    const abs = Math.abs(diff);
    // Weeks are skipped on purpose — Wick-style chips read "24 days ago",
    // not "3 weeks ago"; days run until the month boundary.
    const units = [
        [31557600000, 'year'], [2629800000, 'month'],
        [86400000, 'day'], [3600000, 'hour'], [60000, 'minute'],
    ];
    for (const [ms, name] of units) {
        if (abs >= ms) {
            const n = Math.floor(abs / ms);
            return n + ' ' + name + (n !== 1 ? 's' : '') + (future ? ' from now' : ' ago');
        }
    }
    return 'just now';
}

function userLabel(u) {
    if (!u) return 'Unknown';
    if (u.username) return '@' + u.username;
    if (u.tag) return '@' + u.tag;
    return 'User';
}

// Titles use the raw username ("Mute ZtUi3Vc"), no @ prefix.
function titleName(u) {
    if (!u) return 'Unknown';
    if (u.username) return u.username;
    if (u.tag) return u.tag;
    return 'Unknown';
}

function userAvatar(u, size) {
    try {
        return u && typeof u.displayAvatarURL === 'function' ? u.displayAvatarURL({ size: size || 128 }) : null;
    } catch {
        return null;
    }
}

function footerTag(u) {
    return u ? (u.tag || (u.username ? '@' + u.username : 'Unknown')) : 'Moderator unknown';
}

// Multi-line "User" block used by report embeds (bold labels + code chips):
//   **User:** @name (mention)
//   **ID:** `123`
//   **Created:** `2 years ago`
//   **Joined:** `24 days ago`
//   **Last case:** `WARN` `13 days ago`
function userStatsValue({ user, member, lastCase }) {
    const lines = [];
    if (user && user.id) lines.push('**User:** ' + userLabel(user) + ' (<@' + user.id + '>)');
    else if (user) lines.push('**User:** ' + userLabel(user));
    if (user && user.id) lines.push('**ID:** `' + user.id + '`');
    const created = user ? (user.createdTimestamp ?? (user.user && user.user.createdTimestamp)) : null;
    if (created) lines.push('**Created:** `' + relativeTime(created) + '`');
    if (member && member.joinedTimestamp) lines.push('**Joined:** `' + relativeTime(member.joinedTimestamp) + '`');
    if (lastCase) {
        lines.push('**Last case:** `' + String(lastCase.action_type || '').toUpperCase() + '` `' + (relativeTime(lastCase.created_at) || 'unknown') + '`');
    }
    return lines.join('\n') || 'Unknown user';
}

// The shared mod-action log style (matches Carl/Wick-style logs):
//   · colored side bar via embed color (red = punishment, green = reversal)
//   · title "<Verb> <username>" (e.g. "Mute ZtUi3Vc"), or custom title
//   · bold field labels: User (username + pingable mention), Reason,
//     optional Duration / Proof
//   · target avatar as thumbnail
//   · moderator tag + avatar in the footer, plus timestamp
// Pass `fields` to replace the default User/Reason/Duration/Proof set
// entirely (used by report embeds); `extraFields` always appends after.
function modActionLogEmbed(opts) {
    const o = opts || {};
    const embed = new EmbedBuilder().setColor(o.color || 0xE74C3C);
    embed.setTitle(o.title || ((o.verb ? o.verb + ' ' : '') + titleName(o.target)));

    if (Array.isArray(o.fields)) {
        for (const f of o.fields) {
            if (!f || !f.name) continue;
            embed.addFields({ name: String(f.name).slice(0, 250), value: String(f.value ?? '—').slice(0, 1000), inline: !!f.inline });
        }
    } else {
        embed.addFields({ name: 'User', value: o.target && o.target.id ? userLabel(o.target) + ' (<@' + o.target.id + '>)' : 'Unknown' });
        embed.addFields({ name: 'Reason', value: (o.reason && String(o.reason).trim()) || 'No reason provided' });
        if (o.duration) embed.addFields({ name: 'Duration', value: String(o.duration) });
        if (o.proof) embed.addFields({ name: 'Proof', value: String(o.proof).slice(0, 1000) });
    }

    if (Array.isArray(o.extraFields)) {
        for (const f of o.extraFields) {
            if (!f || !f.name) continue;
            embed.addFields({ name: String(f.name).slice(0, 250), value: String(f.value ?? '—').slice(0, 1000), inline: !!f.inline });
        }
    }

    const thumb = userAvatar(o.target, 128);
    if (thumb) embed.setThumbnail(thumb);
    const modAvatar = o.moderator ? userAvatar(o.moderator, 64) : null;
    embed.setFooter({ text: o.footerText || footerTag(o.moderator), ...(modAvatar ? { iconURL: modAvatar } : {}) });
    embed.setTimestamp();
    return embed;
}

// Membership chip for kick/ban-style logs: Joined timestamp + Was-here
// duration. Shared by manual-kick (audit log path) and the bot's own
// /kick confirm flow so both render identically.
function membershipField(member) {
    const joinedTs = member?.joinedTimestamp;
    const wasHere = joinedTs ? formatUptime(Date.now() - joinedTs) : 'Unknown';
    return {
        name: 'Membership',
        value: 'Joined: ' + (joinedTs ? '<t:' + Math.floor(joinedTs / 1000) + ':R>' : 'Unknown')
            + '\nWas here: ' + wasHere,
    };
}

function setLoggerClient(c) {
    client = c;
}

function applyGuildEmbedColor(embed, guildId) {
    try {
        const guildConfig = getGuildConfig(guildId);
        if (guildConfig?.embedColor) {
            // Only override if embed doesn't already have a specific color set
            // (embeds with 0xE74C3C for kick/ban, 0xF1C40F for warn, etc. keep their color)
            const current = embed.data?.color;
            if (!current || current === 0x5865F2) {
                embed.setColor(guildConfig.embedColor);
            }
        }
    } catch {
        // Silently skip color override failures - non-critical
    }
    return embed;
}

async function sendLog(embed, category, channelId, guildId) {
    if (!client || !guildId) return;

    let guildConfig;
    try {
        guildConfig = getGuildConfig(guildId);
    } catch {
        return; // Can't log without config
    }
    if (!guildConfig) return;
    
    embed = applyGuildEmbedColor(embed, guildId);

    // Check category toggle
    if (category && guildConfig.logCategories?.[category] === false) return;

    // Channel-level filter: if trackedChannels has entries, only log those channels
    if (channelId && guildConfig.trackedChannels?.length > 0) {
        if (!guildConfig.trackedChannels.includes(channelId)) return;
    }

    // Resolve target channel — per-category channel first, then the guild's
    // default log channel. This makes the dashboard's "Default (auto)" option
    // actually work: a category left on auto falls back to the guild default
    // instead of silently dropping the event.
    let targetId = null;
    if (category && guildConfig.logChannels?.[category]) {
        targetId = guildConfig.logChannels[category];
    }
    if (!targetId && guildConfig.logChannelId) {
        targetId = guildConfig.logChannelId;
    }

    // Verify the channel belongs to this guild — prevents cross-server leaks
    if (targetId) {
        try {
            let ch = client.channels.cache.get(targetId);
            if (!ch) ch = await client.channels.fetch(targetId);
            if (!ch || (ch.guildId && ch.guildId !== guildId)) {
                targetId = null;
            }
        } catch (err) {
            logError(err, 'logging', 'channel_fetch ' + targetId);
            targetId = null;
        }
    }
    if (!targetId) return;

    try {
        let channel = client.channels.cache.get(targetId);
        if (!channel) channel = await client.channels.fetch(targetId).catch(() => null);
        if (channel) {
            await channel.send({ embeds: [embed] });
        }
    } catch (err) {
        logError(err, 'logging', 'send_failed');
    }
}

module.exports = { setLoggerClient, sendLog, relativeTime, modActionLogEmbed, userStatsValue, membershipField };

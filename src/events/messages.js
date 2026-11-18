const { EmbedBuilder } = require('discord.js');
const { getGuildConfig } = require('../config');
const { handlePrefixMessage } = require('../prefixCommands');
const { handleCustomCommand, handleAutoresponders } = require('../customCommands');
const { logError } = require('../logError');

const { getDb } = require('../db');
const { checkMessage } = require('../automod');
const { noteTicketMessage } = require('../ticketSla');

// ──────────────────── Track message activity for insights ────────────────────
function trackActivity(guildId, userId, channelId) {
    const db = getDb();
    try {
        db.prepare(`INSERT OR REPLACE INTO activity_counts (guild_id, user_id, channel_id, message_count, last_seen)
            VALUES (?, ?, ?, COALESCE((SELECT message_count + 1 FROM activity_counts WHERE guild_id = ? AND user_id = ? AND channel_id = ?), 1), ?)`)
            .run(guildId, userId, channelId, guildId, userId, channelId, Date.now());
    } catch (err) {
        logError(err, 'events', 'messages/trackActivity');
    }
}

// ──────────────────── Log deleted/edited messages for search ────────────────────
// The cap is enforced, but the retention delete costs a sort + subquery per
// call, and this runs on every deleted/edited message — so it's throttled to
// once every few minutes per guild instead of once per insert. The table can
// overshoot the cap by whatever arrives inside one throttle window, which is
// exactly the trade this function makes in exchange for a cheap hot path.
const MESSAGE_LOG_CAP = 1000;
// Throttle window. Tests set MESSAGE_LOG_PRUNE_MS=0 (before requiring this
// module) to restore prune-on-every-insert behaviour.
const MESSAGE_LOG_PRUNE_MS = Number.isFinite(Number(process.env.MESSAGE_LOG_PRUNE_MS))
    ? Math.max(0, Number(process.env.MESSAGE_LOG_PRUNE_MS))
    : 5 * 60 * 1000;
const lastMessageLogPrune = new Map();

function pruneMessageLog(db, guildId) {
    const now = Date.now();
    if (now - (lastMessageLogPrune.get(guildId) || 0) < MESSAGE_LOG_PRUNE_MS) return;
    lastMessageLogPrune.set(guildId, now);
    // id DESC breaks ties when a burst of events shares one millisecond —
    // without it SQLite sorts equal timestamps by rowid ascending, so the
    // OFFSET skipped the OLDEST rows and retention deleted the newest ones.
    db.prepare(`DELETE FROM message_log WHERE id IN (
        SELECT id FROM message_log WHERE guild_id = ? ORDER BY logged_at DESC, id DESC LIMIT -1 OFFSET ?
    )`).run(guildId, MESSAGE_LOG_CAP);
}

function logMessageAction(guildId, channelId, messageId, authorId, authorTag, content, action, attachments) {
    const db = getDb();
    try {
        db.prepare('INSERT INTO message_log (guild_id, channel_id, message_id, author_id, author_tag, content, action, attachments, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
            .run(guildId, channelId, messageId, authorId, authorTag, content || '', action, attachments ? JSON.stringify(attachments) : null, Date.now());
        pruneMessageLog(db, guildId);
    } catch (err) {
        logError(err, 'events', 'messages/logMessageAction');
    }
}

// Prefix cache — avoids a config read per message; 30s staleness window
const prefixCache = new Map();
const PREFIX_CACHE_MAX = 500; // Max guilds to cache

function getCachedPrefix(guildId) {
    const cached = prefixCache.get(guildId);
    if (cached && Date.now() - cached.ts < 30000) return cached.prefix;
    let prefix = ';';
    try {
        prefix = getGuildConfig(guildId).prefix || ';';
    } catch (err) {
        logError(err, 'events', 'messages/prefix');
    }
    // Enforce size cap with LRU eviction
    if (prefixCache.size >= PREFIX_CACHE_MAX) {
        const oldestKey = prefixCache.keys().next().value;
        prefixCache.delete(oldestKey);
    }
    prefixCache.set(guildId, { prefix, ts: Date.now() });
    return prefix;
}

module.exports = [
    {
        name: 'messageCreate',
        once: false,
        execute: (_deps) => async (message) => {
            if (message.author?.bot) return;
            if (!message.guild) return;

            // Track activity for server insights
            trackActivity(message.guild.id, message.author.id, message.channelId);

            // Auto-mod check (async, non-blocking — runs in background)
            checkMessage(message, message.guild.id).catch((err) => logError(err, 'events', 'messages/automod'));

            // Ticket SLA (src/ticketSla.js): the first reply from anyone other
            // than the ticket's creator is that ticket's first response. This
            // runs before the empty-content bail-out below so an attachment-only
            // reply still counts, and it is one indexed lookup that returns
            // nothing for the ordinary channels that make up almost every
            // message. Its own errors are logged and swallowed — a tracker must
            // never be the reason a message goes unhandled.
            noteTicketMessage(message);

            // Prefix dispatch — cached lookup supports ANY configured prefix
            // (the old hardcoded ; / ! . gate silently broke custom prefixes)
            const content = message.content;
            if (!content) return;

            const prefix = getCachedPrefix(message.guild.id);
            // Order matters and is also the priority: a real command wins over a
            // server-authored one of the same name, and neither ever fires
            // alongside an autoresponder (one reply per message, max).
            let handled = false;
            if (content.length >= 2) {
                handled = await handlePrefixMessage(message, prefix)
                    .catch((err) => { logError(err, 'events', 'messages/prefix'); return false; });
            }
            if (!handled) handled = await handleCustomCommand(message, prefix);
            if (!handled) await handleAutoresponders(message);
        },
    },
    {
        name: 'messageDelete',
        once: false,
        execute: (deps) => async (message) => {
            if (message.partial) return;
            if (!message.author || message.author.bot) return;
            if (!message.guild) return;

            const attachments = message.attachments.map(a => '[' + a.name + '](' + a.url + ')');
            const attachmentText = attachments.length > 0 ? deps.truncate(attachments.join('\n'), 1024) : null;
            const wasReply = message.reference ? ' (Reply)' : '';

            const embed = new EmbedBuilder()
                .setColor(0x992D22)
                .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL() })
                .setTitle('\uD83D\uDDD1\uFE0F Message Deleted' + wasReply)
                .setThumbnail(message.author.displayAvatarURL({ size: 64 }))
                .addFields(
                    { name: 'Author', value: String(message.author), inline: true },
                    { name: 'Channel', value: String(message.channel), inline: true },
                    { name: 'Sent', value: message.createdTimestamp ? '<t:' + Math.floor(message.createdTimestamp / 1000) + ':R>' : '*Unknown*', inline: true },
                    { name: 'Content', value: deps.truncate(message.content || '*No text*') },
                )
                .setFooter({ text: '#' + message.channel.name + ' · ID: ' + message.id, iconURL: message.guild.iconURL() })
                .setTimestamp();

            // Log for message search
            logMessageAction(message.guild.id, message.channelId, message.id, message.author.id, message.author.tag, message.content, 'deleted', message.attachments.map(a => ({ name: a.name, url: a.url })));

            // Broadcast to dashboard via SSE
            if (global.broadcastDashboard) {
                global.broadcastDashboard('msg_deleted', {
                    guildId: message.guild.id, channelId: message.channelId,
                    authorTag: message.author.tag, content: message.content?.slice(0, 200),
                });
            }

            // Show the first image inline if there are attachments
            const imageAttachment = message.attachments.find(a => a.contentType && a.contentType.startsWith('image/'));
            if (imageAttachment) {
                embed.setImage(imageAttachment.url);
            }

            if (attachmentText) {
                embed.addFields({ name: 'Attachments', value: attachmentText });
            }

            deps.sendLog(embed, 'messages', message.channelId, message.guild.id);
        },
    },
    {
        name: 'messageUpdate',
        once: false,
        execute: (deps) => async (oldMessage, newMessage) => {
            if (oldMessage.partial || (oldMessage.author && oldMessage.author.bot)) return;
            if (!oldMessage.guild) return;
            if (oldMessage.content === newMessage.content) return;

            const attachments = newMessage.attachments.map(a => '[' + a.name + '](' + a.url + ')');
            const attachmentText = attachments.length > 0 ? deps.truncate(attachments.join('\n'), 1024) : null;

            const embed = new EmbedBuilder()
                .setColor(0xF1C40F)
                .setAuthor({ name: oldMessage.author.tag, iconURL: oldMessage.author.displayAvatarURL() })
                .setTitle('\u270F\uFE0F Message Edited')
                .setThumbnail(oldMessage.author.displayAvatarURL({ size: 64 }))
                .addFields(
                    { name: 'Author', value: String(oldMessage.author), inline: true },
                    { name: 'Channel', value: String(oldMessage.channel), inline: true },
                    { name: 'Sent', value: oldMessage.createdTimestamp ? '<t:' + Math.floor(oldMessage.createdTimestamp / 1000) + ':R>' : '*Unknown*', inline: true },
                    { name: 'Before', value: deps.truncate(oldMessage.content || '*Empty*') },
                    { name: 'After', value: deps.truncate(newMessage.content || '*Empty*') },
                    { name: 'Jump', value: '[Click Here](' + newMessage.url + ')' },
                )
                .setFooter({ text: '#' + oldMessage.channel.name + ' · ID: ' + oldMessage.id, iconURL: oldMessage.guild.iconURL() })
                .setTimestamp();

            // Log for message search
            logMessageAction(oldMessage.guild.id, oldMessage.channelId, oldMessage.id, oldMessage.author.id, oldMessage.author.tag, oldMessage.content + ' → ' + newMessage.content, 'edited', null);

            // Broadcast to dashboard via SSE
            if (global.broadcastDashboard) {
                global.broadcastDashboard('msg_edited', {
                    guildId: oldMessage.guild.id, channelId: oldMessage.channelId,
                    authorTag: oldMessage.author.tag,
                    before: oldMessage.content?.slice(0, 100),
                    after: newMessage.content?.slice(0, 100),
                });
            }

            if (attachmentText) {
                embed.addFields({ name: 'Attachments', value: attachmentText });
            }

            deps.sendLog(embed, 'messages', oldMessage.channelId, oldMessage.guild.id);
        },
    },
];

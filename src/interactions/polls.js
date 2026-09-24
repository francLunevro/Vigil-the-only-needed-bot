// ──────────────────── Poll interaction handlers ────────────────────
// Vote toggling for single / multi / anonymous polls, the voter-list button,
// and the small poll_votes DB helpers they share.

const { EmbedBuilder } = require('discord.js');
const { getDb } = require('../db');
const { getLeadingOption } = require('../helpers');
const { logError } = require('../logError');

// ──────────────────── Poll DB Helpers ────────────────────

function getPollVotes(messageId) {
    try {
        const db = getDb();
        const rows = db.prepare('SELECT user_id, option_index FROM poll_votes WHERE message_id = ? AND option_index >= 0').all(messageId);
        const votes = new Map();
        for (const row of rows) {
            if (!votes.has(row.user_id)) {
                votes.set(row.user_id, []);
            }
            votes.get(row.user_id).push(row.option_index);
        }
        return votes;
    } catch (err) {
        logError(err, 'interactions', 'getPollVotes');
        return new Map();
    }
}

function getPollVotesFlat(messageId) {
    try {
        const db = getDb();
        const rows = db.prepare('SELECT user_id, option_index FROM poll_votes WHERE message_id = ? AND option_index >= 0').all(messageId);
        const votes = new Map();
        for (const row of rows) {
            votes.set(row.user_id, row.option_index);
        }
        return votes;
    } catch (err) {
        logError(err, 'interactions', 'getPollVotesFlat');
        return new Map();
    }
}

function setPollVoteInDb(messageId, userId, optionIndex) {
    try {
        const db = getDb();
        db.prepare('INSERT OR REPLACE INTO poll_votes (message_id, user_id, option_index, voted_at) VALUES (?, ?, ?, ?)')
            .run(messageId, userId, optionIndex, Date.now());
    } catch (err) {
        logError(err, 'interactions', 'setPollVoteInDb');
    }
}

function removePollVoteFromDb(messageId, userId) {
    try {
        const db = getDb();
        db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ?').run(messageId, userId);
    } catch (err) {
        logError(err, 'interactions', 'removePollVoteFromDb');
    }
}

function removePollOptionVoteFromDb(messageId, userId, optionIndex) {
    try {
        const db = getDb();
        db.prepare('DELETE FROM poll_votes WHERE message_id = ? AND user_id = ? AND option_index = ?').run(messageId, userId, optionIndex);
    } catch (err) {
        logError(err, 'interactions', 'removePollOptionVoteFromDb');
    }
}

// ──────────────────── Poll Vote Handler ────────────────────

async function handlePollVote(interaction, parts) {
    const prefix = parts[0];
    const messageId = interaction.message.id;
    const optionIndex = parseInt(parts[2]);
    const userId = interaction.user.id;
    const isMulti = prefix === 'pm';
    const isAnonymous = prefix === 'pa';

    // ── Record the vote ──
    let userVoteAction = '';
    if (isMulti) {
        const votes = getPollVotes(messageId);
        const userOptions = votes.get(userId) || [];
        if (userOptions.includes(optionIndex)) {
            removePollOptionVoteFromDb(messageId, userId, optionIndex);
            userVoteAction = 'removed from option ' + (optionIndex + 1);
        } else {
            setPollVoteInDb(messageId, userId, optionIndex);
            userVoteAction = 'cast for option ' + (optionIndex + 1);
        }
    } else if (isAnonymous) {
        const votes = getPollVotesFlat(messageId);
        if (votes.has(userId)) {
            removePollVoteFromDb(messageId, userId);
        }
        setPollVoteInDb(messageId, userId, optionIndex);
        userVoteAction = 'anonymously cast';
    } else {
        const votes = getPollVotesFlat(messageId);
        if (votes.get(userId) === optionIndex) {
            removePollVoteFromDb(messageId, userId);
            userVoteAction = 'removed';
        } else {
            if (votes.has(userId)) removePollVoteFromDb(messageId, userId);
            setPollVoteInDb(messageId, userId, optionIndex);
            userVoteAction = 'cast';
        }
    }

    // ── Reload votes ──
    const allVotes = getPollVotes(messageId);
    const totalVoters = allVotes.size;

    const voteCounts = {};
    for (const [, opts] of allVotes) {
        for (const opt of opts) {
            voteCounts[opt] = (voteCounts[opt] || 0) + 1;
        }
    }
    const totalVotes = Object.values(voteCounts).reduce((a, b) => a + b, 0);

    // Find leading option
    const leadingIdx = getLeadingOption(voteCounts);

    // ── Build updated embed ──
    const embed = EmbedBuilder.from(interaction.message.embeds[0]);
    const originalFieldCount = (embed.data.fields || []).length;
    let fields = embed.data.fields || [];
    if (fields.length === 0) {
        // Dashboard-created polls list their options in the description rather
        // than as fields, so synthesise fields here — otherwise there is nothing
        // for the vote tally to render into and no counts ever appear.
        const derived = extractOptions(embed.data);
        fields = derived.map(opt => ({ name: opt, value: '📊 Votes: **0** (0%)', inline: derived.length <= 2 }));
    }

    const updatedFields = fields.map((field, i) => {
        const count = voteCounts[i] || 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        const isLeading = leadingIdx === i && count > 0;

        let badge = '';
        if (isLeading) badge = '  👑';
        else if (count > 0 && leadingIdx !== null && count === voteCounts[leadingIdx] && leadingIdx !== i) badge = '  👑';

        return {
            name: badge ? field.name.replace(/  🏆$/, '') + badge : field.name,
            value: '📊 Votes: **' + count + '** (' + pct + '%)',
            inline: field.inline,
        };
    });
    embed.spliceFields(0, originalFieldCount, ...updatedFields);

    // ── Build footer ──
    const footerParts = ['🗳  ' + totalVoters + ' voter' + (totalVoters !== 1 ? 's' : '')];
    if (totalVotes > totalVoters) footerParts.push(totalVotes + ' total votes');
    if (isMulti) footerParts.push('🔁 Multi');
    if (isAnonymous) footerParts.push('🕵️ Anonymous');

    const desc = embed.data.description || '';
    const endMatch = desc.match(/Ends <t:(\d+):R>/);
    if (endMatch) {
        footerParts.push('Ends <t:' + endMatch[1] + ':R>');
    }

    embed.setFooter({ text: footerParts.join('  •  ') });

    // ── Defer first (instant ack — avoids 3-second timeout) ──
    await interaction.deferUpdate();

    // ── Update the embed after all DB ops ──
    const components = interaction.message.components;
    await interaction.editReply({ embeds: [embed], components: components.length > 0 ? components : undefined });

    // ── Send confirmation ──
    try {
        await interaction.followUp({ content: '✅ Vote ' + userVoteAction + '!', ephemeral: true });
    } catch (err) {
        logError(err, 'interactions', 'pollVoteFollowUp');
    }
}

// ──────────────────── Poll Voters Button ────────────────────

async function handlePollVoters(interaction) {
    const messageId = interaction.message.id;

    try {
        const db = getDb();
        const rows = db.prepare('SELECT user_id, option_index FROM poll_votes WHERE message_id = ? AND option_index >= 0 ORDER BY option_index, voted_at').all(messageId);

        if (rows.length === 0) {
            return interaction.reply({ content: 'No votes have been cast yet.', ephemeral: true });
        }

        const votersByOption = {};
        const userIds = new Set();
        for (const r of rows) {
            if (!votersByOption[r.option_index]) votersByOption[r.option_index] = [];
            votersByOption[r.option_index].push(r.user_id);
            userIds.add(r.user_id);
        }

        const lines = ['**🗳️ Poll Voters**', ''];
        const optNames = interaction.message.embeds[0]?.fields?.map(f => f.name) || [];

        for (const optIdx in votersByOption) {
            if (!Object.prototype.hasOwnProperty.call(votersByOption, optIdx)) continue;
            const idx = parseInt(optIdx);
            const voters = votersByOption[idx];
            const name = optNames[idx] || 'Option ' + (idx + 1);
            lines.push('**' + name + '** (' + voters.length + ' vote' + (voters.length !== 1 ? 's' : '') + '):');

            const showVoters = voters.slice(0, 15);
            let mentions = showVoters.map(uid => '<@' + uid + '>').join(', ');
            if (voters.length > 15) mentions += ' +' + (voters.length - 15) + ' more';
            lines.push(mentions);
            lines.push('');
        }

        lines.push('📊 **' + userIds.size + '** total voter' + (userIds.size !== 1 ? 's' : ''));

        await interaction.reply({ content: lines.join('\n').slice(0, 1900), ephemeral: true });
    } catch (err) {
        logError(err, 'interactions', 'handlePollVoters');
        await interaction.reply({ content: 'Failed to load voters.', ephemeral: true });
    }
}

// ──────────────────── Poll metadata (channel + question/options) ────────────────────
// Needed because poll_votes only keys on message_id; ending a poll means
// fetching a Message, which requires the channel it lives in.

function recordPoll({ messageId, guildId, channelId, question, options, pollType, endsAt }) {
    try {
        getDb().prepare(`INSERT OR REPLACE INTO polls
            (message_id, guild_id, channel_id, question, options, poll_type, created_at, ends_at, ended)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`)
            .run(
                String(messageId),
                guildId ? String(guildId) : null,
                channelId ? String(channelId) : null,
                String(question || ''),
                JSON.stringify(Array.isArray(options) ? options : []),
                pollType || 'single',
                Date.now(),
                Number.isFinite(endsAt) ? endsAt : null,
            );
    } catch (err) {
        logError(err, 'interactions', 'recordPoll');
    }
}

function getPollMeta(messageId) {
    try {
        return getDb().prepare('SELECT * FROM polls WHERE message_id = ?').get(String(messageId)) || null;
    } catch (err) {
        logError(err, 'interactions', 'getPollMeta');
        return null;
    }
}

function markPollEnded(messageId) {
    try {
        getDb().prepare('UPDATE polls SET ended = 1 WHERE message_id = ?').run(String(messageId));
    } catch (err) {
        logError(err, 'interactions', 'markPollEnded');
    }
}

// ──────────────────── End Poll ────────────────────
// Finalizes a poll: tallies the stored votes, rewrites the message as a result
// embed and strips its buttons so no more votes can be cast. Called by
// POST /api/polls/end (and safe to call on an already-ended poll).

// Strip leading emoji (including keycaps like 1️⃣) and spaces from a title/name,
// so "📊 Best pizza" -> "Best pizza" and "1️⃣  Yes" -> "Yes".
function stripLeadingEmoji(text) {
    return String(text || '')
        .replace(/^(?:[#*0-9]\uFE0F?\u20E3\s*|[\p{Extended_Pictographic}\uFE0F\u200D]+\s*)+/u, '')
        .trim();
}

function extractOptions(embed) {
    if (!embed) return [];
    const fields = embed.fields || [];
    if (fields.length > 0) {
        return fields.map(f => stripLeadingEmoji(String(f.name || '').replace(/\s*\uD83D\uDC51\s*$/, '')));
    }
    // Dashboard-created polls list options in the description as "1. Option".
    return String(embed.description || '')
        .split('\n')
        .map(l => l.trim())
        .map(l => { const m = l.match(/^\d+[.)]\s+(.*)$/); return m ? m[1].trim() : null; })
        .filter(Boolean);
}

function tallyVotes(messageId) {
    // Exclude the placeholder "system" row (option_index -1) the dashboard
    // create route writes to mark a poll that has no votes yet.
    const rows = getDb()
        .prepare('SELECT user_id, option_index FROM poll_votes WHERE message_id = ? AND option_index >= 0')
        .all(String(messageId));
    const voteCounts = {};
    const voters = new Set();
    for (const r of rows) {
        voteCounts[r.option_index] = (voteCounts[r.option_index] || 0) + 1;
        voters.add(r.user_id);
    }
    const totalVotes = Object.values(voteCounts).reduce((a, b) => a + b, 0);
    return { voteCounts, totalVoters: voters.size, totalVotes };
}

async function resolvePollMessage(client, messageId, channelId) {
    const id = String(messageId);
    // Fast path: we know the channel (from metadata or the caller).
    if (channelId) {
        const ch = client.channels.cache.get(String(channelId))
            || await client.channels.fetch(String(channelId)).catch(() => null);
        if (ch && ch.isTextBased?.() && ch.messages) {
            const msg = await ch.messages.fetch(id).catch(() => null);
            if (msg) return { channel: ch, message: msg };
        }
    }
    // Fallback: only look at channels whose message cache already holds it —
    // no API calls, no scanning hundreds of channels over REST.
    for (const ch of client.channels.cache.values()) {
        if (!ch || !ch.isTextBased?.() || !ch.messages) continue;
        if (!ch.messages.cache?.has(id)) continue;
        const msg = await ch.messages.fetch(id).catch(() => null);
        if (msg) return { channel: ch, message: msg };
    }
    return null;
}

async function endPoll(messageId, opts = {}) {
    const client = opts.client;
    if (!client) throw new Error('Discord client is not available');
    if (!messageId) throw new Error('Missing messageId');

    const meta = getPollMeta(messageId);
    const channelId = opts.channelId || (meta && meta.channel_id) || null;

    const found = await resolvePollMessage(client, messageId, channelId);
    if (!found) {
        throw new Error('Poll message not found — it may have been deleted, or the bot lost access to its channel');
    }
    const { channel, message } = found;

    const existing = message.embeds && message.embeds[0];

    let options = [];
    if (meta && meta.options) {
        try { options = JSON.parse(meta.options) || []; } catch { options = []; }
    }
    if (!Array.isArray(options) || options.length === 0) options = extractOptions(existing);

    const question = stripLeadingEmoji((meta && meta.question) || (existing && existing.title) || 'Poll') || 'Poll';

    const { voteCounts, totalVoters, totalVotes } = tallyVotes(messageId);

    // Winner(s): every option tied at the highest count (only if someone voted).
    let maxVotes = 0;
    for (const k of Object.keys(voteCounts)) {
        if (voteCounts[k] > maxVotes) maxVotes = voteCounts[k];
    }
    const winners = maxVotes > 0
        ? Object.keys(voteCounts).filter(k => voteCounts[k] === maxVotes).map(Number)
        : [];

    const finalEmbed = (existing ? EmbedBuilder.from(existing) : new EmbedBuilder())
        .setColor(0x95A5A6)
        .setTitle('🗳️ Poll Ended: ' + question.slice(0, 240))
        .setDescription('🔔 **Poll has ended!**' + (winners.length > 0
            ? '\n🏆 **Winner:** ' + winners.map(w => '**' + (options[w] || ('Option ' + (w + 1))) + '**').join(', ')
            : '\nNo votes were cast.'));

    // Replace whatever fields the live poll had with final result fields.
    finalEmbed.spliceFields(0, (finalEmbed.data.fields || []).length);
    const fieldCount = Math.min(options.length, 25);
    for (let i = 0; i < fieldCount; i++) {
        const count = voteCounts[i] || 0;
        const pct = totalVotes > 0 ? Math.round((count / totalVotes) * 100) : 0;
        finalEmbed.addFields({
            name: (options[i] || ('Option ' + (i + 1))).slice(0, 256) + (winners.includes(i) ? '  🏆' : ''),
            value: '📊 Votes: **' + count + '** (' + pct + '%)',
            inline: options.length <= 2,
        });
    }

    finalEmbed.setFooter({
        text: '🗳  ' + totalVotes + ' total votes  •  ' + totalVoters + ' voter' + (totalVoters !== 1 ? 's' : '') + '  •  Poll ended',
    });

    await message.edit({ embeds: [finalEmbed], components: [] });
    markPollEnded(messageId);

    return { question, options, voteCounts, winners, totalVotes, totalVoters, channelId: channel.id };
}

// ──────────────────── Timed-poll sweeper ────────────────────
// A timed poll used to be finalized by a setTimeout captured in the command
// handler, so a restart between creation and the end time meant the poll never
// finalized — buttons stayed live and the result was never posted. Sweeping the
// polls table instead makes auto-end restart-safe, the same pattern as
// giveaways. Anything due while the bot was offline is finished on boot.

let pollClient = null;

function setPollClient(client) {
    pollClient = client;
}

async function checkPolls() {
    if (!pollClient) return 0;
    const due = getDb().prepare(
        'SELECT message_id FROM polls WHERE ended = 0 AND ends_at IS NOT NULL AND ends_at <= ?'
    ).all(Date.now());
    let ended = 0;
    for (const row of due) {
        try {
            await endPoll(row.message_id, { client: pollClient });
            ended++;
        } catch (err) {
            // A deleted message or lost channel access must not block the rest
            // of the sweep — or every later poll, forever. endPoll only throws
            // before markPollEnded, so a failed poll is retried next sweep.
            logError(err, 'polls', 'checkPolls:' + row.message_id);
        }
    }
    return ended;
}

let pollInterval = null;
const POLL_SWEEP_INTERVAL_MS = 30 * 1000;

function startPollCheck() {
    if (pollInterval) return;
    pollInterval = setInterval(() => { checkPolls().catch((err) => logError(err, 'polls', 'checkPolls')); }, POLL_SWEEP_INTERVAL_MS);
    pollInterval.unref();
    // Finish anything that came due while the bot was offline.
    const bootSweep = setTimeout(() => { checkPolls().catch((err) => logError(err, 'polls', 'checkPolls:boot')); }, 10 * 1000);
    bootSweep.unref();
}

function stopPollCheck() {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

module.exports = {
    handlePollVote,
    handlePollVoters,
    recordPoll,
    endPoll,
    setPollClient,
    checkPolls,
    startPollCheck,
    stopPollCheck,
};

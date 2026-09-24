const { EmbedBuilder } = require('discord.js');
const { getDb } = require('./db');
const { logError } = require('./logError');

let client = null;
let posterInterval = null;

function setScheduledPostClient(c) {
    client = c;
}

// ──────────────────── Schedule Parsing ────────────────────

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseTime(str) {
    const m = String(str).match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2], 10);
    if (h > 23 || min > 59) return null;
    return { h, min };
}

function weekdayToNum(v) {
    const s = String(v).toLowerCase();
    if (/^\d$/.test(s)) {
        const n = parseInt(s, 10);
        return n >= 0 && n <= 6 ? n : null;
    }
    const idx = DAY_NAMES.indexOf(s);
    if (idx !== -1) return idx;
    // Accept a 3-letter abbreviation too.
    const short = DAY_NAMES.findIndex(n => n.startsWith(s.slice(0, 3)));
    return short !== -1 ? short : null;
}

// Parse a human schedule string into { scheduleType, scheduleValue }:
//   "daily 18:00"           -> { daily, '18:00' }
//   "weekly monday 18:00"   -> { weekly, 'monday:18:00' }
//   "weekly 0 18:00"        -> { weekly, '0:18:00' }   (0 = Sunday)
//   "interval 60"           -> { interval, '60' }      (every 60 minutes)
function parseSchedule(input) {
    const parts = String(input).trim().split(/\s+/);
    const type = parts[0]?.toLowerCase();
    if (type === 'daily' && parts[1] && parseTime(parts[1])) {
        return { scheduleType: 'daily', scheduleValue: parts[1] };
    }
    if (type === 'weekly' && parts[1] && parts[2] && weekdayToNum(parts[1]) !== null && parseTime(parts[2])) {
        return { scheduleType: 'weekly', scheduleValue: parts[1].toLowerCase() + ':' + parts[2] };
    }
    if (type === 'interval' && parts[1]) {
        const minutes = parseInt(parts[1], 10);
        if (minutes >= 1) return { scheduleType: 'interval', scheduleValue: String(minutes) };
    }
    return null;
}

function computeNextRun(scheduleType, scheduleValue, from = Date.now()) {
    if (scheduleType === 'interval') {
        const minutes = parseInt(scheduleValue, 10);
        if (!minutes || minutes < 1) return null;
        return from + minutes * 60000;
    }
    if (scheduleType === 'daily') {
        const t = parseTime(scheduleValue);
        if (!t) return null;
        const candidate = new Date(from);
        candidate.setHours(t.h, t.min, 0, 0);
        if (candidate.getTime() <= from) candidate.setDate(candidate.getDate() + 1);
        return candidate.getTime();
    }
    if (scheduleType === 'weekly') {
        // scheduleValue is '<day>:<HH:MM>'; split on the first colon only so the
        // time's own colon (e.g. 'monday:09:00') isn't broken into three parts.
        const str = String(scheduleValue);
        const idx = str.indexOf(':');
        if (idx === -1) return null;
        const day = weekdayToNum(str.slice(0, idx));
        const t = parseTime(str.slice(idx + 1));
        if (day === null || !t) return null;
        const candidate = new Date(from);
        candidate.setHours(t.h, t.min, 0, 0);
        let diff = (day - candidate.getDay() + 7) % 7;
        if (diff === 0 && candidate.getTime() <= from) diff = 7;
        candidate.setDate(candidate.getDate() + diff);
        return candidate.getTime();
    }
    return null;
}

// ──────────────────── Manage Scheduled Posts (SQLite) ────────────────────

function addScheduledPost(guildId, channelId, opts, createdBy) {
    const db = getDb();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const nextRunAt = computeNextRun(opts.scheduleType, opts.scheduleValue);
    if (nextRunAt === null) throw new Error('Invalid schedule');
    db.prepare('INSERT INTO scheduled_posts (id, guild_id, channel_id, title, content, color, schedule_type, schedule_value, next_run_at, enabled, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)')
        .run(id, guildId, channelId, opts.title || null, opts.content, opts.color || null, opts.scheduleType, opts.scheduleValue, nextRunAt, createdBy || null, Date.now());
    return {
        id, guildId, channelId, title: opts.title || null, content: opts.content, color: opts.color || null,
        scheduleType: opts.scheduleType, scheduleValue: opts.scheduleValue, nextRunAt, enabled: true, createdBy: createdBy || null, createdAt: Date.now(),
    };
}

function listScheduledPosts(guildId) {
    const db = getDb();
    return db.prepare('SELECT * FROM scheduled_posts WHERE guild_id = ? ORDER BY next_run_at ASC').all(guildId).map(r => ({
        id: r.id,
        guildId: r.guild_id,
        channelId: r.channel_id,
        title: r.title,
        content: r.content,
        color: r.color,
        scheduleType: r.schedule_type,
        scheduleValue: r.schedule_value,
        nextRunAt: r.next_run_at,
        enabled: !!r.enabled,
        createdBy: r.created_by,
        createdAt: r.created_at,
    }));
}

function removeScheduledPost(id, guildId) {
    const db = getDb();
    const result = db.prepare('DELETE FROM scheduled_posts WHERE id = ? AND guild_id = ?').run(id, guildId);
    return result.changes > 0;
}

// ──────────────────── Poster Loop ────────────────────

let posterRunning = false;

async function processDuePosts() {
    if (posterRunning) return;
    posterRunning = true;
    const db = getDb();
    const now = Date.now();
    try {
        const due = db.prepare('SELECT * FROM scheduled_posts WHERE enabled = 1 AND next_run_at <= ? AND attempts < 3').all(now);
        for (const post of due) {
            try {
                const guild = client?.guilds.cache.get(post.guild_id);
                const channel = guild?.channels.cache.get(post.channel_id);
                if (!channel || !channel.isTextBased || !channel.isTextBased()) {
                    // Channel is gone — disable rather than retrying forever.
                    db.prepare('UPDATE scheduled_posts SET enabled = 0 WHERE id = ?').run(post.id);
                    continue;
                }
                const embed = new EmbedBuilder()
                    .setColor(post.color && /^#?[0-9a-fA-F]{6}$/.test(post.color) ? post.color : 0x5865F2)
                    .setDescription(post.content || null);
                if (post.title) embed.setTitle(post.title);
                await channel.send({ embeds: [embed] });
                const next = computeNextRun(post.schedule_type, post.schedule_value, Date.now());
                if (next === null) {
                    db.prepare('UPDATE scheduled_posts SET enabled = 0 WHERE id = ?').run(post.id);
                } else {
                    db.prepare('UPDATE scheduled_posts SET next_run_at = ?, attempts = 0 WHERE id = ?').run(next, post.id);
                }
            } catch {
                // Send failed (missing perms, etc.) — retry next tick up to 3 times.
                db.prepare('UPDATE scheduled_posts SET attempts = attempts + 1 WHERE id = ?').run(post.id);
            }
        }
    } catch (err) {
        logError(err, 'scheduledPosts', 'poster');
    } finally {
        posterRunning = false;
    }
}

function startScheduledPoster() {
    if (posterInterval) clearInterval(posterInterval);
    posterInterval = setInterval(() => { processDuePosts().catch((err) => logError(err, 'scheduledPosts', 'processDuePosts')); }, 30000);
    posterInterval.unref?.();
}

function stopScheduledPoster() {
    if (posterInterval) clearInterval(posterInterval);
    posterInterval = null;
}

module.exports = {
    setScheduledPostClient,
    parseSchedule,
    computeNextRun,
    addScheduledPost,
    listScheduledPosts,
    removeScheduledPost,
    processDuePosts,
    startScheduledPoster,
    stopScheduledPoster,
};
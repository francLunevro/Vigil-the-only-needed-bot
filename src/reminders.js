const { EmbedBuilder } = require('discord.js');
const { getDb } = require('./db');
const { MAX_ATTEMPTS, STALE_DISPATCH_MS, deliveryNonce, wasRejected, retryAt } = require('./scheduledExecution');
const { logError } = require('./logError');

let client = null;
let checkInterval = null;

function setReminderClient(c) {
    client = c;
}

// ──────────────────── Manage Reminders (SQLite) ────────────────────

function addReminder(userId, channelId, text, durationMs) {
    const db = getDb();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const remindAt = Date.now() + durationMs;

    db.prepare('INSERT INTO reminders (id, user_id, channel_id, text, created_at, remind_at, notified) VALUES (?, ?, ?, ?, ?, ?, 0)')
        .run(id, userId, channelId || null, text, Date.now(), remindAt);

    return {
        id,
        userId,
        channelId,
        text,
        createdAt: Date.now(),
        remindAt,
        notified: false,
    };
}

function removeReminder(reminderId, userId) {
    const db = getDb();
    const result = db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?')
        .run(reminderId, userId);
    return result.changes > 0;
}

function getUserReminders(userId) {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM reminders WHERE user_id = ? AND notified = 0 ORDER BY remind_at ASC')
        .all(userId);
    return rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        channelId: r.channel_id,
        text: r.text,
        createdAt: r.created_at,
        remindAt: r.remind_at,
        notified: !!r.notified,
        deliveryState: r.delivery_state,
    }));
}

function getAllPending() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM reminders WHERE notified = 0 ORDER BY remind_at ASC').all();
    return rows.map(r => ({
        id: r.id,
        userId: r.user_id,
        channelId: r.channel_id,
        text: r.text,
        createdAt: r.created_at,
        remindAt: r.remind_at,
        notified: !!r.notified,
        deliveryState: r.delivery_state,
    }));
}

// ──────────────────── Check Loop ────────────────────

let checkRunning = false;

async function processDueReminders() {
    if (checkRunning || !client) return;
    checkRunning = true;
    try {
        const db = getDb();
        const now = Date.now();
        db.prepare(`
            UPDATE reminders SET delivery_state = 'uncertain', dispatch_started_at = NULL
            WHERE notified = 0 AND delivery_state = 'dispatching' AND dispatch_started_at <= ?
        `).run(now - STALE_DISPATCH_MS);

        const due = db.prepare(`
            SELECT * FROM reminders WHERE notified = 0 AND remind_at <= ?
                AND delivery_state IN ('pending', 'retry') AND attempts < ? AND retry_at <= ?
        `).all(now, MAX_ATTEMPTS, now);
        const claim = db.prepare(`
            UPDATE reminders SET delivery_state = 'dispatching', dispatch_started_at = ?, attempts = attempts + 1
            WHERE id = ? AND user_id = ? AND notified = 0 AND delivery_state = ? AND attempts = ? AND retry_at <= ?
        `);
        const finish = db.prepare(`
            UPDATE reminders SET delivery_state = ?, dispatch_started_at = NULL, retry_at = ?,
                notified = ?, last_message_id = ?
            WHERE id = ? AND user_id = ? AND delivery_state = 'dispatching' AND dispatch_started_at = ?
        `);

        for (const reminder of due) {
            let user;
            let embed;
            try {
                user = await client.users.fetch(reminder.user_id);
                if (!user) throw new Error('Reminder recipient unavailable');
                embed = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle('? Reminder')
                    .setDescription(reminder.text)
                    .setFooter({ text: 'Set ' + new Date(reminder.created_at).toLocaleString() })
                    .setTimestamp();
            } catch (err) {
                const attempts = reminder.attempts + 1;
                db.prepare(`
                    UPDATE reminders SET attempts = ?, retry_at = ?, delivery_state = ?
                    WHERE id = ? AND user_id = ? AND delivery_state = ? AND attempts = ?
                `).run(attempts, retryAt(attempts), attempts < MAX_ATTEMPTS ? 'retry' : 'failed',
                    reminder.id, reminder.user_id, reminder.delivery_state, reminder.attempts);
                logError(err, 'reminders', 'recipient');
                continue;
            }
            const started = Date.now();
            if (!claim.run(started, reminder.id, reminder.user_id, reminder.delivery_state,
                reminder.attempts, started).changes) continue;
            let message;
            try {
                message = await user.send({
                    embeds: [embed],
                    nonce: deliveryNonce('reminder', reminder.id, reminder.remind_at),
                    enforceNonce: true,
                });
            } catch (err) {
                const attempts = reminder.attempts + 1;
                const state = wasRejected(err) ? (attempts < MAX_ATTEMPTS ? 'retry' : 'failed') : 'uncertain';
                finish.run(state, state === 'retry' ? retryAt(attempts) : 0, 0, null, reminder.id, reminder.user_id, started);
                logError(err, 'reminders', 'delivery');
                continue;
            }
            finish.run('delivered', 0, 1, message?.id ?? null, reminder.id, reminder.user_id, started);
        }

        db.prepare(`
            DELETE FROM reminders WHERE remind_at < ? AND
                (notified = 1 OR delivery_state IN ('failed', 'uncertain') OR
                 (delivery_state = 'pending' AND attempts >= ?))
        `).run(now - 86400000, MAX_ATTEMPTS);
    } catch (err) {
        logError(err, 'reminders', 'check');
    } finally {
        checkRunning = false;
    }
}

function startReminderChecker() {
    if (checkInterval) clearInterval(checkInterval);
    checkInterval = setInterval(processDueReminders, 15000);
    return checkInterval;
}

function stopReminderChecker() {
    if (checkInterval) {
        clearInterval(checkInterval);
        checkInterval = null;
    }
}

module.exports = {
    setReminderClient,
    addReminder,
    removeReminder,
    getUserReminders,
    getAllPending,
    processDueReminders,
    startReminderChecker,
    stopReminderChecker,
};

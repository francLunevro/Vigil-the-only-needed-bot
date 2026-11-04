const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-recovery-'));
process.env.DATA_DIR = tmp;

const { getDb, closeDb } = require('../src/db');
const posts = require('../src/scheduledPosts');
const reminders = require('../src/reminders');
const bans = require('../src/tempBans');
const { STALE_DISPATCH_MS } = require('../src/scheduledExecution');

after(() => {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
});

function setupPost(send) {
    const channel = { isTextBased: () => true, send };
    posts.setScheduledPostClient({ guilds: { cache: new Map([['guild', { channels: { cache: new Map([['channel', channel]]) } }]]) } });
    const post = posts.addScheduledPost('guild', 'channel',
        { content: 'fixture', scheduleType: 'interval', scheduleValue: '60' }, 'user');
    getDb().prepare('UPDATE scheduled_posts SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, post.id);
    return post.id;
}

function getPost(id) {
    return getDb().prepare('SELECT * FROM scheduled_posts WHERE id = ?').get(id);
}

test('an accepted post with a failed completion write is not sent again after reopening SQLite', async () => {
    const sent = [];
    const id = setupPost(async payload => { sent.push(payload); return { id: 'discord-post' }; });
    const dueAt = getPost(id).next_run_at;
    getDb().exec(`
        CREATE TRIGGER fail_post_completion BEFORE UPDATE ON scheduled_posts
        WHEN NEW.delivery_state = 'delivered'
        BEGIN SELECT RAISE(ABORT, 'simulated crash before completion commit'); END;
    `);
    await posts.processDuePosts();
    assert.equal(getPost(id).delivery_state, 'dispatching');
    assert.equal(getPost(id).attempts, 1);
    closeDb();
    getDb().exec('DROP TRIGGER fail_post_completion');
    await posts.processDuePosts();
    assert.equal(sent.length, 1);
    assert.equal(getPost(id).next_run_at, dueAt);

    getDb().prepare('UPDATE scheduled_posts SET dispatch_started_at = ? WHERE id = ?')
        .run(Date.now() - STALE_DISPATCH_MS - 1, id);
    await posts.processDuePosts();
    assert.equal(sent.length, 1);
    assert.equal(getPost(id).delivery_state, 'uncertain');
    assert.ok(getPost(id).next_run_at > Date.now());
    assert.equal(sent[0].enforceNonce, true);
    assert.equal(sent[0].nonce.length, 25);
});

test('confirmed rejection backs off, then retries with the same nonce and stores the receipt', async () => {
    const payloads = [];
    const id = setupPost(async payload => {
        payloads.push(payload);
        if (payloads.length === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
        return { id: 'discord-receipt' };
    });
    await Promise.all([posts.processDuePosts(), posts.processDuePosts()]);
    assert.equal(payloads.length, 1);
    assert.equal(getPost(id).delivery_state, 'retry');
    assert.ok(getPost(id).retry_at > Date.now());
    await posts.processDuePosts();
    assert.equal(payloads.length, 1);
    getDb().prepare('UPDATE scheduled_posts SET retry_at = 0 WHERE id = ?').run(id);
    await posts.processDuePosts();
    assert.equal(payloads.length, 2);
    assert.equal(payloads[0].nonce, payloads[1].nonce);
    assert.equal(getPost(id).delivery_state, 'delivered');
    assert.equal(getPost(id).last_message_id, 'discord-receipt');
    assert.equal(getPost(id).attempts, 0);
});

test('lost reminder response remains uncertain without retrying the DM', async () => {
    let sends = 0;
    reminders.setReminderClient({ users: { fetch: async () => ({
        send: async () => { sends++; throw new Error('socket closed after send'); },
    }) } });
    const reminder = reminders.addReminder('recipient', null, 'fixture', -1000);
    await reminders.processDueReminders();
    closeDb();
    await reminders.processDueReminders();
    const row = getDb().prepare('SELECT * FROM reminders WHERE id = ?').get(reminder.id);
    assert.equal(row.delivery_state, 'uncertain');
    assert.equal(row.notified, 0);
    assert.equal(sends, 1);
});

test('a restarted temporary-unban worker reconciles absence and leaves a replacement ban alone', async () => {
    const active = new Map();
    let removals = 0;
    const guild = { id: 'guild', bans: {
        create: async (id, options) => { active.set(id, options); },
        fetch: async ({ user, force, cache }) => {
            assert.equal(force, true);
            assert.equal(cache, false);
            if (!active.has(user)) throw Object.assign(new Error('unknown ban'), { code: 10026 });
            return active.get(user);
        },
        remove: async id => {
            removals++;
            active.delete(id);
            throw new Error('connection lost after Discord accepted unban');
        },
    } };
    bans.setTempBanClient({ guilds: { cache: new Map([['guild', guild]]) } });
    await bans.applyTempBan(guild, 'absent', 'fixture', '1 hour', -1, 0);
    await bans.applyTempBan(guild, 'replaced', 'fixture', '1 hour', -1, 0);
    assert.match(active.get('absent').reason, /^\[Vigil temp ban /);
    active.set('replaced', { reason: 'A separate permanent ban' });
    await bans.sweepExpiredTempBans();
    assert.equal(removals, 1);
    assert.equal(bans.getActiveTempBan('guild', 'absent').delivery_state, 'dispatching');
    assert.equal(bans.getActiveTempBan('guild', 'replaced').delivery_state, 'uncertain');

    closeDb();
    getDb().prepare("UPDATE temp_bans SET dispatch_started_at = ? WHERE user_id = 'absent'")
        .run(Date.now() - STALE_DISPATCH_MS - 1);
    await bans.sweepExpiredTempBans();
    assert.equal(removals, 1);
    assert.equal(bans.getActiveTempBan('guild', 'absent'), null);
    assert.equal(active.get('replaced').reason, 'A separate permanent ban');
});

test('temporary-ban intent is durable before the Discord write, even on a lost response', async () => {
    const guild = { id: 'lost-create', bans: { create: async () => {
        assert.ok(bans.getActiveTempBan('lost-create', 'user').ban_marker);
        throw new Error('lost response');
    } } };
    await assert.rejects(bans.applyTempBan(guild, 'user', 'fixture', '1 hour', 3600000, 0), /lost response/);
    closeDb();
    assert.ok(bans.getActiveTempBan('lost-create', 'user').ban_marker);
});

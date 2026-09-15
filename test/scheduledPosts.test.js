// Tests for the scheduled channel posts module: schedule parsing, next-run
// computation, CRUD, and the due-post processor (send + reschedule).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-posts-test-'));
process.env.DATA_DIR = tmp;

const { closeDb } = require('../src/db');
const sp = require('../src/scheduledPosts');

after(() => {
    try { closeDb(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('parseSchedule: daily, weekly, interval, and invalid inputs', () => {
    assert.deepStrictEqual(sp.parseSchedule('daily 18:00'), { scheduleType: 'daily', scheduleValue: '18:00' });
    assert.deepStrictEqual(sp.parseSchedule('weekly monday 18:00'), { scheduleType: 'weekly', scheduleValue: 'monday:18:00' });
    assert.deepStrictEqual(sp.parseSchedule('weekly 0 18:00'), { scheduleType: 'weekly', scheduleValue: '0:18:00' });
    assert.deepStrictEqual(sp.parseSchedule('interval 60'), { scheduleType: 'interval', scheduleValue: '60' });
    assert.strictEqual(sp.parseSchedule('daily 25:99'), null);
    assert.strictEqual(sp.parseSchedule('weekly friday'), null);
    assert.strictEqual(sp.parseSchedule('interval'), null);
    assert.strictEqual(sp.parseSchedule('nonsense'), null);
});

test('computeNextRun: daily returns the next occurrence after "from"', () => {
    // from = today 10:00; schedule 18:00 -> today 18:00
    const from = new Date('2026-09-13T10:00:00').getTime();
    const next = sp.computeNextRun('daily', '18:00', from);
    const d = new Date(next);
    assert.strictEqual(d.getHours(), 18);
    assert.strictEqual(d.getMinutes(), 0);
    assert.ok(next > from);
});

test('computeNextRun: daily rolls to tomorrow when the time already passed', () => {
    const from = new Date('2026-09-13T19:00:00').getTime();
    const next = sp.computeNextRun('daily', '18:00', from);
    const d = new Date(next);
    assert.strictEqual(d.getDate(), 14); // next day
    assert.strictEqual(d.getHours(), 18);
});

test('computeNextRun: interval returns from + N minutes', () => {
    const from = Date.now();
    const next = sp.computeNextRun('interval', '60', from);
    assert.strictEqual(next, from + 60 * 60000);
});

test('computeNextRun: weekly lands on the requested weekday', () => {
    // 2026-09-13 is a Sunday (getDay()=0). Weekly monday -> next Monday = 09-14.
    const from = new Date('2026-09-13T09:00:00').getTime();
    const next = sp.computeNextRun('weekly', 'monday:09:00', from);
    const d = new Date(next);
    assert.strictEqual(d.getDay(), 1); // Monday
    assert.strictEqual(d.getDate(), 14);
    assert.strictEqual(d.getHours(), 9);
});

test('addScheduledPost / listScheduledPosts / removeScheduledPost roundtrip', () => {
    const post = sp.addScheduledPost('g1', 'c1', { title: 'Announcement', content: 'Hello', scheduleType: 'daily', scheduleValue: '09:00' }, 'user1');
    assert.ok(post.id);
    assert.ok(post.nextRunAt > Date.now());

    const list = sp.listScheduledPosts('g1');
    assert.strictEqual(list.length, 1);
    assert.strictEqual(list[0].title, 'Announcement');
    assert.strictEqual(list[0].enabled, true);

    assert.strictEqual(sp.removeScheduledPost(post.id, 'g1'), true);
    assert.strictEqual(sp.listScheduledPosts('g1').length, 0);
});

test('addScheduledPost rejects an invalid schedule', () => {
    assert.throws(() => sp.addScheduledPost('g1', 'c1', { content: 'x', scheduleType: 'daily', scheduleValue: '25:99' }, 'u1'));
});

test('processDuePosts sends due posts and reschedules them', async () => {
    const sent = [];
    const channel = { isTextBased: () => true, send: async (payload) => { sent.push(payload); } };
    const client = { guilds: { cache: new Map([['g1', { channels: { cache: new Map([['c1', channel]]) } }]]) } };
    sp.setScheduledPostClient(client);

    // Create a post due immediately, then drive the processor directly.
    sp.addScheduledPost('g1', 'c1', { title: 'Hi', content: 'World', scheduleType: 'interval', scheduleValue: '60' }, 'user1');
    // Force it due now (interval schedule from now is +60min; set next_run_at in the past).
    const { getDb } = require('../src/db');
    getDb().prepare('UPDATE scheduled_posts SET next_run_at = ?').run(Date.now() - 1000);

    await sp.processDuePosts();
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].embeds[0].data.title, 'Hi');

    // It should have rescheduled ~60 min from now and reset attempts.
    const post = sp.listScheduledPosts('g1')[0];
    assert.ok(post.nextRunAt > Date.now());
    assert.ok(post.enabled);
});

test('processDuePosts disables a post whose channel is gone', async () => {
    const client = { guilds: { cache: new Map() } };
    sp.setScheduledPostClient(client);
    sp.addScheduledPost('g2', 'missing', { content: 'orphan', scheduleType: 'daily', scheduleValue: '09:00' }, 'user1');
    const { getDb } = require('../src/db');
    getDb().prepare('UPDATE scheduled_posts SET next_run_at = ? WHERE guild_id = ?').run(Date.now() - 1000, 'g2');

    await sp.processDuePosts();
    const post = sp.listScheduledPosts('g2')[0];
    assert.strictEqual(post.enabled, false, 'orphaned channel post should be disabled');
});
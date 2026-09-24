// Retention for the message-log search table. Two behaviours are pinned
// here because the first version of the prune was quietly wrong: it deleted
// the NEWEST rows when a burst of events shared one millisecond, and it ran a
// sort+subquery on every insert.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'message-log-retention-test-'));
process.env.DATA_DIR = tmp;

const { getDb, closeDb } = require('../src/db');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const truncate = (s, max = 1024) => String(s || '').slice(0, max);

// Re-require the module so MESSAGE_LOG_PRUNE_MS is re-read per test.
function messageDeleteHandler(pruneMs) {
    process.env.MESSAGE_LOG_PRUNE_MS = String(pruneMs);
    const cacheKey = require.resolve('../src/events/messages');
    delete require.cache[cacheKey];
    const events = require(cacheKey);
    const evt = events.find(e => e.name === 'messageDelete');
    return evt.execute({ truncate, sendLog: () => {} });
}

function fakeMessage(guildId, i) {
    const author = {
        id: 'author-' + i,
        tag: 'tester#' + i,
        bot: false,
        toString: () => '<@author' + i + '>',
        displayAvatarURL: () => 'https://example.invalid/a.png',
    };
    return {
        partial: false,
        id: 'msg-' + i,
        content: 'msg-' + i,
        guild: { id: guildId, iconURL: () => null },
        channelId: 'chan-1',
        channel: { name: 'general', toString: () => '#general' },
        author,
        createdTimestamp: Date.now(),
        attachments: [],
        reference: null,
        url: 'https://example.invalid/msg/' + i,
    };
}

function count(guildId) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM message_log WHERE guild_id = ?').get(guildId).n;
}

function contents(guildId) {
    return getDb().prepare('SELECT content FROM message_log WHERE guild_id = ? ORDER BY id ASC').all(guildId).map(r => r.content);
}

test('the cap keeps the newest 1000 rows and drops the oldest', async () => {
    const onDelete = messageDeleteHandler(0); // prune on every insert
    const guild = 'g-ret';

    // 1005 deletes landing inside the same millisecond — the tie case that
    // exposed the backwards ordering.
    for (let i = 0; i < 1005; i++) {
        await onDelete(fakeMessage(guild, i));
    }

    assert.strictEqual(count(guild), 1000, 'cap enforced');
    const kept = contents(guild);
    assert.strictEqual(kept[0], 'msg-5', 'the five oldest entries are the ones dropped');
    assert.strictEqual(kept[kept.length - 1], 'msg-1004', 'the newest entry always survives');
});

test('retention is per guild', async () => {
    const onDelete = messageDeleteHandler(0);
    for (let i = 0; i < 10; i++) {
        await onDelete(fakeMessage('g-a', i));
        await onDelete(fakeMessage('g-b', i));
    }
    assert.strictEqual(count('g-a'), 10);
    assert.strictEqual(count('g-b'), 10);
});

test('with the default window the prune is throttled, not run per insert', async () => {
    const onDelete = messageDeleteHandler(5 * 60 * 1000);
    const guild = 'g-throttled';

    for (let i = 0; i < 1005; i++) {
        await onDelete(fakeMessage(guild, i));
    }

    // The first insert primed the throttle window while the table was still
    // small, so no prune ran during the burst: rows overshoot the cap rather
    // than paying for a sort on every delete. That is the deliberate trade.
    assert.strictEqual(count(guild), 1005);
});

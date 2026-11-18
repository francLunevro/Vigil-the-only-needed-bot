// Temp-isolated tests for the db layer: error logs + database backups.
// Uses Node's built-in test runner (node --test) — no extra dependencies.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate BEFORE requiring db — DB_PATH is computed at module load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashdb-test-'));
process.env.DATA_DIR = tmp;

const {
    getDb, closeDb, recordErrorLog, getErrorLogs, getErrorTagCounts,
    clearErrorLogs, backupDatabase, listBackups, deleteBackup, pruneOldData,
} = require('../src/db');

after(() => {
    try { closeDb(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('error log: records and reads newest-first', () => {
    recordErrorLog({ tag: 'events', message: 'boom', stack: 'Error: boom\n    at x', timestamp: new Date(Date.now() - 5000).toISOString() });
    recordErrorLog({ tag: 'dashboard', message: 'route fail', timestamp: new Date(Date.now() - 3000).toISOString() });
    recordErrorLog({ tag: 'unhandledRejection', message: 'rejected', timestamp: new Date(Date.now() - 1000).toISOString() });
    const all = getErrorLogs(10);
    assert.strictEqual(all.length, 3);
    assert.strictEqual(all[0].tag, 'unhandledRejection'); // newest first
    assert.ok(all[2].stack.includes('boom'));
});

test('error log: tag filter + counts', () => {
    const ev = getErrorLogs(10, 'events');
    assert.strictEqual(ev.length, 1);
    const counts = getErrorTagCounts(60);
    assert.ok(counts.some(c => c.tag === 'dashboard' && c.count === 1));
});

test('error log: clear by tag then all', () => {
    clearErrorLogs('events');
    assert.strictEqual(getErrorLogs(10, 'events').length, 0);
    clearErrorLogs();
    assert.strictEqual(getErrorLogs(10).length, 0);
});

test('error log: capped at 500 rows', () => {
    for (let i = 0; i < 510; i++) recordErrorLog({ tag: 'flood', message: 'm' + i, timestamp: new Date(Date.now() - i).toISOString() });
    assert.strictEqual(getErrorLogs(1000).length, 500);
    clearErrorLogs();
});

test('backups: create, list, delete round-trip', async () => {
    const b = await backupDatabase();
    assert.ok(b && /^bot-\d{14}\.db$/.test(b.name));
    assert.ok(listBackups().some(x => x.name === b.name));
    assert.ok(deleteBackup(b.name));
    assert.ok(!listBackups().some(x => x.name === b.name));
});

test('backups: invalid names rejected (path-traversal guard)', () => {
    assert.strictEqual(deleteBackup('../../evil.db'), false);
    assert.strictEqual(deleteBackup('bot-notadate.db'), false);
});

test('backups: only newest 7 are kept', async () => {
    const names = new Set();
    for (let i = 0; i < 10; i++) names.add((await backupDatabase()).name);
    assert.strictEqual(names.size, 10);
    assert.strictEqual(listBackups().length, 7);
    for (const b of listBackups()) deleteBackup(b.name);
});

test('db is usable after all that', () => {
    const db = getDb();
    assert.ok(db.prepare('SELECT 1 AS ok').get().ok === 1);
});

test('prune: command_usage older than the window is removed, recent kept', () => {
    const db = getDb();
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    db.prepare('INSERT INTO command_usage (guild_id, command, user_id, used_at) VALUES (?, ?, ?, ?)').run('prune-g', 'ping', 'u1', now - 200 * DAY);
    db.prepare('INSERT INTO command_usage (guild_id, command, user_id, used_at) VALUES (?, ?, ?, ?)').run('prune-g', 'help', 'u1', now - 10 * DAY);
    const res = pruneOldData(now);
    const remaining = db.prepare('SELECT command FROM command_usage WHERE guild_id = ?').all('prune-g').map(r => r.command);
    assert.deepStrictEqual(remaining, ['help']);
    assert.strictEqual(res.commandUsage, 1);
    db.prepare('DELETE FROM command_usage WHERE guild_id = ?').run('prune-g');
});

test('prune: activity_counts inactive rows removed, active + legacy-NULL kept', () => {
    const db = getDb();
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    db.prepare('INSERT OR REPLACE INTO activity_counts (guild_id, user_id, channel_id, message_count, last_seen) VALUES (?, ?, ?, ?, ?)').run('prune-g2', 'stale', 'c1', 5, now - 200 * DAY);
    db.prepare('INSERT OR REPLACE INTO activity_counts (guild_id, user_id, channel_id, message_count, last_seen) VALUES (?, ?, ?, ?, ?)').run('prune-g2', 'active', 'c1', 3, now - 2 * DAY);
    db.prepare('INSERT OR REPLACE INTO activity_counts (guild_id, user_id, channel_id, message_count) VALUES (?, ?, ?, ?)').run('prune-g2', 'legacy', 'c1', 1);
    const res = pruneOldData(now);
    const rows = db.prepare('SELECT user_id FROM activity_counts WHERE guild_id = ?').all('prune-g2').map(r => r.user_id).sort();
    assert.deepStrictEqual(rows, ['active', 'legacy']);
    assert.strictEqual(res.activityCounts, 1);
    db.prepare('DELETE FROM activity_counts WHERE guild_id = ?').run('prune-g2');
});

test('prune: ticket messages of old closed tickets removed, open/recent kept', () => {
    const db = getDb();
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const insTicket = db.prepare('INSERT INTO tickets (id, guild_id, ticket_number, channel_id, creator_id, creator_tag, status, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insTicket.run('t-old', 'prune-g3', 1, 'ch1', 'u1', 'u', 'closed', now - 400 * DAY, now - 400 * DAY);
    insTicket.run('t-open', 'prune-g3', 2, 'ch2', 'u1', 'u', 'open', now, null);
    insTicket.run('t-recent-closed', 'prune-g3', 3, 'ch3', 'u1', 'u', 'closed', now - 30 * DAY, now - 30 * DAY);
    const insMsg = db.prepare('INSERT INTO ticket_messages (ticket_id, author_id, author_tag, content, created_at) VALUES (?, ?, ?, ?, ?)');
    insMsg.run('t-old', 'u1', 'u', 'ancient', now - 400 * DAY);
    insMsg.run('t-open', 'u1', 'u', 'still live', now - 1 * DAY);
    insMsg.run('t-recent-closed', 'u1', 'u', 'freshly closed', now - 30 * DAY);
    const res = pruneOldData(now);
    const remaining = db.prepare('SELECT ticket_id, content FROM ticket_messages WHERE ticket_id IN (?, ?, ?)').all('t-old', 't-open', 't-recent-closed').map(r => r.content).sort();
    assert.deepStrictEqual(remaining, ['freshly closed', 'still live']);
    assert.strictEqual(res.ticketMessages, 1);
    db.prepare('DELETE FROM ticket_messages WHERE ticket_id IN (?, ?, ?)').run('t-old', 't-open', 't-recent-closed');
    db.prepare('DELETE FROM tickets WHERE id IN (?, ?, ?)').run('t-old', 't-open', 't-recent-closed');
});

test('prune: safe to run on a fresh database (no rows, no error)', () => {
    const res = pruneOldData();
    assert.ok(res.commandUsage >= 0 && res.activityCounts >= 0 && res.ticketMessages >= 0);
});

test('backups: verified snapshot includes committed WAL data pinned by an open reader', async () => {
    const Database = require('better-sqlite3');
    const source = getDb();
    const reader = new Database(path.join(tmp, 'bot.db'), { readonly: true });
    try {
        reader.exec('BEGIN');
        reader.prepare('SELECT COUNT(*) FROM command_usage').get();
        source.prepare('INSERT INTO command_usage (guild_id, command, user_id, used_at) VALUES (?, ?, ?, ?)')
            .run('wal-guild', 'help', 'fixture-user', Date.now());
        const pending = backupDatabase();
        assert.strictEqual(backupDatabase(), pending, 'concurrent callers join the same snapshot');
        const backup = await pending;
        assert.ok(backup);
        const restored = new Database(path.join(tmp, 'backups', backup.name), { readonly: true });
        try {
            assert.strictEqual(restored.pragma('quick_check', { simple: true }), 'ok');
            assert.strictEqual(restored.prepare('SELECT command FROM command_usage WHERE guild_id = ?').get('wal-guild').command, 'help');
        } finally {
            restored.close();
        }
        assert.ok(deleteBackup(backup.name));
    } finally {
        reader.close();
    }
});

test('backups: a failed verification leaves the previous snapshot published', async () => {
    const previous = await backupDatabase();
    const db = getDb();
    db.exec('ALTER TABLE command_usage RENAME TO backup_fixture_usage');
    try {
        assert.strictEqual(await backupDatabase(), null);
        assert.deepStrictEqual(listBackups().map(item => item.name), [previous.name]);
        assert.deepStrictEqual(fs.readdirSync(path.join(tmp, 'backups')), [previous.name]);
    } finally {
        db.exec('ALTER TABLE backup_fixture_usage RENAME TO command_usage');
        deleteBackup(previous.name);
    }
});

test('offline restore recovers snapshot data and keeps a rollback copy when the candidate is invalid', async () => {
    const Database = require('better-sqlite3');
    const { verifyBackup } = require('../src/db');
    const db = getDb();
    db.prepare('INSERT INTO command_usage (guild_id, command, user_id, used_at) VALUES (?, ?, ?, ?)')
        .run('restore-guild', 'snapshot', 'fixture-user', Date.now());
    const backup = await backupDatabase();
    assert.ok(backup);
    const restoreDir = fs.mkdtempSync(path.join(tmp, 'restore-'));
    const restoredPath = path.join(restoreDir, 'bot.db');
    const candidate = path.join(restoreDir, 'candidate.db');
    const rollback = path.join(restoreDir, 'rollback.db');
    fs.copyFileSync(path.join(tmp, 'backups', backup.name), candidate);
    assert.equal((await verifyBackup(candidate)).verified, true);
    fs.renameSync(candidate, restoredPath);
    function readCommand() {
        const restored = new Database(restoredPath, { readonly: true });
        try {
            return restored.prepare("SELECT command FROM command_usage WHERE guild_id = 'restore-guild'").get().command;
        } finally { restored.close(); }
    }
    assert.equal(readCommand(), 'snapshot');

    fs.copyFileSync(restoredPath, rollback);
    fs.writeFileSync(candidate, 'invalid sqlite snapshot');
    await assert.rejects(verifyBackup(candidate));
    assert.equal(readCommand(), 'snapshot', 'invalid candidates never replace the installed database');

    const staged = new Database(restoredPath);
    try {
        staged.prepare("UPDATE command_usage SET command = 'post-restore' WHERE guild_id = 'restore-guild'").run();
    } finally { staged.close(); }
    assert.equal(readCommand(), 'post-restore');
    fs.copyFileSync(rollback, restoredPath);
    assert.equal(readCommand(), 'snapshot');
    assert.ok(deleteBackup(backup.name));
});

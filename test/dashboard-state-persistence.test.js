// Sessions and rate-limit windows used to live in process memory, so every
// restart logged the whole dashboard out and handed blocked clients a fresh
// budget. These tests pin them to SQLite and prove the state outlives the
// process by dropping the module cache (a restart) and re-requiring against
// the same on-disk database.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-state-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

// Forget the cached DB handle and dashboard modules so the next require()
// behaves like a fresh process pointed at the same database file.
function freshCore() {
    const dbSuffix = path.join('src', 'db.js');
    const backendPart = path.join('src', 'dashboard-backend');
    for (const key of Object.keys(require.cache)) {
        if (key.endsWith(dbSuffix) || key.includes(backendPart)) delete require.cache[key];
    }
    return require('../src/dashboard-backend/core');
}

after(() => {
    try { require('../src/db').closeDb(); } catch { /* already closed */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function seedSession(core) {
    const token = core.generateSession();
    core.sessions.set(token, {
        method: 'discord',
        userId: 'user-1',
        accessToken: 'a'.repeat(64),
        expiresAt: Date.now() + core.SESSION_TTL_MS,
        createdAt: Date.now(),
    });
    return token;
}

test('a session survives a restart (admins stay logged in)', () => {
    const core = freshCore();
    const token = seedSession(core);
    assert.ok(core.sessions.has(token));

    const restarted = freshCore();
    assert.ok(restarted.sessions.has(token), 'session must outlive the process');

    const session = restarted.sessions.get(token);
    assert.strictEqual(session.method, 'discord');
    assert.strictEqual(session.userId, 'user-1');
    assert.strictEqual(session.accessToken, 'a'.repeat(64));
    assert.ok(session.expiresAt > Date.now(), 'expiry is read back from the store');
    assert.ok(session.createdAt <= Date.now());
});

test('sliding renewal writes through the session handle', () => {
    const core = freshCore();
    const token = seedSession(core);

    // 02-auth renews by assigning to the handle — that must persist, not just
    // mutate an object the store no longer holds.
    core.sessions.get(token).expiresAt = Date.now() - 1000;

    const restarted = freshCore();
    assert.ok(restarted.sessions.get(token).expiresAt < Date.now(), 'renewal must reach the store');
});

test('a sub-minute renewal updates the handle and a real change still persists', () => {
    const core = freshCore();
    const token = seedSession(core);
    const handle = core.sessions.get(token);
    const original = handle.expiresAt;

    // Sliding renewal fires on every request; a tiny nudge is kept in the
    // handle rather than committed. It must still be visible to the caller.
    handle.expiresAt = original + 1000;
    assert.strictEqual(handle.expiresAt, original + 1000, 'the handle must reflect a negligible renewal');

    // A change big enough to matter is written, so it survives.
    handle.expiresAt = original - 10 * 60 * 1000;
    assert.ok(core.sessions.get(token).expiresAt < original, 'a real expiry change must reach the store');
});

test('logout (delete) survives a restart', () => {
    const core = freshCore();
    const token = seedSession(core);
    core.sessions.delete(token);

    assert.ok(!freshCore().sessions.has(token), 'a deleted session must not come back after a restart');
});

test('removeDashUser still purges the revoked user\'s sessions', () => {
    const core = freshCore();
    const mine = seedSession(core);
    const other = core.generateSession();
    core.sessions.set(other, { method: 'discord', userId: 'user-2', expiresAt: Date.now() + 60000, createdAt: Date.now() });

    const { addDashUser, removeDashUser } = require('../src/dashboard');
    addDashUser('user-1', 'test');
    assert.strictEqual(removeDashUser('user-1'), true);

    assert.ok(!core.sessions.has(mine), 'revoked user sessions must be purged');
    assert.ok(core.sessions.has(other), 'other users must be untouched');
});

test('rate-limit counters survive a restart (no free budget after a deploy)', () => {
    const core = freshCore();
    const ip = '203.0.113.9';
    const max = core.DEFAULT_RATE_LIMITS.login.max;

    for (let i = 1; i <= max; i++) {
        assert.strictEqual(core.checkBucketRateLimit('login', ip).allowed, true, `attempt ${i} of ${max}`);
    }
    assert.strictEqual(core.checkBucketRateLimit('login', ip).allowed, false, 'attempt past max is blocked');

    const restarted = freshCore();
    assert.strictEqual(
        restarted.checkBucketRateLimit('login', ip).allowed,
        false,
        'the window must not reset across a restart',
    );
});

test('each bucket keeps its own row and its own counter', () => {
    const core = freshCore();
    const ip = '203.0.113.10';

    for (let i = 0; i < core.DEFAULT_RATE_LIMITS.login.max + 1; i++) core.checkBucketRateLimit('login', ip);

    assert.strictEqual(core.checkBucketRateLimit('login', ip).allowed, false, 'login bucket exhausted');
    assert.strictEqual(core.checkBucketRateLimit('api', ip).allowed, true, 'api bucket untouched');
    assert.strictEqual(core.checkBucketRateLimit('modActions', ip).allowed, true, 'modActions bucket untouched');
});

test('a new window resets the counter once it elapses', () => {
    const core = freshCore();
    const ip = '203.0.113.11';

    for (let i = 0; i < core.DEFAULT_RATE_LIMITS.login.max + 1; i++) core.checkBucketRateLimit('login', ip);
    assert.strictEqual(core.checkBucketRateLimit('login', ip).allowed, false);

    // Age the stored window past its length, exactly as an expired window would.
    require('../src/db').getDb()
        .prepare('UPDATE rate_limit_hits SET window_start = ? WHERE bucket = ? AND ip = ?')
        .run(Date.now() - core.DEFAULT_RATE_LIMITS.login.windowMs - 1000, 'login', ip);

    const afterWindow = core.checkBucketRateLimit('login', ip);
    assert.strictEqual(afterWindow.allowed, true);
    assert.strictEqual(afterWindow.remaining, core.DEFAULT_RATE_LIMITS.login.max - 1, 'a fresh window starts at 1 hit');
});

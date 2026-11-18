// Security tests for dashboard access tokens: the raw token must never reach
// disk (neither in dash_users nor in a session row), a digest must not be
// usable as a credential, and expiry must kill both future logins and the
// sessions a token already created.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection } = require('discord.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-token-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner-user';
// Deterministic shelf life so the expiry assertions are exact rather than
// depending on the shipped default.
process.env.DASHBOARD_TOKEN_DAYS = '30';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

const { createDashboard, setDashboardClient, addDashUser } = require('../src/dashboard');
const {
    sessions, generateSession, hashToken, invalidateRateLimitConfigCache,
} = require('../src/dashboard-backend/core');
const { getDb, closeDb } = require('../src/db');

setDashboardClient({ guilds: { cache: new Collection() }, user: null, ws: { ping: 1 } }, 'test-password');

// This file logs in more than the default 10-per-minute login budget, so widen
// that one bucket rather than diluting the test with sleeps.
getDb().prepare('INSERT OR REPLACE INTO bot_config (key, value) VALUES (?, ?)')
    .run('ratelimit_config', JSON.stringify({ login: { windowMs: 60000, max: 200 } }));
invalidateRateLimitConfigCache();

const app = createDashboard();
const server = http.createServer(app);

function request(method, p, { body, headers } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                ...headers,
            },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

let PORT;

after(async () => {
    closeDb();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function cookieFrom(res) {
    return ((res.headers['set-cookie'] || [''])[0]).split(';')[0];
}

function tokenFrom(res) {
    return cookieFrom(res).replace('session=', '');
}

function sessionRow(token) {
    // Rows are keyed by the digest of the cookie token, never the raw value.
    return getDb().prepare('SELECT * FROM dashboard_sessions WHERE token = ?').get(hashToken(token));
}

function dashUserRow(userId) {
    return getDb().prepare('SELECT * FROM dash_users WHERE user_id = ?').get(userId);
}

async function loginWith(discordId, accessToken) {
    return request('POST', '/api/login', { body: { discordId, accessToken } });
}

test('setup: server listening', async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
});

test('a session row stores the token digest, never the raw token', async () => {
    const { accessToken } = addDashUser('digest-user', 'test');
    const login = await loginWith('digest-user', accessToken);
    assert.strictEqual(login.status, 200);

    const rawSessionToken = tokenFrom(login);
    const row = sessionRow(rawSessionToken);
    assert.ok(row, 'the session row must exist under the digest of its cookie');
    assert.strictEqual(row.token, hashToken(rawSessionToken), 'the cookie token itself must be hashed at rest');
    assert.notStrictEqual(row.token, rawSessionToken, 'the raw session token must not be on disk');
    assert.strictEqual(row.access_token, hashToken(accessToken), 'the session must hold the digest');
    assert.notStrictEqual(row.access_token, accessToken, 'the raw access token must not be on disk');
    assert.strictEqual(dashUserRow('digest-user').access_token, hashToken(accessToken));

    // Nothing anywhere in the row may be usable as the cookie credential.
    const raw = JSON.stringify(row);
    assert.ok(!raw.includes(rawSessionToken), 'no column may echo the session cookie');
    assert.ok(!raw.includes(accessToken), 'no column may echo the dash access token');
});

test('a digest lifted from the database is not a credential', async () => {
    const { accessToken } = addDashUser('digest-theft', 'test');
    const digest = hashToken(accessToken);

    const stolen = await loginWith('digest-theft', digest);
    assert.strictEqual(stolen.status, 401, 'the digest must not log anyone in');

    const real = await loginWith('digest-theft', accessToken);
    assert.strictEqual(real.status, 200, 'the raw token still works');
});

test('an issued token carries an expiry', async () => {
    const before = Date.now();
    const { accessToken, expiresAt } = addDashUser('expiring-user', 'test');
    assert.ok(expiresAt > before, 'a fresh token must expire in the future');
    // 30 days as configured, with slack for the time the call took.
    assert.ok(Math.abs(expiresAt - (before + THIRTY_DAYS_MS)) < 5000, 'expiry must follow DASHBOARD_TOKEN_DAYS');
    const login = await loginWith('expiring-user', accessToken);
    assert.strictEqual(login.status, 200);
});

test('an expired token cannot log in', async () => {
    const { accessToken } = addDashUser('expired-user', 'test');
    getDb().prepare('UPDATE dash_users SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, 'expired-user');

    const login = await loginWith('expired-user', accessToken);
    assert.strictEqual(login.status, 401, 'an expired token must be refused');
});

test('expiry also kills sessions the token already created', async () => {
    const { accessToken } = addDashUser('expires-mid-session', 'test');
    const login = await loginWith('expires-mid-session', accessToken);
    const cookie = cookieFrom(login);

    const before = await request('GET', '/api/status', { headers: { Cookie: cookie } });
    assert.strictEqual(before.status, 200);

    // The token ages out while the session is still live.
    getDb().prepare('UPDATE dash_users SET expires_at = ? WHERE user_id = ?').run(Date.now() - 1000, 'expires-mid-session');

    const after = await request('GET', '/api/status', { headers: { Cookie: cookie } });
    assert.strictEqual(after.status, 401, 'an expired token must not keep a session alive');
});

test('re-issuing a token invalidates the session the old one created', async () => {
    const first = addDashUser('rotating-user', 'test');
    const login = await loginWith('rotating-user', first.accessToken);
    const cookie = cookieFrom(login);

    const before = await request('GET', '/api/status', { headers: { Cookie: cookie } });
    assert.strictEqual(before.status, 200);

    const second = addDashUser('rotating-user', 'test');
    assert.notStrictEqual(second.accessToken, first.accessToken);

    const after = await request('GET', '/api/status', { headers: { Cookie: cookie } });
    assert.strictEqual(after.status, 401, 'the rotated-out token must not keep working');
});

test('last_used_at is recorded on login and not written by session traffic', async () => {
    const { accessToken } = addDashUser('usage-user', 'test');
    assert.strictEqual(dashUserRow('usage-user').last_used_at, null, 'a fresh token starts unused');

    const login = await loginWith('usage-user', accessToken);
    const usedAt = dashUserRow('usage-user').last_used_at;
    assert.ok(usedAt && usedAt <= Date.now(), 'a completed login must stamp last_used_at');

    // Session re-verification runs on every request; it must not write.
    getDb().prepare('UPDATE dash_users SET last_used_at = ? WHERE user_id = ?').run(12345, 'usage-user');
    const res = await request('GET', '/api/status', { headers: { Cookie: cookieFrom(login) } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(
        dashUserRow('usage-user').last_used_at,
        12345,
        'serving a session request must not rewrite last_used_at',
    );
});

test('a pre-upgrade row with no expiry keeps working (no forced lockout)', async () => {
    const raw = 'dash_preupgrade_token_value';
    getDb().prepare(`INSERT OR REPLACE INTO dash_users
        (user_id, added_at, added_by, active, access_token, expires_at, last_used_at)
        VALUES (?, ?, 'test', 1, ?, NULL, NULL)`)
        .run('legacy-user', Date.now(), hashToken(raw));

    assert.strictEqual(dashUserRow('legacy-user').expires_at, null);
    const login = await loginWith('legacy-user', raw);
    assert.strictEqual(login.status, 200, 'an existing token must not be invalidated by the upgrade');
});

test('a legacy plaintext row still upgrades in place on login', async () => {
    const raw = 'dash_plaintext_row_token';
    getDb().prepare(`INSERT OR REPLACE INTO dash_users
        (user_id, added_at, added_by, active, access_token, expires_at, last_used_at)
        VALUES (?, ?, 'test', 1, ?, NULL, NULL)`)
        .run('plaintext-user', Date.now(), raw);

    const login = await loginWith('plaintext-user', raw);
    assert.strictEqual(login.status, 200);
    assert.strictEqual(dashUserRow('plaintext-user').access_token, hashToken(raw), 'the row must rehash itself');
});

test('a session row written before this change still verifies', async () => {
    // Simulate a row created by the previous release, which held the raw token.
    const { accessToken } = addDashUser('old-session-user', 'test');
    const token = generateSession();
    getDb().prepare(`INSERT OR REPLACE INTO dashboard_sessions
        (token, method, user_id, access_token, created_at, expires_at)
        VALUES (?, 'discord', ?, ?, ?, ?)`)
        .run(token, 'old-session-user', accessToken, Date.now(), Date.now() + 3600_000);

    const res = await request('GET', '/api/status', { headers: { Cookie: 'session=' + token } });
    assert.strictEqual(res.status, 200, 'deploying this change must not boot everyone out');

    const upgraded = getDb().prepare('SELECT * FROM dashboard_sessions WHERE token = ?').get(hashToken(token));
    assert.ok(upgraded, 'the legacy row is upgraded to a digest on first use');
    assert.strictEqual(
        getDb().prepare('SELECT * FROM dashboard_sessions WHERE token = ?').get(token),
        undefined,
        'the plaintext row must not linger after the upgrade',
    );
});

test('the dashboard add-user route hands back a token that actually works', async () => {
    // This route used to discard the token it had just minted, so the UI
    // reported "Failed to add user" for a user that had in fact been created
    // (with a token nobody would ever know). The response is the only chance
    // to show it, so this asserts the round trip end to end.
    const pw = await request('POST', '/api/login', { body: { password: 'test-password' } });
    assert.strictEqual(pw.status, 200);
    const ownerCookie = cookieFrom(pw);

    const added = await request('POST', '/api/dash/users/add', {
        body: { userId: '123456789012345678' },
        headers: { Cookie: ownerCookie },
    });
    assert.strictEqual(added.status, 200);
    const payload = JSON.parse(added.body);
    assert.ok(payload.accessToken, 'the raw token must be returned exactly once');
    assert.ok(payload.expiresAt > Date.now(), 'the response must include the expiry');

    const login = await loginWith('123456789012345678', payload.accessToken);
    assert.strictEqual(login.status, 200, 'the token shown to the user must actually log in');

    assert.strictEqual(
        dashUserRow('123456789012345678').access_token,
        hashToken(payload.accessToken),
        'handing back the token must not change how it is stored',
    );

    // The list route is where a leak would be easy to introduce by accident.
    const list = await request('GET', '/api/dash/users', { headers: { Cookie: ownerCookie } });
    assert.strictEqual(list.status, 200);
    assert.ok(!list.body.includes(payload.accessToken), 'listing users must never echo a token');
});

// ── Active sessions panel: listing + per-session revoke ──

async function ownerCookieHeader() {
    const pw = await request('POST', '/api/login', { body: { password: 'test-password' } });
    assert.strictEqual(pw.status, 200);
    return cookieFrom(pw);
}

async function listSessions(cookie) {
    const res = await request('GET', '/api/dash/sessions', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 200);
    return { res, body: JSON.parse(res.body) };
}

test('the session list identifies sessions without exposing a credential', async () => {
    const ownerCookie = await ownerCookieHeader();
    const { accessToken } = addDashUser('session-list-user', 'test');
    const otherToken = tokenFrom(await loginWith('session-list-user', accessToken));

    const { res, body } = await listSessions(ownerCookie);
    assert.strictEqual(body.scoped, false, 'the owner sees every session');
    assert.strictEqual(body.sessions.filter(s => s.current).length, 1, 'exactly one session is the caller\'s');

    for (const s of body.sessions) assert.match(s.id, /^[0-9a-f]{16}$/);

    // The whole point of the derived id: the panel can name a session without
    // the caller ever holding a credential that is useful for anything else.
    assert.ok(!res.body.includes(otherToken), 'the session token must never be returned');
    assert.ok(!res.body.includes(hashToken(otherToken)), 'nor any hash of it');
    assert.ok(!res.body.includes(accessToken), 'nor the dash access token');
});

test('revoking another session ends it and leaves the caller signed in', async () => {
    const ownerCookie = await ownerCookieHeader();
    const { accessToken } = addDashUser('revoke-target', 'test');
    const victimCookie = cookieFrom(await loginWith('revoke-target', accessToken));
    assert.strictEqual((await request('GET', '/api/status', { headers: { Cookie: victimCookie } })).status, 200);

    const { body } = await listSessions(ownerCookie);
    const target = body.sessions.find(s => s.userId === 'revoke-target');
    assert.ok(target, 'the target session must be listed');

    const revoked = await request('POST', '/api/dash/sessions/revoke', {
        body: { id: target.id }, headers: { Cookie: ownerCookie },
    });
    assert.strictEqual(revoked.status, 200);
    assert.strictEqual(JSON.parse(revoked.body).self, false, 'revoking someone else is not a sign-out');

    assert.strictEqual(
        (await request('GET', '/api/status', { headers: { Cookie: victimCookie } })).status,
        401,
        'the revoked session must be dead immediately',
    );
    assert.strictEqual(
        (await request('GET', '/api/status', { headers: { Cookie: ownerCookie } })).status,
        200,
        'the caller must still be signed in',
    );
});

test('a scoped user sees only their own sessions and cannot end anyone else\'s', async () => {
    const { accessToken } = addDashUser('scoped-sessions', 'test');
    const scopedCookie = cookieFrom(await loginWith('scoped-sessions', accessToken));
    const ownerCookie = await ownerCookieHeader();

    const { body } = await listSessions(scopedCookie);
    assert.strictEqual(body.scoped, true);
    assert.ok(body.sessions.length >= 1, 'a scoped user must still see themselves');
    assert.ok(
        body.sessions.every(s => s.userId === 'scoped-sessions'),
        'a scoped user must never see another user\'s sessions',
    );

    // Even with the owner's id in hand, the revoke must be refused.
    const ownerSession = (await listSessions(ownerCookie)).body.sessions.find(s => s.current);
    const attempt = await request('POST', '/api/dash/sessions/revoke', {
        body: { id: ownerSession.id }, headers: { Cookie: scopedCookie },
    });
    assert.strictEqual(attempt.status, 403, 'a scoped user must not end the owner session');
    assert.strictEqual(
        (await request('GET', '/api/status', { headers: { Cookie: ownerCookie } })).status,
        200,
        'the owner session must survive the attempt',
    );
});

test('ending the session you are calling from is a sign-out', async () => {
    const { accessToken } = addDashUser('self-revoke', 'test');
    const cookie = cookieFrom(await loginWith('self-revoke', accessToken));

    const mine = (await listSessions(cookie)).body.sessions.find(s => s.current);
    assert.ok(mine, 'the caller must be able to see their own session');

    const res = await request('POST', '/api/dash/sessions/revoke', { body: { id: mine.id }, headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(JSON.parse(res.body).self, true, 'the UI needs to know to redirect to login');
    assert.strictEqual((await request('GET', '/api/status', { headers: { Cookie: cookie } })).status, 401);
});

test('a malformed or already-gone session id is rejected', async () => {
    const ownerCookie = await ownerCookieHeader();

    const bad = await request('POST', '/api/dash/sessions/revoke', {
        body: { id: 'not-a-session-id' }, headers: { Cookie: ownerCookie },
    });
    assert.strictEqual(bad.status, 400);

    const stale = await request('POST', '/api/dash/sessions/revoke', {
        body: { id: '0123456789abcdef' }, headers: { Cookie: ownerCookie },
    });
    assert.strictEqual(stale.status, 404, 'a session that is already gone must 404, not 500');
});

test('the session routes refuse unauthenticated callers', async () => {
    assert.strictEqual((await request('GET', '/api/dash/sessions')).status, 401);
    assert.strictEqual(
        (await request('POST', '/api/dash/sessions/revoke', { body: { id: '0123456789abcdef' } })).status,
        401,
    );
});

test('a discord session with no matching token is refused', async () => {
    const { accessToken } = addDashUser('no-token-user', 'test');
    const token = generateSession();
    sessions.set(token, {
        method: 'discord',
        userId: 'no-token-user',
        accessToken: accessToken + 'x',
        expiresAt: Date.now() + 3600_000,
        createdAt: Date.now(),
    });

    const res = await request('GET', '/api/status', { headers: { Cookie: 'session=' + token } });
    assert.strictEqual(res.status, 401);
});

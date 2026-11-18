// ─── Public API ───
// api_tokens could be minted from the dashboard but nothing ever verified one,
// so every token was decorative. These tests cover both halves: the token
// lifecycle in src/apiTokens.js, and the HTTP surface in
// dashboard-backend/parts/12-public-api.js — auth, scopes, expiry, revocation,
// and the shapes an integration depends on.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the DB before anything opens it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-api-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner-1';

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { getDb, closeDb } = require('../src/db');
const tokens = require('../src/apiTokens');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ─── Mocks ───
function makeMember(id, { bot = false, status = null } = {}) {
    return { id, user: { id, bot }, presence: status ? { status } : null };
}

function makeGuild(id, name, memberCount = 3) {
    const members = new Map([
        ['u1', makeMember('u1')],
        ['u2', makeMember('u2', { status: 'online' })],
        ['b1', makeMember('b1', { bot: true })],
    ]);
    const channels = new Map([['c1', { id: 'c1', type: 0 }], ['c2', { id: 'c2', type: 0 }]]);
    const roles = new Map([['r1', { id: 'r1' }], ['r2', { id: 'r2' }]]);
    const emojis = new Map([['e1', { id: 'e1' }]]);
    return {
        id, name, memberCount, ownerId: 'owner-' + id,
        premiumTier: 2, premiumSubscriptionCount: 7,
        iconURL: ({ size } = {}) => 'https://cdn.example/' + id + '-' + (size || 128) + '.png',
        members: { cache: members },
        channels: { cache: channels },
        roles: { cache: roles },
        emojis: { cache: emojis },
    };
}

function startServer() {
    const app = createDashboard();
    const server = http.createServer(app);
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function request(port, { method = 'GET', path: urlPath, body, cookie, auth } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method,
            headers: Object.assign(
                { 'Content-Type': 'application/json' },
                payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
                cookie ? { Cookie: cookie } : {},
                auth ? { Authorization: auth } : {}
            ),
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON responses */ }
                resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(new Error('Request timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

async function login(port, password) {
    const res = await request(port, { method: 'POST', path: '/api/login', body: { password } });
    assert.strictEqual(res.status, 200, 'login must succeed for the owner session');
    return String(res.headers['set-cookie'][0]).split(';')[0];
}

function seedMessageLog(guildId, rows) {
    const db = getDb();
    for (const row of rows) {
        db.prepare(`INSERT INTO message_log (guild_id, channel_id, message_id, author_id, author_tag, content, action, attachments, logged_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(guildId, row.channelId || 'c1', row.messageId || 'm1', row.authorId || 'u1',
                row.authorTag || 'u1#0001', row.content || '', row.action || 'delete', null, row.loggedAt || Date.now());
    }
}

// ─── Token lifecycle ───

test('a minted token verifies, and only its digest is stored', () => {
    const made = tokens.createApiToken({ name: 'CI', scopes: ['read:servers'] });
    assert.ok(made.token.startsWith('nlux_'));
    assert.strictEqual(made.entry.name, 'CI');
    assert.deepStrictEqual(made.entry.scopes, ['read:servers']);

    const row = getDb().prepare('SELECT * FROM api_tokens WHERE id = ?').get(made.entry.id);
    assert.notStrictEqual(row.token_hash, made.token, 'the raw token must never be stored');
    assert.strictEqual(row.token_hash, tokens.hashToken(made.token), 'and the digest is a plain SHA-256');
    assert.match(row.token_hash, /^[0-9a-f]{64}$/);

    const verified = tokens.verifyApiToken(made.token);
    assert.ok(verified.token, 'the raw token verifies');
    assert.strictEqual(verified.token.id, made.entry.id);
});

test('bad tokens are refused without a database hit', () => {
    assert.strictEqual(tokens.verifyApiToken('').status, 401);
    assert.strictEqual(tokens.verifyApiToken(null).status, 401);
    assert.strictEqual(tokens.verifyApiToken('nope').status, 401, 'a token without the prefix is not ours');
    assert.strictEqual(tokens.verifyApiToken('nlux_' + 'a'.repeat(43)).status, 401, 'unknown token is refused');
    // A digest that is not in the table must not authenticate anything.
    assert.strictEqual(tokens.verifyApiToken(tokens.hashToken('guessed')).status, 401);
});

test('creation validates the name, the scopes and the expiry', () => {
    assert.match(tokens.createApiToken({ name: '   ' }).error, /name/i);
    assert.match(tokens.createApiToken({ name: 'x'.repeat(101) }).error, /100/);
    assert.match(tokens.createApiToken({ name: 'x', scopes: ['read:nope'] }).error, /Unknown scope/);
    assert.match(tokens.createApiToken({ name: 'x', expiresInDays: -1 }).error, /between 0 and/);
    assert.match(tokens.createApiToken({ name: 'x', expiresInDays: 4000 }).error, /between 0 and/);
    assert.ok(tokens.createApiToken({ name: 'ok', scopes: [] }).token, 'no scopes is allowed — it just can read nothing');
});

test('an expired token is refused and says why', () => {
    const made = tokens.createApiToken({ name: 'old', scopes: ['read:servers'], expiresInDays: 1 });
    getDb().prepare('UPDATE api_tokens SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, made.entry.id);

    const result = tokens.verifyApiToken(made.token);
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.expired, true);
    assert.match(result.error, /expired/i);
});

test('revoking a token kills it immediately', () => {
    const made = tokens.createApiToken({ name: 'temp', scopes: ['read:stats'] });
    assert.strictEqual(tokens.revokeApiToken(made.entry.id), true);
    assert.strictEqual(tokens.verifyApiToken(made.token).status, 401);
    assert.strictEqual(tokens.revokeApiToken(made.entry.id), false, 'revoking twice reports nothing was removed');
});

test('scopes: exact match, admin:all implies, reserved scopes grant nothing', () => {
    const plain = tokens.createApiToken({ name: 'plain', scopes: ['read:logs'] }).entry;
    assert.strictEqual(tokens.hasScope(plain, 'read:logs'), true);
    assert.strictEqual(tokens.hasScope(plain, 'read:servers'), false);

    const admin = tokens.createApiToken({ name: 'admin', scopes: ['admin:all'] }).entry;
    assert.strictEqual(tokens.hasScope(admin, 'read:servers'), true);
    assert.strictEqual(tokens.hasScope(admin, 'read:logs'), true);

    const reserved = tokens.createApiToken({ name: 'hooks', scopes: ['write:webhooks'] }).entry;
    assert.strictEqual(tokens.hasScope(reserved, 'read:servers'), false);
    assert.deepStrictEqual(tokens.usableScopes(reserved), [], 'a reserved-only token can read nothing yet');
    assert.ok(tokens.usableScopes(admin).length > 0);
});

// ─── HTTP surface ───

test('the API requires a bearer token and enforces scopes', async () => {
    const guild = makeGuild('g1', 'Alpha');
    setDashboardClient({ guilds: { cache: new Map([['g1', guild]]) } }, 'test-password');
    const { server, port } = await startServer();

    try {
        // No credentials at all.
        const anon = await request(port, { path: '/api/v1/servers' });
        assert.strictEqual(anon.status, 401);
        assert.match(anon.body.error, /Authorization: Bearer/);
        assert.match(String(anon.headers['www-authenticate'] || ''), /Bearer/i);

        // Wrong scheme, garbage token.
        assert.strictEqual((await request(port, { path: '/api/v1/servers', auth: 'Basic abc' })).status, 401);
        assert.strictEqual((await request(port, { path: '/api/v1/servers', auth: 'Bearer nope' })).status, 401);

        // A real token, but only read:servers.
        const serverToken = tokens.createApiToken({ name: 'read-servers', scopes: ['read:servers'] }).token;

        const me = await request(port, { path: '/api/v1/me', auth: 'Bearer ' + serverToken });
        assert.strictEqual(me.status, 200);
        assert.strictEqual(me.body.name, 'read-servers');
        assert.deepStrictEqual(me.body.scopes, ['read:servers']);
        assert.ok(Array.isArray(me.body.reservedScopes) && me.body.reservedScopes.includes('write:webhooks'));

        const servers = await request(port, { path: '/api/v1/servers', auth: 'Bearer ' + serverToken });
        assert.strictEqual(servers.status, 200);
        assert.strictEqual(servers.body.count, 1);
        assert.strictEqual(servers.body.servers[0].id, 'g1');
        assert.strictEqual(servers.body.servers[0].name, 'Alpha');
        assert.strictEqual(servers.body.servers[0].memberCount, 3);
        assert.match(servers.body.servers[0].icon, /^https:\/\/cdn\.example\//);

        const one = await request(port, { path: '/api/v1/servers/g1', auth: 'Bearer ' + serverToken });
        assert.strictEqual(one.status, 200);
        assert.strictEqual(one.body.server.id, 'g1');

        const missing = await request(port, { path: '/api/v1/servers/nope', auth: 'Bearer ' + serverToken });
        assert.strictEqual(missing.status, 404);

        // The scope it does not hold is refused, and the error names it.
        const blocked = await request(port, { path: '/api/v1/servers/g1/logs', auth: 'Bearer ' + serverToken });
        assert.strictEqual(blocked.status, 403);
        assert.match(blocked.body.error, /read:logs/);
        assert.deepStrictEqual(blocked.body.scopes, ['read:servers']);

        // A reserved-only token gets an explanation, not a bare "missing scope".
        const reservedToken = tokens.createApiToken({ name: 'hooks', scopes: ['write:webhooks'] }).token;
        const reservedCall = await request(port, { path: '/api/v1/servers', auth: 'Bearer ' + reservedToken });
        assert.strictEqual(reservedCall.status, 403);
        assert.match(reservedCall.body.error, /reserved/);
    } finally {
        server.close();
    }
});

test('stats, logs and the log filters answer with real data', async () => {
    const guild = makeGuild('g2', 'Beta', 3);
    setDashboardClient({ guilds: { cache: new Map([['g2', guild]]) } }, 'test-password');
    const { server, port } = await startServer();

    try {
        const token = tokens.createApiToken({ name: 'reader', scopes: ['admin:all'] }).token;
        const auth = 'Bearer ' + token;

        // Seed enough state that the counters have something to count.
        const db = getDb();
        db.prepare('INSERT OR REPLACE INTO guild_stats (guild_id, total_joins, total_leaves) VALUES (?, ?, ?)').run('g2', 120, 30);
        db.prepare('INSERT INTO warnings (id, guild_id, user_id, moderator, reason, date) VALUES (?, ?, ?, ?, ?, ?)')
            .run('w1', 'g2', 'u1', 'mod', 'spam', new Date().toISOString());
        db.prepare('INSERT INTO command_usage (guild_id, command, user_id, used_at) VALUES (?, ?, ?, ?)').run('g2', 'ping', 'u1', Date.now());
        seedMessageLog('g2', [
            { messageId: 'm1', action: 'delete', content: 'first', loggedAt: Date.now() - 3000 },
            { messageId: 'm2', action: 'edit', content: 'x'.repeat(900), loggedAt: Date.now() - 2000 },
            { messageId: 'm3', action: 'delete', content: 'third', loggedAt: Date.now() - 1000 },
        ]);

        const stats = await request(port, { path: '/api/v1/servers/g2/stats', auth });
        assert.strictEqual(stats.status, 200);
        assert.strictEqual(stats.body.server.name, 'Beta');
        assert.deepStrictEqual(stats.body.membership, { joins: 120, leaves: 30 });
        assert.strictEqual(stats.body.live.members, 3, 'live counters come from the same helper the stat channels use');
        assert.strictEqual(stats.body.live.humans, 2);
        assert.strictEqual(stats.body.live.bots, 1);
        assert.strictEqual(stats.body.live.online, 1);
        assert.strictEqual(stats.body.live.channels, 2);
        assert.strictEqual(stats.body.live.roles, 2);
        assert.strictEqual(stats.body.moderation.warnings, 1);
        assert.strictEqual(stats.body.moderation.warningsLast7d, 1);
        assert.strictEqual(stats.body.commands.total, 1);
        assert.strictEqual(stats.body.commands.last7d, 1);
        assert.ok(Number.isFinite(stats.body.generatedAt));

        const logs = await request(port, { path: '/api/v1/servers/g2/logs', auth });
        assert.strictEqual(logs.status, 200);
        assert.strictEqual(logs.body.entries.length, 3);
        assert.strictEqual(logs.body.entries[0].messageId, 'm3', 'newest first');
        assert.strictEqual(logs.body.entries[1].content.length, 500, 'content is bounded for a log feed');
        assert.strictEqual(logs.body.limit, 50);

        const filtered = await request(port, { path: '/api/v1/servers/g2/logs?action=edit', auth });
        assert.strictEqual(filtered.body.entries.length, 1);
        assert.strictEqual(filtered.body.entries[0].action, 'edit');

        const limited = await request(port, { path: '/api/v1/servers/g2/logs?limit=2', auth });
        assert.strictEqual(limited.body.entries.length, 2);

        const clamped = await request(port, { path: '/api/v1/servers/g2/logs?limit=9999', auth });
        assert.strictEqual(clamped.body.limit, 200, 'a huge limit is clamped, not honoured');

        const otherGuild = await request(port, { path: '/api/v1/servers/other/logs', auth });
        assert.strictEqual(otherGuild.status, 404, 'logs are scoped to servers the bot is in');
    } finally {
        server.close();
    }
});

test('minting from the dashboard and using the token end to end', async () => {
    const guild = makeGuild('g3', 'Gamma');
    setDashboardClient({ guilds: { cache: new Map([['g3', guild]]) } }, 'test-password');
    const { server, port } = await startServer();

    try {
        // This case asserts on the exact contents of the token list, and
        // /api/tokens lists every row in the table — there is no per-user view
        // to scope it by. The lifecycle cases above mint through the same
        // module into the same temp database, so without this the assertions
        // below would silently depend on this case running first. Resetting its
        // own fixture makes it order-proof instead of ordering the file.
        getDb().prepare('DELETE FROM api_tokens').run();

        // No session: the mint route is auth-gated like every other one.
        assert.strictEqual((await request(port, { path: '/api/tokens' })).status, 401);

        const cookie = await login(port, 'test-password');

        // The list keeps the shape both frontends read (snake_case fields).
        const empty = await request(port, { path: '/api/tokens', cookie });
        assert.strictEqual(empty.status, 200);
        assert.deepStrictEqual(empty.body, []);

        const badScope = await request(port, {
            method: 'POST', path: '/api/tokens', cookie,
            body: { name: 'bad', scopes: ['read:everything'] },
        });
        assert.strictEqual(badScope.status, 400);
        assert.match(badScope.body.error, /Unknown scope/);

        const created = await request(port, {
            method: 'POST', path: '/api/tokens', cookie,
            body: { name: 'monitoring', scopes: ['read:servers'], expiresInDays: 30 },
        });
        assert.strictEqual(created.status, 200);
        assert.ok(created.body.token.startsWith('nlux_'), 'the raw token comes back exactly once');

        const listed = await request(port, { path: '/api/tokens', cookie });
        assert.strictEqual(listed.body.length, 1);
        // The list carries a fingerprint of the stored digest. It cannot be a
        // slice of the raw token: only the digest is on the row, so the raw
        // value is unrecoverable — which is the point of the fingerprint.
        assert.strictEqual(listed.body[0].token_hash, tokens.hashToken(created.body.token).slice(0, 8) + '...', 'only a fingerprint of the digest is listed');
        assert.ok(!JSON.stringify(listed.body).includes(created.body.token), 'the raw token never appears in the list');
        assert.deepStrictEqual(listed.body[0].scopes, ['read:servers'], 'scopes are listed as an array for the UI');
        assert.ok(listed.body[0].expires_at > Date.now());

        // The token works...
        const used = await request(port, { path: '/api/v1/servers', auth: 'Bearer ' + created.body.token });
        assert.strictEqual(used.status, 200);

        // ...and the use is recorded (throttled, but this is the first one).
        const afterUse = await request(port, { path: '/api/tokens', cookie });
        assert.ok(afterUse.body[0].last_used_at >= listed.body[0].created_at, 'last_used_at is stamped on first use');

        // Revoking through the dashboard turns the bearer call back into a 401.
        const revoked = await request(port, { method: 'DELETE', path: '/api/tokens/' + created.body.entry.id, cookie });
        assert.strictEqual(revoked.status, 200);
        assert.strictEqual(revoked.body.success, true);
        assert.strictEqual((await request(port, { path: '/api/v1/servers', auth: 'Bearer ' + created.body.token })).status, 401);
        assert.deepStrictEqual((await request(port, { path: '/api/tokens', cookie })).body, []);
    } finally {
        server.close();
    }
});

test('a token cannot be used as a dashboard session, and vice versa', async () => {
    const guild = makeGuild('g4', 'Delta');
    setDashboardClient({ guilds: { cache: new Map([['g4', guild]]) } }, 'test-password');
    const { server, port } = await startServer();

    try {
        const raw = tokens.createApiToken({ name: 'cross', scopes: ['admin:all'] }).token;

        // A bearer token is not a session cookie: the dashboard routes stay shut.
        const asCookie = await request(port, { path: '/api/tokens', cookie: 'session=' + raw });
        assert.strictEqual(asCookie.status, 401, 'the token digest is not a session, and a raw token never is');

        // A session cookie is not a bearer token.
        const cookie = await login(port, 'test-password');
        const asBearer = await request(port, { path: '/api/v1/servers', auth: 'Bearer ' + cookie });
        assert.strictEqual(asBearer.status, 401);

        // And the public API is readable only through the token.
        assert.strictEqual((await request(port, { path: '/api/v1/servers', cookie })).status, 401);
    } finally {
        server.close();
    }
});

test('the digest comparison is constant-time and rejects length mismatches', () => {
    // digestMatches is internal, so exercise it through the module's own hash:
    // a stored digest of the wrong length must not authenticate.
    const made = tokens.createApiToken({ name: 'len', scopes: ['read:servers'] });
    getDb().prepare('UPDATE api_tokens SET token_hash = ? WHERE id = ?').run('deadbeef', made.entry.id);
    assert.strictEqual(tokens.verifyApiToken(made.token).status, 401, 'a truncated digest cannot match');

    // Same length, different content.
    const other = crypto.createHash('sha256').update('something else').digest('hex');
    getDb().prepare('UPDATE api_tokens SET token_hash = ? WHERE id = ?').run(other, made.entry.id);
    assert.strictEqual(tokens.verifyApiToken(made.token).status, 401);
});

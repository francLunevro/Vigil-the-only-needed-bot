// Regression tests for the session credential lifecycle:
//   - the dashboard_sessions key (the cookie token) is stored hashed;
//   - changing DASHBOARD_PASSWORD drops every session created under the old
//     secret, even though the rows live in SQLite and survive a restart;
//   - re-applying the same password (an ordinary restart) keeps sessions alive.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-session-hardening-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner-user';

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { hashToken } = require('../src/dashboard-backend/core');
const { getDb, closeDb } = require('../src/db');

const mockClient = { guilds: { cache: new Map() }, user: null, ws: { ping: 1 } };
setDashboardClient(mockClient, 'first-password');

const app = createDashboard();
const server = http.createServer(app);
let PORT;

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

after(async () => {
    closeDb();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function cookieFrom(res) {
    return (res.headers['set-cookie'] || [''])[0].split(';')[0];
}

test('setup: server listening', async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
});

test('changing the dashboard password invalidates existing sessions', async () => {
    const login = await request('POST', '/api/login', { body: { password: 'first-password' } });
    assert.strictEqual(login.status, 200);
    const oldCookie = cookieFrom(login);
    assert.strictEqual((await request('GET', '/api/status', { headers: { Cookie: oldCookie } })).status, 200);

    // Same process, new secret: a restart against a new DASHBOARD_PASSWORD.
    setDashboardClient(mockClient, 'second-password');

    assert.strictEqual(
        (await request('GET', '/api/status', { headers: { Cookie: oldCookie } })).status,
        401,
        'a session created under the old password must be dead',
    );
    assert.strictEqual(
        (await request('POST', '/api/login', { body: { password: 'first-password' } })).status,
        401,
        'the old password itself must stop working',
    );

    const fresh = await request('POST', '/api/login', { body: { password: 'second-password' } });
    assert.strictEqual(fresh.status, 200);
    assert.strictEqual((await request('GET', '/api/status', { headers: { Cookie: cookieFrom(fresh) } })).status, 200);
});

test('a restart with the same password keeps sessions alive', async () => {
    const login = await request('POST', '/api/login', { body: { password: 'second-password' } });
    assert.strictEqual(login.status, 200);
    const cookie = cookieFrom(login);

    // setDashboardClient() runs again on every boot with the unchanged env var.
    setDashboardClient(mockClient, 'second-password');

    assert.strictEqual(
        (await request('GET', '/api/status', { headers: { Cookie: cookie } })).status,
        200,
        'an unchanged password must not sign anyone out',
    );
});

test('the cookie token is not stored anywhere in the session row', async () => {
    const login = await request('POST', '/api/login', { body: { password: 'second-password' } });
    const token = cookieFrom(login).replace('session=', '');

    const rows = getDb().prepare('SELECT * FROM dashboard_sessions').all();
    assert.ok(rows.length > 0);
    for (const row of rows) {
        assert.ok(!JSON.stringify(row).includes(token), 'no row may hold the raw session token');
    }
    assert.ok(
        getDb().prepare('SELECT 1 FROM dashboard_sessions WHERE token = ?').get(hashToken(token)),
        'the row is keyed by the digest so lookup still works',
    );
});

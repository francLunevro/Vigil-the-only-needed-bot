// Tests for GET /api/server/:id/messages/export: returns an RFC-4180 CSV of
// the message log, escapes fields correctly, and respects query filters.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-msg-export-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { getDb, closeDb } = require('../src/db');

const guild = {
    id: 'guild-csv',
    name: 'CSV Guild',
    channels: { cache: new Map([['c1', { name: 'general' }], ['c2', { name: 'mod-log' }]]) },
    roles: { cache: new Map() },
    members: { cache: new Map() },
};
setDashboardClient({ guilds: { cache: new Map([['guild-csv', guild]]) } }, 'test-password');

const app = createDashboard();
const server = http.createServer(app);

function request(method, p, { headers } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
        });
        req.on('error', reject);
        req.end();
    });
}

async function login() {
    const data = JSON.stringify({ password: 'test-password' });
    const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, r => {
            let d = '';
            r.on('data', c => d += c);
            r.on('end', () => resolve(r));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
    assert.strictEqual(res.statusCode, 200);
    return (res.headers['set-cookie'] || [''])[0].split(';')[0];
}

function seed(rows) {
    const db = getDb();
    const stmt = db.prepare('INSERT INTO message_log (guild_id, channel_id, message_id, author_id, author_tag, content, action, attachments, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (const r of rows) stmt.run(...r);
}

let PORT;

after(async () => {
    closeDb();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('setup: server listening + seed message log', async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
    seed([
        ['guild-csv', 'c1', 'm1', 'u1', 'User#1', 'hello, world', 'deleted', JSON.stringify(['https://cdn.discordapp.com/a.png']), Date.now() - 1000],
        ['guild-csv', 'c2', 'm2', 'u2', 'User#2', 'spam link https://discord.gg/x', 'edited', null, Date.now() - 2000],
        ['guild-csv', 'c1', 'm3', 'u1', 'User#1', 'quoted "value" here', 'deleted', null, Date.now() - 3000],
    ]);
});

test('export returns CSV with Content-Disposition attachment', async () => {
    const cookie = await login();
    const res = await request('GET', '/api/server/guild-csv/messages/export?limit=100', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.headers['content-disposition'].includes('attachment'));
    assert.ok(res.headers['content-type'].includes('text/csv'));
    // Header + 3 rows
    const lines = res.body.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 4);
    assert.strictEqual(lines[0], 'id,timestamp,channel,author_tag,author_id,action,content,attachments');
    // CSV quotes fields containing commas or quotes.
    assert.ok(lines.some(l => l.includes('"hello, world"')), 'comma field must be quoted');
    assert.ok(lines.some(l => l.includes('"quoted ""value"" here"')), 'embedded quotes must be doubled');
    // Channel names resolve from the guild.
    assert.ok(lines.some(l => l.includes('general')));
});

test('export respects the action filter', async () => {
    const cookie = await login();
    const res = await request('GET', '/api/server/guild-csv/messages/export?action=deleted&limit=100', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 200);
    const lines = res.body.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 3); // header + 2 deleted rows
    assert.ok(!res.body.includes('edited'), 'edited rows must be filtered out');
});

test('export respects the content search filter', async () => {
    const cookie = await login();
    const res = await request('GET', '/api/server/guild-csv/messages/export?q=spam&limit=100', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 200);
    const lines = res.body.split('\r\n').filter(Boolean);
    assert.strictEqual(lines.length, 2); // header + 1 matching row
    assert.ok(res.body.includes('spam link'));
});

test('export is denied without auth (fail-closed tenant guard)', async () => {
    // Unauthenticated requests to a /api/server/:id route are denied by the
    // tenant guard (fail-closed, zero grants) before requireAuth even runs.
    const res = await request('GET', '/api/server/guild-csv/messages/export?limit=100');
    assert.strictEqual(res.status, 403);
});
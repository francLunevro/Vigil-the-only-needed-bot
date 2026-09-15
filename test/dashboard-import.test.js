// Regression tests for /api/import/all: column names from the payload must
// never be interpolated as raw SQL, unknown columns are dropped instead of
// erroring, and the camelCase keys emitted by /api/export/all round-trip.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-import-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { getDb, closeDb } = require('../src/db');

setDashboardClient({ guilds: { cache: new Map() } }, 'test-password');

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

async function login() {
    const res = await request('POST', '/api/login', { body: { password: 'test-password' } });
    assert.strictEqual(res.status, 200, 'login should succeed');
    return (res.headers['set-cookie'] || [''])[0].split(';')[0];
}

function importAll(cookie, data) {
    return request('POST', '/api/import/all', { body: { data }, headers: { Cookie: cookie } });
}

function countGuild(guildId) {
    return getDb().prepare('SELECT COUNT(*) AS c FROM guild_config WHERE guild_id = ?').get(guildId).c;
}

function tableExists(name) {
    return getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

let PORT;

after(async () => {
    closeDb();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('setup: server listening', async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
});

test('import rejects unauthenticated requests', async () => {
    const res = await importAll(null, { guild_config: [] });
    assert.strictEqual(res.status, 401);
});

test('import accepts export-style camelCase keys (round-trip)', async () => {
    const cookie = await login();
    const res = await importAll(cookie, {
        guildConfigs: [
            { guild_id: '1111111111111111111', default_channel: null, tracked_channels: '[]', log_channels: '{}', log_categories: '{}', prefix: ';', welcome_config: '{}', embed_color: null },
        ],
    });
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(countGuild('1111111111111111111'), 1, 'row should import via camelCase key');
});

test('import still accepts snake_case keys', async () => {
    const cookie = await login();
    const res = await importAll(cookie, {
        guild_config: [
            { guild_id: '2222222222222222222', default_channel: null, tracked_channels: '[]', log_channels: '{}', log_categories: '{}', prefix: ';', welcome_config: '{}', embed_color: null },
        ],
    });
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(countGuild('2222222222222222222'), 1, 'row should import via snake_case key');
});

test('SQL-injection-shaped column keys are neutralized', async () => {
    const cookie = await login();
    const maliciousKey = "guild_id) VALUES ('999'); DROP TABLE bot_config; --";
    const res = await importAll(cookie, {
        guild_config: [
            { [maliciousKey]: 'x' },
        ],
    });
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(countGuild('999'), 0, 'injected row must not be written');
    assert.ok(tableExists('bot_config'), 'DROP TABLE in the payload must not execute');
});

test('junk keys in later rows never reach the SQL', async () => {
    const cookie = await login();
    const maliciousKey = "guild_id) VALUES ('888'); --";
    const res = await importAll(cookie, {
        guild_config: [
            { guild_id: '3333333333333333333', default_channel: null, tracked_channels: '[]', log_channels: '{}', log_categories: '{}', prefix: ';', welcome_config: '{}', embed_color: null },
            { [maliciousKey]: 'x', guild_id: '888' },
        ],
    });
    // Columns come from the first row only, so the junk key is never
    // interpolated — the second row's real guild_id value imports normally.
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(countGuild('3333333333333333333'), 1, 'valid first row should import');
    assert.strictEqual(countGuild('888'), 1, 'real column values still import');
    assert.ok(tableExists('bot_config'), 'junk key must not execute SQL');
});

test('unknown columns are dropped instead of erroring', async () => {
    const cookie = await login();
    const res = await importAll(cookie, {
        guild_config: [
            { guild_id: '4444444444444444444', default_channel: null, tracked_channels: '[]', log_channels: '{}', log_categories: '{}', prefix: ';', welcome_config: '{}', embed_color: null, totally_new_column: 'x' },
        ],
    });
    assert.strictEqual(res.status, 200, res.body);
    assert.strictEqual(countGuild('4444444444444444444'), 1, 'row should import with its real columns');
});
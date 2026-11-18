// /health used to answer `{ status: 'ok', db: 'ok' }` without touching the
// database or consulting the Discord client beyond a truthy check — so a
// container with a broken SQLite file still looked healthy, and a bot that had
// not finished logging in looked identical to a connected one.
//
// These tests pin the two probes and the asymmetric status codes: a dead
// database is a 503, a Discord outage is a 200 'degraded' (restarting the
// process on every reconnect would drop sessions, timers and in-flight work).
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'health-check-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { buildHealth } = require('../src/health');
const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { closeDb } = require('../src/db');

after(async () => {
    closeDb();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('a healthy database and a ready client report ok', () => {
    const report = buildHealth({ client: { isReady: () => true } });
    assert.strictEqual(report.ok, true);
    assert.strictEqual(report.httpStatus, 200);
    assert.deepStrictEqual(
        { status: report.body.status, db: report.body.db, botReady: report.body.botReady },
        { status: 'ok', db: 'ok', botReady: true },
    );
});

test('an unready client is degraded but not a restart signal', () => {
    const report = buildHealth({ client: { isReady: () => false } });
    assert.strictEqual(report.body.status, 'degraded');
    assert.strictEqual(report.body.botReady, false);
    assert.strictEqual(report.body.db, 'ok');
    assert.strictEqual(report.httpStatus, 200, 'a Discord reconnect must not make an orchestrator kill the process');

    // A client that cannot answer at all (still constructing) is not ready.
    assert.strictEqual(buildHealth({ client: {} }).body.botReady, false);
    assert.strictEqual(buildHealth({ client: null }).body.status, 'degraded');
});

test('an unreadable database is an error and a 503', () => {
    const broken = { prepare() { throw new Error('database is locked'); } };
    const report = buildHealth({ db: broken, client: { isReady: () => true } });
    assert.strictEqual(report.ok, false);
    assert.strictEqual(report.body.status, 'error');
    assert.strictEqual(report.body.db, 'error');
    assert.strictEqual(report.httpStatus, 503);
});

test('the real endpoint runs the probes over HTTP', async () => {
    setDashboardClient({ guilds: { cache: new Map() }, isReady: () => false }, 'test-password');
    const app = createDashboard();
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const response = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/health' }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
        }).on('error', reject);
    });

    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));

    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.body.status, 'degraded', 'the endpoint must report the unready client');
    assert.strictEqual(response.body.botReady, false);
    assert.strictEqual(response.body.db, 'ok', 'and still prove the database answered');
    assert.ok(typeof response.body.uptime === 'number');
});

// Hardened rate limiting: with TRUST_PROXY=0, client-supplied X-Forwarded-For
// headers are ignored entirely, so rotating the header can't dodge the per-IP
// login limit. Runs in its own process (node --test isolates test files), so
// the env var doesn't leak into the other dashboard suites.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.TRUST_PROXY = '0';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-ratelimit-spoof-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { closeDb } = require('../src/db');

setDashboardClient({ guilds: { cache: new Map() } }, 'test-password');
const app = createDashboard();
const server = http.createServer(app);

let PORT;

after(async () => {
    closeDb();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function postLogin(spoofedIp) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ password: 'wrong' });
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'X-Forwarded-For': spoofedIp,
            },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

test('spoofed X-Forwarded-For cannot bypass the login rate limit', async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;

    const statuses = [];
    for (let i = 0; i < 11; i++) {
        // Every attempt claims a different client IP — with TRUST_PROXY=0 all
        // of them still count against the real peer (127.0.0.1).
        statuses.push(await postLogin(`203.0.113.${i}`));
    }

    assert.deepStrictEqual(statuses.slice(0, 10), Array(10).fill(401), 'first 10 attempts are processed');
    assert.strictEqual(statuses[10], 429, '11th attempt is blocked despite a fresh spoofed IP');
});
// Default proxy trust ('uniquelocal'): X-Forwarded-For from a loopback/private
// peer is honored, so behind a same-host reverse proxy every real client keeps
// its own rate-limit bucket. Runs in its own process so the TRUST_PROXY=0
// suite can't leak its env var in here.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

delete process.env.TRUST_PROXY;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-proxy-trust-test-'));
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

test('default policy trusts XFF from a loopback peer (proxy mode)', async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;

    const statuses = [];
    for (let i = 0; i < 11; i++) {
        // Each attempt claims a different client IP; the loopback peer is
        // trusted, so each lands in its own rate-limit bucket.
        statuses.push(await postLogin(`198.51.100.${i}`));
    }

    assert.deepStrictEqual(statuses, Array(11).fill(401), 'each spoofed IP is rate-limited separately');
});
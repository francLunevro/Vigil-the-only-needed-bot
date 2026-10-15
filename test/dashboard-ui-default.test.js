// The React dashboard owns `/` in production. These tests pin that routing
// decision at the HTTP level, because it is the one thing a wrong answer
// breaks loudly:
//
//   • `/` and `/login` serve the React entry, and the vanilla frontend stays
//     reachable (and is what DASHBOARD_UI=legacy gets instead)
//   • the SPA fallback answers client-side routes, and can never swallow an
//     API request — a missing /api route still answers as an API
//   • /health and /metrics keep working unauthenticated
//   • old /app links still land on the new root
//
// When web/dist is absent (a plain clone, or the CI test job that doesn't run
// the Vite build) the test stands in a minimal entry of its own and removes it
// again, so the routing contract is covered in both situations.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection } = require('discord.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-ui-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner-user';
delete process.env.DASHBOARD_UI;

const ROOT = path.join(__dirname, '..');
const REACT_DIR = path.join(ROOT, 'web', 'dist');
const REACT_ENTRY = path.join(REACT_DIR, 'index.html');
const FIXTURE_ASSET = path.join(REACT_DIR, 'assets', 'ui-fixture.js');

// Stand in for the Vite build only when there isn't one.
let fixture = false;
if (!fs.existsSync(REACT_ENTRY)) {
    fs.mkdirSync(path.dirname(FIXTURE_ASSET), { recursive: true });
    fs.writeFileSync(REACT_ENTRY, '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8">'
        + '<title>React fixture</title><script type="module" src="/assets/ui-fixture.js"></script></head>'
        + '<body><div id="root"></div></body></html>\n');
    fs.writeFileSync(FIXTURE_ASSET, 'export default 1;\n');
    fixture = true;
}

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { closeDb } = require('../src/db');

const VANILLA_MARKER = '/static/parts/00-entry.mjs';
const reactBuilt = fs.existsSync(REACT_ENTRY);

setDashboardClient({ guilds: { cache: new Collection() }, user: null, ws: { ping: 1 } }, 'test-password');

// Two apps in one process: the default (React at /) and the escape hatch
// (DASHBOARD_UI=legacy). The flag is read when the app is assembled.
const reactApp = createDashboard();
process.env.DASHBOARD_UI = 'legacy';
const legacyApp = createDashboard();
delete process.env.DASHBOARD_UI;

const reactServer = http.createServer(reactApp);
const legacyServer = http.createServer(legacyApp);
let REACT_PORT, LEGACY_PORT;

function request(port, method, p, { body, headers } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path: p, method,
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
    reactServer.closeAllConnections?.();
    legacyServer.closeAllConnections?.();
    await new Promise(resolve => reactServer.close(resolve));
    await new Promise(resolve => legacyServer.close(resolve));
    if (fixture) {
        for (const f of [REACT_ENTRY, FIXTURE_ASSET]) { try { fs.rmSync(f, { force: true }); } catch { /* best effort */ } }
        try { fs.rmdirSync(path.dirname(FIXTURE_ASSET)); } catch { /* leave a real build alone */ }
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('setup: both dashboards listen', async () => {
    await new Promise(resolve => reactServer.listen(0, '127.0.0.1', resolve));
    await new Promise(resolve => legacyServer.listen(0, '127.0.0.1', resolve));
    REACT_PORT = reactServer.address().port;
    LEGACY_PORT = legacyServer.address().port;
    assert.ok(reactBuilt, 'a React build (or the fixture) must be present for these assertions');
});

let cookie;
test('the React bundle owns /login while logged out', async () => {
    const res = await request(REACT_PORT, 'GET', '/login');
    assert.strictEqual(res.status, 200);
    assert.match(res.body, /<div id="root">/, 'login must serve the React entry');
    assert.strictEqual(res.body.includes(VANILLA_MARKER), false, 'login must not serve the vanilla frontend');
});

test('logging in uses the unchanged API and sets a session cookie', async () => {
    const res = await request(REACT_PORT, 'POST', '/api/login', { body: { password: 'test-password' } });
    assert.strictEqual(res.status, 200);
    const setCookie = (res.headers['set-cookie'] || [''])[0];
    assert.match(setCookie, /HttpOnly/, 'the session cookie must stay HttpOnly');
    cookie = setCookie.split(';')[0];
    assert.ok(cookie.includes('=') && cookie.split('=')[1].length > 10, 'expected a session cookie value');
});

test('/ redirects logged-out visitors and serves React when authenticated', async () => {
    const anon = await request(REACT_PORT, 'GET', '/');
    assert.strictEqual(anon.status, 302);
    assert.strictEqual(anon.headers.location, '/login');

    const authed = await request(REACT_PORT, 'GET', '/', { headers: { Cookie: cookie } });
    assert.strictEqual(authed.status, 200);
    assert.match(authed.body, /<div id="root">/, 'the React entry must serve /');
    assert.strictEqual(authed.body.includes(VANILLA_MARKER), false, 'the vanilla frontend must not serve /');
    assert.match(authed.headers['content-type'], /text\/html/);
});

test('the React assets load without a session, straight from /assets', async () => {
    const page = await request(REACT_PORT, 'GET', '/', { headers: { Cookie: cookie } });
    const src = (page.body.match(/src="(\/assets\/[^"]+)"/) || [])[1];
    assert.ok(src, 'the React entry must reference a root-absolute asset (' + src + ')');

    const asset = await request(REACT_PORT, 'GET', src);
    assert.strictEqual(asset.status, 200, 'login needs these while logged out');
    assert.match(asset.headers['content-type'], /javascript/);
    assert.ok(asset.body.length > 0);
});

test('an authenticated deep link boots the SPA instead of 404ing', async () => {
    const authed = await request(REACT_PORT, 'GET', '/servers/guild-aaa', {
        headers: { Cookie: cookie, Accept: 'text/html,application/xhtml+xml' },
    });
    assert.strictEqual(authed.status, 200);
    assert.match(authed.body, /<div id="root">/);

    const anon = await request(REACT_PORT, 'GET', '/servers/guild-aaa', { headers: { Accept: 'text/html' } });
    assert.strictEqual(anon.status, 302);
    assert.strictEqual(anon.headers.location, '/login');
});

test('the SPA fallback never swallows API requests', async () => {
    const missing = await request(REACT_PORT, 'GET', '/api/definitely-not-a-route', { headers: { Cookie: cookie } });
    assert.strictEqual(missing.status, 404, 'unknown API routes stay 404');
    assert.strictEqual(missing.body.includes('<div id="root">'), false, 'the SPA must not answer an API path');

    // A real route, a scoped route and the token API all still work.
    const status = await request(REACT_PORT, 'GET', '/api/status', { headers: { Cookie: cookie } });
    assert.strictEqual(status.status, 200);
    assert.match(status.headers['content-type'], /application\/json/);

    const anonApi = await request(REACT_PORT, 'GET', '/api/servers');
    assert.strictEqual(anonApi.status, 401, 'auth is unchanged: no session, no data');

    const tokenApi = await request(REACT_PORT, 'GET', '/api/v1/servers');
    assert.strictEqual(tokenApi.status, 401, 'the token API still answers as an API');
});

test('/health and /metrics stay open for hosts and scrapers', async () => {
    const health = await request(REACT_PORT, 'GET', '/health');
    assert.strictEqual(health.status, 200);
    assert.strictEqual(JSON.parse(health.body).status, 'ok');

    const metrics = await request(REACT_PORT, 'GET', '/metrics');
    assert.strictEqual(metrics.status, 200);
    assert.match(metrics.body, /bot_uptime_seconds/);
});

test('old /app links land on the new root', async () => {
    const res = await request(REACT_PORT, 'GET', '/app/', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/');
});

test('the vanilla frontend is still installed and served from /static', async () => {
    const entry = await request(REACT_PORT, 'GET', '/static/parts/00-entry.mjs');
    assert.strictEqual(entry.status, 200);
    assert.match(entry.headers['content-type'], /javascript/);

    // And its HTML is intact inside the repo (the backup is a copy of this).
    const html = fs.readFileSync(path.join(ROOT, 'src', 'dashboard', 'index.html'), 'utf8');
    assert.ok(html.includes(VANILLA_MARKER), 'src/dashboard/index.html must still load its entry module');
});

test('DASHBOARD_UI=legacy puts the vanilla dashboard back on /', async () => {
    const anon = await request(LEGACY_PORT, 'GET', '/');
    assert.strictEqual(anon.status, 302);

    const login = await request(LEGACY_PORT, 'POST', '/api/login', { body: { password: 'test-password' } });
    assert.strictEqual(login.status, 200);
    const legacyCookie = (login.headers['set-cookie'] || [''])[0].split(';')[0];

    const root = await request(LEGACY_PORT, 'GET', '/', { headers: { Cookie: legacyCookie } });
    assert.strictEqual(root.status, 200);
    assert.ok(root.body.includes(VANILLA_MARKER), 'legacy mode must serve the vanilla index.html');
    assert.strictEqual(root.body.includes('<div id="root">'), false, 'legacy mode must not serve the React entry');

    const loginPage = await request(LEGACY_PORT, 'GET', '/login');
    assert.strictEqual(loginPage.status, 200);
    assert.ok(loginPage.body.includes('id="loginForm"'), 'legacy mode must serve the vanilla login page');
});

test('a build left over from the old /app base serves the original dashboard, not a blank page', async () => {
    // Upgrading without re-running `npm run build:web` leaves an index.html
    // whose assets point at /app/assets/... — the exact shape of a broken
    // upgrade, so the server must refuse to serve it.
    const entry = path.join(REACT_DIR, 'index.html');
    const kept = entry + '.ui-test-hold';
    fs.renameSync(entry, kept);
    fs.writeFileSync(entry, '<!DOCTYPE html>\n<html lang="en"><head><meta charset="UTF-8">'
        + '<title>stale build</title><script type="module" src="/app/assets/index-old.js"></script></head>'
        + '<body><div id="root"></div></body></html>\n');
    try {
        const staleApp = createDashboard();
        const server = http.createServer(staleApp);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            const login = await request(port, 'POST', '/api/login', { body: { password: 'test-password' } });
            const c = (login.headers['set-cookie'] || [''])[0].split(';')[0];
            const root = await request(port, 'GET', '/', { headers: { Cookie: c } });
            assert.strictEqual(root.status, 200);
            assert.ok(root.body.includes(VANILLA_MARKER), 'a stale build must not be served at /');
            assert.strictEqual(root.body.includes('<div id="root">'), false);
            // And it is not silently served from /app either.
            const old = await request(port, 'GET', '/app/', { headers: { Cookie: c } });
            assert.strictEqual(old.status, 404);
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    } finally {
        fs.rmSync(entry, { force: true });
        fs.renameSync(kept, entry);
    }
});

test('a missing React build falls back to the vanilla dashboard instead of breaking the bot', async () => {
    // The decision is made when the app is assembled, so force it here.
    const entry = path.join(REACT_DIR, 'index.html');
    if (!reactBuilt) return; // fixture already proves the no-build path
    const tmpName = entry + '.ui-test-hold';
    fs.renameSync(entry, tmpName);
    try {
        const noBuildApp = createDashboard();
        const server = http.createServer(noBuildApp);
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
        const port = server.address().port;
        try {
            const login = await request(port, 'POST', '/api/login', { body: { password: 'test-password' } });
            const c = (login.headers['set-cookie'] || [''])[0].split(';')[0];
            const root = await request(port, 'GET', '/', { headers: { Cookie: c } });
            assert.strictEqual(root.status, 200);
            assert.ok(root.body.includes(VANILLA_MARKER), 'no build → vanilla serves /');
            const health = await request(port, 'GET', '/health');
            assert.strictEqual(health.status, 200, 'the bot must stay healthy without a UI build');
        } finally {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
    } finally {
        fs.renameSync(tmpName, entry);
    }
});

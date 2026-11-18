// Route-level tests for the dashboard's management API — custom commands,
// autoresponders, and temporary roles. The service layers are covered in
// customCommands.test.js and tempRoles.test.js; this pins the HTTP surface:
// auth, status codes, and the JSON shapes the frontend parts read.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-custom-cmd-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { closeDb } = require('../src/db');

after(() => {
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
});

function request(port, { method = 'GET', path: urlPath, body, cookie } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method,
            headers: Object.assign(
                { 'Content-Type': 'application/json' },
                payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
                cookie ? { Cookie: cookie } : {}
            ),
        }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON (HTML) responses */ }
                resolve({ status: res.statusCode, headers: res.headers, body: json, raw: data });
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(new Error('Request timeout')); });
        if (payload) req.write(payload);
        req.end();
    });
}

// A collection stub with the methods the dashboard reads (filter/sort/map)
// plus Map-like get/has/size, so the role and channel lists render without
// discord.js being involved.
function collection(items) {
    return {
        get size() { return items.length; },
        filter(fn) { return collection(items.filter(fn)); },
        sort(fn) { return collection(items.slice().sort(fn)); },
        map(fn) { return items.map(fn); },
        get(id) { return items.find((r) => r.id === id) || null; },
        has(id) { return items.some((r) => r.id === id); },
    };
}

function makeGuild(id) {
    const everyone = { id: id + '-everyone', name: '@everyone', managed: false, position: 0, comparePositionTo: () => -1 };
    const muted = {
        id: 'role-muted', name: 'Muted', managed: false, position: 5,
        comparePositionTo(other) { return 5 - (other ? other.position : 0); },
    };
    const tooHigh = {
        id: 'role-high', name: 'Admin', managed: false, position: 200,
        comparePositionTo(other) { return 200 - (other ? other.position : 0); },
    };
    const members = new Map([['u1', {
        id: 'u1',
        user: { id: 'u1', bot: false },
        roles: { added: [], removed: [], async add(rid) { this.added.push(rid); }, async remove(rid) { this.removed.push(rid); } },
    }]]);
    return {
        id,
        name: 'Test Guild',
        roles: { cache: collection([everyone, muted, tooHigh]), everyone },
        members: {
            cache: members,
            fetch: async (userId) => members.get(userId) || null,
            me: {
                permissions: { has: () => true },
                roles: { highest: { id: 'role-bot', position: 100 } },
            },
        },
        channels: { cache: collection([]) },
    };
}

test('custom command + autoresponder routes: auth, validation, CRUD', async () => {
    const guild = makeGuild('g1');
    setDashboardClient({ guilds: { cache: new Map([['g1', guild]]) } }, 'test-password');
    const server = http.createServer(createDashboard());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
        const base = '/api/server/g1';

        // Unauthenticated access is refused before anything else happens. Every
        // /api/server/:id/* route answers 403 here (fail-closed tenant guard
        // runs first), not 401 — pinned so the guard can't be reordered away.
        const anon = await request(port, { path: base + '/custom-commands' });
        assert.strictEqual(anon.status, 403, 'unauthenticated reads are rejected');
        assert.match(anon.body.error, /access to this server/);

        const login = await request(port, { method: 'POST', path: '/api/login', body: { password: 'test-password' } });
        assert.strictEqual(login.status, 200);
        const cookie = String(login.headers['set-cookie'][0]).split(';')[0];

        // ── Custom commands ──
        const empty = await request(port, { path: base + '/custom-commands', cookie });
        assert.strictEqual(empty.status, 200);
        assert.deepStrictEqual(empty.body.commands, []);
        assert.strictEqual(empty.body.prefix, ';', 'the UI shows the real prefix');
        assert.ok(empty.body.maxPerGuild > 0);

        const created = await request(port, {
            method: 'POST', path: base + '/custom-commands', cookie,
            body: { name: 'rules', response: 'Be nice to each other.' },
        });
        assert.strictEqual(created.status, 200);
        assert.strictEqual(created.body.created, true);
        assert.strictEqual(created.body.command.name, 'rules');

        const overwrite = await request(port, {
            method: 'POST', path: base + '/custom-commands', cookie,
            body: { name: 'rules', response: 'Updated.', asEmbed: true },
        });
        assert.strictEqual(overwrite.body.created, false, 'a second write updates');
        assert.strictEqual(overwrite.body.command.asEmbed, true);

        const reserved = await request(port, {
            method: 'POST', path: base + '/custom-commands', cookie,
            body: { name: 'ban', response: 'nope' },
        });
        assert.strictEqual(reserved.status, 400, 'built-in names are rejected');
        assert.match(reserved.body.error, /built-in/);

        const noResponse = await request(port, {
            method: 'POST', path: base + '/custom-commands', cookie,
            body: { name: 'ok', response: '  ' },
        });
        assert.strictEqual(noResponse.status, 400);

        const list = await request(port, { path: base + '/custom-commands', cookie });
        assert.strictEqual(list.body.commands.length, 1);

        const deleted = await request(port, { method: 'DELETE', path: base + '/custom-commands/rules', cookie });
        assert.strictEqual(deleted.status, 200);
        const deletedAgain = await request(port, { method: 'DELETE', path: base + '/custom-commands/rules', cookie });
        assert.strictEqual(deletedAgain.status, 404);

        // ── Autoresponders ──
        const responders = await request(port, { path: base + '/autoresponders', cookie });
        assert.strictEqual(responders.status, 200);
        assert.deepStrictEqual(responders.body.responders, []);
        assert.deepStrictEqual(responders.body.channels, [], 'no client guild means no channel list');
        assert.ok(Array.isArray(responders.body.matchTypes) && responders.body.matchTypes.includes('regex'));

        const badRegex = await request(port, {
            method: 'POST', path: base + '/autoresponders', cookie,
            body: { trigger: '([unclosed', response: 'x', matchType: 'regex' },
        });
        assert.strictEqual(badRegex.status, 400);

        const madeResponder = await request(port, {
            method: 'POST', path: base + '/autoresponders', cookie,
            body: { trigger: 'hello', response: 'Hi {user}!', matchType: 'contains' },
        });
        assert.strictEqual(madeResponder.status, 200);
        const rid = madeResponder.body.responder.id;
        assert.ok(rid);
        assert.strictEqual(madeResponder.body.responder.enabled, true);

        const paused = await request(port, {
            method: 'PATCH', path: base + '/autoresponders/' + rid, cookie, body: { enabled: false },
        });
        assert.strictEqual(paused.status, 200);
        assert.strictEqual(paused.body.responder.enabled, false);

        const missing = await request(port, {
            method: 'PATCH', path: base + '/autoresponders/nope', cookie, body: { enabled: true },
        });
        assert.strictEqual(missing.status, 400, 'unknown IDs come back as validation errors');

        const removed = await request(port, { method: 'DELETE', path: base + '/autoresponders/' + rid, cookie });
        assert.strictEqual(removed.status, 200);
        const removedAgain = await request(port, { method: 'DELETE', path: base + '/autoresponders/' + rid, cookie });
        assert.strictEqual(removedAgain.status, 404);

        // ── Temporary roles ──
        const listing = await request(port, { path: base + '/temp-roles', cookie });
        assert.strictEqual(listing.status, 200);
        assert.deepStrictEqual(listing.body.entries, []);
        assert.deepStrictEqual(listing.body.roles.map((r) => r.id), ['role-high', 'role-muted'],
            '@everyone (and only @everyone) is filtered out of the assignable list');

        const granted = await request(port, {
            method: 'POST', path: base + '/temp-roles', cookie,
            body: { userId: 'u1', roleId: 'role-muted', durationMs: 3600000, reason: 'test mute' },
        });
        assert.strictEqual(granted.status, 200);
        assert.ok(granted.body.entry.expiresAt > Date.now(), 'a real expiry comes back');
        assert.strictEqual(granted.body.extended, false);
        assert.deepStrictEqual(guild.members.cache.get('u1').roles.added, ['role-muted']);

        const tooShort = await request(port, {
            method: 'POST', path: base + '/temp-roles', cookie,
            body: { userId: 'u1', roleId: 'role-muted', durationMs: 1000 },
        });
        assert.strictEqual(tooShort.status, 400, 'under a minute is refused');

        const aboveMe = await request(port, {
            method: 'POST', path: base + '/temp-roles', cookie,
            body: { userId: 'u1', roleId: 'role-high', durationMs: 3600000 },
        });
        assert.strictEqual(aboveMe.status, 400, 'a role above the bot is refused');
        assert.match(aboveMe.body.error, /highest role/);

        const incomplete = await request(port, { method: 'POST', path: base + '/temp-roles', cookie, body: { userId: 'u1' } });
        assert.strictEqual(incomplete.status, 400);

        const stillPending = await request(port, { path: base + '/temp-roles', cookie });
        assert.strictEqual(stillPending.body.entries.length, 1);

        const revoked = await request(port, {
            method: 'DELETE', path: base + '/temp-roles', cookie, body: { userId: 'u1', roleId: 'role-muted' },
        });
        assert.strictEqual(revoked.status, 200);
        assert.deepStrictEqual(guild.members.cache.get('u1').roles.removed, ['role-muted']);

        const revokedAgain = await request(port, {
            method: 'DELETE', path: base + '/temp-roles', cookie, body: { userId: 'u1', roleId: 'role-muted' },
        });
        assert.strictEqual(revokedAgain.status, 400, 'nothing pending any more');
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
    // The dashboard registers process-wide timers; exit explicitly so the test
    // process can't hang (same as test/dashboard.test.js).
    process.exit(0);
});

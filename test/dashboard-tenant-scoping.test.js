// Tenant-boundary regression tests for the dashboard's global (non-guild)
// endpoints and the personal reminders API. A scoped dash user must never see
// another guild's names, counts, stats, activity or another user's reminders,
// and the owner must keep the full view.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection } = require('discord.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-tenant-scope-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner-user';

const { createDashboard, setDashboardClient, addDashUser } = require('../src/dashboard');
const { getDb, closeDb } = require('../src/db');
const { recordJoin } = require('../src/stats');

function makeGuild(id, name, memberCount) {
    return {
        id, name, memberCount, premiumTier: 1, premiumSubscriptionCount: 0,
        iconURL: () => null,
        channels: { cache: new Collection() },
        roles: { cache: new Collection() },
        members: { cache: new Collection() },
    };
}
const guildA = makeGuild('guild-aaa', 'Granted Guild', 10);
const guildB = makeGuild('guild-bbb', 'Secret Guild', 999);
setDashboardClient({
    guilds: { cache: new Collection([['guild-aaa', guildA], ['guild-bbb', guildB]]) },
    user: {
        tag: 'Vigil#0001',
        id: 'bot-user',
        displayAvatarURL: () => null,
    },
    uptime: 60000,
    ws: { ping: 1, status: 0 },
}, 'test-password');

const app = createDashboard();
const server = http.createServer(app);
let PORT;
let scopedCookie;

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
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(d); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: json, raw: d });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function cookieFrom(res) {
    return (res.headers['set-cookie'] || [''])[0].split(';')[0];
}

after(async () => {
    closeDb();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('setup: scoped session and cross-guild fixtures', async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;

    const { accessToken } = addDashUser('tenant-user', 'test');
    getDb().prepare('INSERT OR REPLACE INTO dash_user_guilds (user_id, guild_id, granted_at) VALUES (?, ?, ?)')
        .run('tenant-user', 'guild-aaa', Date.now());
    const login = await request('POST', '/api/login', { body: { discordId: 'tenant-user', accessToken } });
    assert.strictEqual(login.status, 200);
    scopedCookie = cookieFrom(login);

    // Guild A: 2 joins. Guild B: 5 joins — a much louder signal if it leaks.
    for (let i = 0; i < 2; i++) recordJoin('guild-aaa');
    for (let i = 0; i < 5; i++) recordJoin('guild-bbb');

    const insertActivity = getDb().prepare('INSERT INTO bot_activity (type, data, timestamp) VALUES (?, ?, ?)');
    insertActivity.run('test', JSON.stringify({ guildId: 'guild-aaa' }), Date.now());
    insertActivity.run('test', JSON.stringify({ guildId: 'guild-bbb' }), Date.now());
    insertActivity.run('test', JSON.stringify({ note: 'no guild, owner-only' }), Date.now());

    const insertUsage = getDb().prepare('INSERT INTO command_usage (guild_id, command, user_id, used_at) VALUES (?, ?, ?, ?)');
    insertUsage.run('guild-aaa', 'ping', 'user-a1', Date.now());
    insertUsage.run('guild-aaa', 'ping', 'user-a2', Date.now());
    insertUsage.run('guild-bbb', 'secret-command', 'user-b1', Date.now());
});

test('status reports only the granted guild counters and hides host vitals', async () => {
    const res = await request('GET', '/api/status', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.scoped, true);
    assert.strictEqual(res.body.servers, 1, 'only the granted guild is counted');
    assert.strictEqual(res.body.users, '10', 'member total excludes the other guild');
    assert.strictEqual(res.body.memory, null);
    assert.strictEqual(res.body.hostname, null);
    assert.strictEqual(res.body.nodeVersion, null);
});

test('server comparison, aggregate stats and export are scoped to granted guilds', async () => {
    const compare = await request('GET', '/api/analytics/servers/compare', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(compare.status, 200);
    assert.deepStrictEqual(compare.body.servers.map(s => s.id), ['guild-aaa']);
    assert.ok(!compare.raw.includes('Secret Guild'), 'another guild name must never appear');

    const aggregate = await request('GET', '/api/stats/aggregate', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(aggregate.status, 200);
    assert.strictEqual(aggregate.body.serverCount, 1);
    assert.strictEqual(aggregate.body.totalMembers, 10);
    assert.strictEqual(aggregate.body.totalJoins, 2, 'guild B joins must not be counted');

    const exported = await request('GET', '/api/stats/export', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(exported.status, 200);
    assert.deepStrictEqual(Object.keys(exported.body.data), ['guild-aaa']);
});

test('command usage, activity feed and activity timeline withhold other guilds', async () => {
    const stats = await request('GET', '/api/stats/commands', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(stats.status, 200);
    assert.strictEqual(stats.body.total, 2, 'only guild A usage is counted');
    assert.deepStrictEqual(stats.body.perServer.map(r => r.guildName), ['Granted Guild']);
    assert.ok(!stats.raw.includes('secret-command'), 'another guild command must not appear');

    const heatmap = await request('GET', '/api/stats/commands/heatmap', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(heatmap.status, 200);
    assert.deepStrictEqual(Object.keys(heatmap.body), ['ping']);

    const activity = await request('GET', '/api/activity', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(activity.status, 200);
    assert.ok(activity.body.length > 0);
    assert.ok(activity.body.every(e => e.guildId === 'guild-aaa'));
    assert.ok(!activity.raw.includes('Secret Guild'));

    const timeline = await request('GET', '/api/activity/timeline', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(timeline.status, 200);
    assert.ok(timeline.body.length > 0);
    for (const event of timeline.body) {
        assert.strictEqual(JSON.parse(event.data).guildId, 'guild-aaa');
    }
    assert.ok(!timeline.raw.includes('owner-only'), 'rows without a guild are withheld from scoped callers');
});

test('system info stays owner-only', async () => {
    assert.strictEqual((await request('GET', '/api/system', { headers: { Cookie: scopedCookie } })).status, 403);
});

test('a scoped user cannot list or DM another user through the reminders API', async () => {
    // Owner schedules a reminder for someone else.
    const ownerLogin = await request('POST', '/api/login', { body: { password: 'test-password' } });
    assert.strictEqual(ownerLogin.status, 200);
    const ownerCookie = cookieFrom(ownerLogin);
    const ownerMade = await request('POST', '/api/reminders', {
        headers: { Cookie: ownerCookie },
        body: { userId: '900000000000000999', text: 'Owner private reminder', durationMs: 600000 },
    });
    assert.strictEqual(ownerMade.status, 200);

    // Scoped caller asks to remind an arbitrary Discord id: the target in the
    // body is ignored and the reminder belongs to the session user.
    const scopedMade = await request('POST', '/api/reminders', {
        headers: { Cookie: scopedCookie },
        body: { userId: '900000000000000999', text: 'Scoped reminder', durationMs: 600000 },
    });
    assert.strictEqual(scopedMade.status, 200);
    assert.strictEqual(scopedMade.body.reminder.userId, 'tenant-user');

    const listed = await request('GET', '/api/reminders', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(listed.status, 200);
    assert.ok(listed.body.length >= 1);
    assert.ok(listed.body.every(r => r.userId === 'tenant-user'), 'only reminders owned by the caller are listed');
    assert.ok(!listed.raw.includes('Owner private reminder'), 'another user reminder text must not leak');

    // Deleting by id alone is not enough: the row must belong to the caller.
    const ownerList = await request('GET', '/api/reminders', { headers: { Cookie: ownerCookie } });
    const owners = ownerList.body.find(r => r.userId === '900000000000000999');
    assert.ok(owners, 'the owner still sees every pending reminder');
    const denied = await request('DELETE', '/api/reminders/' + owners.id, {
        headers: { Cookie: scopedCookie }, body: { userId: '900000000000000999' },
    });
    assert.strictEqual(denied.status, 404, 'a scoped caller cannot delete a reminder owned by someone else');

    // The owner can still remove it.
    const removed = await request('DELETE', '/api/reminders/' + owners.id, {
        headers: { Cookie: ownerCookie }, body: { userId: '900000000000000999' },
    });
    assert.strictEqual(removed.status, 200);
});

test('a noisy neighbour cannot crowd a scoped caller out of the per-server breakdown', async () => {
    // 35 other-guild commands with three uses each outrank guild A's single
    // two-use command. The breakdown must be scoped in SQL — filtering a global
    // top-30 afterwards would leave the scoped caller with an empty list.
    const insertUsage = getDb().prepare('INSERT INTO command_usage (guild_id, command, user_id, used_at) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 35; i++) {
        for (let j = 0; j < 3; j++) insertUsage.run('guild-bbb', 'noisy-' + i, 'user-b1', Date.now());
    }

    const stats = await request('GET', '/api/stats/commands', { headers: { Cookie: scopedCookie } });
    assert.strictEqual(stats.status, 200);
    assert.deepStrictEqual(stats.body.perServer.map(r => r.guildName), ['Granted Guild']);
    assert.deepStrictEqual(stats.body.perServer.map(r => r.command), ['ping']);
    assert.ok(!stats.raw.includes('noisy-'), 'another guild command must not appear');
});

test('owner sees the full global view', async () => {
    const login = await request('POST', '/api/login', { body: { password: 'test-password' } });
    const cookie = cookieFrom(login);
    const compare = await request('GET', '/api/analytics/servers/compare', { headers: { Cookie: cookie } });
    assert.deepStrictEqual(compare.body.servers.map(s => s.id).sort(), ['guild-aaa', 'guild-bbb']);
    const timeline = await request('GET', '/api/activity/timeline', { headers: { Cookie: cookie } });
    assert.ok(timeline.body.some(e => JSON.parse(e.data).guildId === 'guild-bbb'));
});

test('staff notes enforce route scope and object ownership across case and encoding', async () => {
    const notes = require('../src/staffNotes');
    const local = notes.addNote(guildA.id, 'member-a', 'staff-a', 'Staff A', 'local note');
    const foreign = notes.addNote(guildB.id, 'member-b', 'staff-b', 'Staff B', 'foreign private note');
    const headers = { Cookie: scopedCookie };

    for (const route of ['/api/server/guild-bbb/notes', '/API/Server/guild-bbb/notes', '/api/server/%67uild-bbb/notes']) {
        const response = await request('GET', route, { headers });
        assert.strictEqual(response.status, 403, route);
        assert.ok(!response.raw.includes(foreign.note));
    }
    assert.strictEqual((await request('GET', '/API/Server/guild-aaa/notes')).status, 403);
    const visible = await request('GET', '/API/Server/%67uild-aaa/notes', { headers });
    assert.strictEqual(visible.status, 200);
    assert.deepStrictEqual(visible.body.notes.map(note => note.id), [local.id]);

    const localPath = '/api/server/guild-aaa/notes/';
    assert.strictEqual((await request('DELETE', localPath + foreign.id, { headers })).status, 404);
    assert.strictEqual(notes.getNote(guildA.id, foreign.id), undefined);
    assert.strictEqual(notes.editNote(guildA.id, foreign.id, 'unauthorized edit'), null);
    assert.strictEqual(notes.getNote(guildB.id, foreign.id).note, foreign.note);
    assert.strictEqual(notes.editNote(guildA.id, local.id, 'authorized edit').note, 'authorized edit');
    assert.strictEqual((await request('DELETE', localPath + local.id, { headers })).status, 200);
    assert.strictEqual(notes.getNote(guildA.id, local.id), undefined);
});

test('ticket panel routes reject foreign panels and mismatched type IDs without changing rows', async () => {
    const tickets = require('../src/tickets');
    const local = tickets.createPanel(guildA.id, 'Local panel');
    const sibling = tickets.createPanel(guildA.id, 'Sibling panel');
    const foreign = tickets.createPanel(guildB.id, 'Foreign panel');
    const localType = tickets.createPanelType(local.id, guildA.id, 'Local type');
    const siblingType = tickets.createPanelType(sibling.id, guildA.id, 'Sibling type');
    const foreignType = tickets.createPanelType(foreign.id, guildB.id, 'Foreign type');
    const headers = { Cookie: scopedCookie };
    const base = '/api/server/guild-aaa/tickets/panels/';
    const snapshot = () => ({
        panels: getDb().prepare('SELECT * FROM ticket_panels ORDER BY id').all(),
        types: getDb().prepare('SELECT * FROM ticket_panel_types ORDER BY id').all(),
    });
    const before = snapshot();
    let sends = 0;
    guildA.channels.cache.set('test-channel', {
        id: 'test-channel', guild: guildA,
        send: async () => { sends++; return { id: 'test-message' }; },
    });

    const denied = [
        ['PUT', foreign.id, { name: 'changed' }],
        ['PUT', foreign.id + '/config', { description: 'changed' }],
        ['DELETE', foreign.id],
        ['POST', foreign.id + '/clone', {}],
        ['POST', foreign.id + '/send', { channelId: 'test-channel' }],
        ['PUT', foreign.id + '/count', { count: 12 }],
        ['POST', foreign.id + '/types', { name: 'injected' }],
        ['PUT', foreign.id + '/types/reorder', { typeIds: [foreignType.id] }],
        ['PUT', foreign.id + '/types/' + localType.id, { name: 'changed' }],
        ['PUT', local.id + '/types/' + foreignType.id, { name: 'changed' }],
        ['DELETE', local.id + '/types/' + foreignType.id],
        ['PUT', local.id + '/types/' + siblingType.id, { name: 'changed' }],
        ['DELETE', local.id + '/types/' + siblingType.id],
        ['PUT', local.id + '/types/reorder', { typeIds: [localType.id, siblingType.id] }],
    ];
    for (const [method, route, body] of denied) {
        assert.strictEqual((await request(method, base + route, { headers, body })).status, 404, method + ' ' + route);
    }
    const foreignRoute = '/API/Server/guild-bbb/tickets/panels/' + foreign.id;
    assert.strictEqual((await request('GET', '/API/Server/guild-bbb/tickets', { headers })).status, 403);
    assert.strictEqual((await request('DELETE', foreignRoute, { headers })).status, 403);
    assert.deepStrictEqual(snapshot(), before);
    assert.strictEqual(sends, 0);

    const edit = await request('PUT', base + local.id, { headers, body: { name: 'Renamed' } });
    assert.strictEqual(edit.status, 200);
    assert.strictEqual(edit.body.panel.name, 'Renamed');
    const config = await request('PUT', base + local.id + '/config', { headers, body: { description: 'Updated' } });
    assert.strictEqual(config.status, 200);
    const counter = await request('PUT', base + local.id + '/count', { headers, body: { count: 12 } });
    assert.strictEqual(counter.status, 200);
    assert.strictEqual(tickets.getPanel(local.id, guildA.id).ticket_counter, 12);
    const sent = await request('POST', base + local.id + '/send', { headers, body: { channelId: 'test-channel' } });
    assert.strictEqual(sent.status, 200, sent.raw);
    assert.strictEqual(sends, 1);
    assert.strictEqual(tickets.getPanel(local.id, guildA.id).panel_message_id, 'test-message');
    const created = await request('POST', base + sibling.id + '/types', { headers, body: { name: 'New type' } });
    assert.strictEqual(created.status, 200);
    assert.strictEqual(tickets.getPanelType(created.body.type.id, guildA.id).panel_id, sibling.id);

    const typePath = base + local.id + '/types/' + localType.id;
    const typeEdit = await request('PUT', typePath, { headers, body: { name: 'Renamed type' } });
    assert.strictEqual(typeEdit.status, 200);
    assert.strictEqual(typeEdit.body.type.name, 'Renamed type');
    assert.strictEqual((await request('PUT', base + local.id + '/types/reorder', {
        headers, body: { typeIds: [localType.id] },
    })).status, 200);
    const clone = await request('POST', base + local.id + '/clone', { headers, body: {} });
    assert.strictEqual(clone.status, 200);
    assert.strictEqual(clone.body.panel.types[0].name, 'Renamed type');
    assert.strictEqual((await request('DELETE', typePath, { headers })).status, 200);
    assert.strictEqual((await request('DELETE', base + local.id, { headers })).status, 200);
    assert.strictEqual(tickets.getPanel(local.id, guildA.id), undefined);
    assert.deepStrictEqual(tickets.getPanel(foreign.id, guildB.id), before.panels.find(panel => panel.id === foreign.id));
});

test('parser rejects invalid and oversized JSON and keeps serving requests', async () => {
    const base = 'http://127.0.0.1:' + PORT;
    const headers = { 'Content-Type': 'application/json' };
    const malformed = await fetch(base + '/api/login', { method: 'POST', headers, body: '{' });
    assert.strictEqual(malformed.status, 400);
    assert.deepStrictEqual(await malformed.json(), { error: 'Invalid JSON body' });
    const oversized = await fetch(base + '/api/login', { method: 'POST', headers, body: JSON.stringify('x'.repeat(1024 * 1024)) });
    assert.strictEqual(oversized.status, 413);
    await oversized.text();
    const { gzipSync } = require('node:zlib');
    const compressed = await fetch(base + '/api/login', {
        method: 'POST', headers: { ...headers, 'Content-Encoding': 'gzip' },
        body: gzipSync(JSON.stringify({ password: 'test-password' })),
    });
    assert.strictEqual(compressed.status, 200);
    await compressed.text();
    const importDenied = await fetch(base + '/API/Import/All', { method: 'POST', headers, body: '{' });
    assert.strictEqual(importDenied.status, 401);
    await importDenied.text();
    const emptyLogin = await fetch(base + '/api/login', { method: 'POST' });
    assert.strictEqual(emptyLogin.status, 401);
    await emptyLogin.text();
    assert.strictEqual((await request('GET', '/api/branding')).status, 200);
});

test('role menu routes reject foreign menu IDs before any Discord message access', async () => {
    const menus = require('../src/roleMenus');
    const messageId = 'foreign-menu';
    const localId = 'local-menu';
    const roleId = 'fixture-role';
    assert.ok(menus.createRoleMenu(guildB.id, messageId, 'foreign-channel', 'Foreign'));
    assert.ok(menus.addRoleMenuOption(guildB.id, messageId, roleId, 'private label'));
    assert.ok(menus.createRoleMenu(guildA.id, localId, 'local-channel', 'Local'));
    assert.strictEqual(menus.createRoleMenu(guildA.id, messageId, 'local-channel', 'Duplicate'), false);
    guildA.members.me = { roles: { highest: {} } };
    guildA.roles.cache.set(roleId, { name: 'Fixture role', comparePositionTo: () => -1 });
    let fetches = 0;
    guildA.channels.cache.set('local-channel', { messages: { fetch: async () => { fetches++; return null; } } });
    const headers = { Cookie: scopedCookie };
    const foreign = '/api/server/guild-aaa/role-menus/' + messageId;
    for (const [method, suffix, body] of [
        ['GET', '/options'], ['POST', '/options', { roleId }],
        ['DELETE', '/options', { roleId }], ['PUT', '/publish', { channelId: 'local-channel' }],
        ['DELETE', '', { channelId: 'local-channel' }],
    ]) {
        const response = await request(method, foreign + suffix, { headers, body });
        assert.strictEqual(response.status, 404, method + suffix);
        assert.ok(!response.raw.includes('private label'));
    }
    assert.strictEqual(fetches, 0);
    assert.strictEqual(menus.getRoleMenuOptions(guildB.id, messageId)[0].label, 'private label');
    assert.deepStrictEqual(menus.getRoleMenuOptions(guildA.id, messageId), []);
    const local = '/api/server/guild-aaa/role-menus/' + localId;
    assert.strictEqual((await request('POST', local + '/options', { headers, body: { roleId } })).status, 200);
    assert.strictEqual((await request('GET', local + '/options', { headers })).body.options[0].roleId, roleId);
    assert.strictEqual((await request('DELETE', local + '/options', { headers, body: { roleId } })).status, 200);
    assert.strictEqual((await request('DELETE', local, { headers })).status, 200);
    assert.strictEqual(menus.getRoleMenu(guildA.id, localId), undefined);
});

test('SSE filters current grants, closes revoked and expired sessions, and keeps other streams live', { timeout: 8000 }, async () => {
    const base = 'http://127.0.0.1:' + PORT;
    const { sessions, SESSION_MAX_MS } = require('../src/dashboard-backend/core');
    const ownerLogin = await request('POST', '/api/login', { body: { password: 'test-password' } });
    const ownerCookie = cookieFrom(ownerLogin);
    const controller = new AbortController();
    async function open(cookie) {
        const response = await fetch(base + '/api/events', { headers: { Cookie: cookie }, signal: controller.signal });
        assert.strictEqual(response.status, 200);
        const reader = response.body.getReader();
        assert.match(Buffer.from((await reader.read()).value).toString(), /connected/);
        return reader;
    }
    try {
        const scoped = await open(scopedCookie);
        const owner = await open(ownerCookie);
        const send = (guildId, marker) => global.broadcastDashboard('test', { guildId, marker });
        async function readThrough(reader, marker) {
            let body = '';
            while (!body.includes(marker)) {
                const frame = await reader.read();
                assert.ok(!frame.done, 'stream closed before expected marker');
                body += Buffer.from(frame.value).toString();
            }
            return body;
        }
        send(guildB.id, 'foreign-marker');
        send(guildA.id, 'initial-marker');
        assert.ok(!(await readThrough(scoped, 'initial-marker')).includes('foreign-marker'));

        getDb().prepare('DELETE FROM dash_user_guilds WHERE user_id = ? AND guild_id = ?').run('tenant-user', guildA.id);
        send(guildA.id, 'removed-grant-marker');
        getDb().prepare('INSERT INTO dash_user_guilds (user_id, guild_id, granted_at) VALUES (?, ?, ?)').run('tenant-user', guildB.id, Date.now());
        send(guildB.id, 'new-grant-marker');
        assert.ok(!(await readThrough(scoped, 'new-grant-marker')).includes('removed-grant-marker'));

        const listed = await request('GET', '/api/dash/sessions', { headers: { Cookie: scopedCookie } });
        const id = listed.body.sessions.find(session => session.current).id;
        assert.strictEqual((await request('POST', '/api/dash/sessions/revoke', {
            headers: { Cookie: scopedCookie }, body: { id },
        })).status, 200);
        send(guildB.id, 'revoked-marker');
        assert.strictEqual((await scoped.read()).done, true);
        await readThrough(owner, 'revoked-marker');

        const ownerToken = ownerCookie.slice('session='.length);
        sessions.get(ownerToken).createdAt = Date.now() - SESSION_MAX_MS;
        send(guildA.id, 'expired-marker');
        assert.strictEqual((await owner.read()).done, true);
    } finally {
        controller.abort();
    }
});

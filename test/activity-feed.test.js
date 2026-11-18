// The dashboard activity feed was empty for the wrong reason: bot_activity had
// no writer (global.logBotActivity was defined and never called), so
// /api/activity invented one row per guild from the all-time join counter, with
// `time: Date.now()`. A server that had never recorded a join showed nothing,
// every row looked like it had just happened, and leaves could never appear.
//
// These tests pin the real path: the member event handlers write an event row,
// and the endpoint serves those rows newest-first, scoped per guild.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection } = require('discord.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-feed-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner-user';

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { getDb, closeDb } = require('../src/db');
const { logActivity, getActivity } = require('../src/botActivity');

const guild = {
    id: 'guild-a',
    name: 'Guild A',
    memberCount: 2,
    iconURL: () => null,
    channels: { cache: new Map(), fetch: async () => null },
    roles: { cache: new Collection() },
    members: { cache: new Map(), fetch: async () => null },
    fetchAuditLogs: async () => null,
};
const client = {
    guilds: { cache: new Collection([[guild.id, guild]]) },
    user: { id: 'bot-1', tag: 'Vigil#0001' },
    isReady: () => true,
};
setDashboardClient(client, 'test-password');

const app = createDashboard();
const server = http.createServer(app);
let PORT;
let cookie;

function request(p) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path: p, headers: cookie ? { Cookie: cookie } : {} }, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, body: json });
            });
        }).on('error', reject);
    });
}

function login() {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ password: 'test-password' });
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: '/api/login', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        }, (res) => {
            res.resume();
            res.on('end', () => resolve((res.headers['set-cookie'] || [''])[0].split(';')[0]));
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

after(async () => {
    closeDb();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('setup: server listening + session', async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
    cookie = await login();
    assert.ok(cookie, 'a dashboard session cookie exists');
});

test('the member event handlers write real activity rows', async () => {
    const events = require('../src/events/members');
    const deps = {
        sendLog: () => {},
        recordJoin: () => {},
        recordLeave: () => {},
        formatUptime: (ms) => Math.floor((ms || 0) / 86400000) + 'd',
        truncate: (s) => s,
    };
    const user = {
        id: 'member-1',
        username: 'member_one',
        tag: 'member_one#0001',
        bot: false,
        createdTimestamp: Date.now() - 400 * 86400000,
        displayAvatarURL: () => 'https://cdn.example/a.png',
        toString: () => '<@member-1>',
    };
    const member = {
        id: 'member-1',
        user,
        guild,
        // The leave log enumerates roles with Collection#filter, so the stub
        // must be a real Collection rather than a plain Map.
        roles: { cache: new Collection() },
        permissions: { has: () => false },
        toString: () => '<@member-1>',
    };

    const add = events.find((e) => e.name === 'guildMemberAdd');
    const remove = events.find((e) => e.name === 'guildMemberRemove');
    assert.ok(add && remove);

    await add.execute(deps)(member);
    await remove.execute(deps)(member);

    const rows = getDb().prepare("SELECT type, data FROM bot_activity WHERE data LIKE '%member-1%' ORDER BY id ASC").all();
    assert.deepStrictEqual(rows.map((r) => r.type), ['member_join', 'member_leave']);
    const join = JSON.parse(rows[0].data);
    assert.strictEqual(join.guildId, 'guild-a');
    assert.strictEqual(join.guildName, 'Guild A');
    assert.strictEqual(join.userTag, 'member_one#0001');
});

test('the feed lists a leave even when the guild never recorded a join', async () => {
    // The old endpoint only emitted guilds with totalJoins > 0, so this leave
    // alone produced an empty list. It must be served, with its own timestamp.
    const eventTime = Date.now() - 60000;
    logActivity('member_leave', { guildId: 'guild-a', guildName: 'Guild A', userId: 'member-9', userTag: 'nine#0009' });

    const res = await request('/api/activity');
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    const leave = res.body.find((e) => e.type === 'member_leave' && e.userId === 'member-9');
    assert.ok(leave, 'the leave is in the feed');
    assert.strictEqual(leave.guildName, 'Guild A');
    assert.strictEqual(leave.userTag, 'nine#0009');
    assert.ok(leave.time >= eventTime, 'the event carries its own timestamp, not Date.now() at request time');
    assert.ok(res.body.length >= 3, 'the earlier join/leave rows are served too');
});

test('the feed is newest first and withholds rows without a guild', async () => {
    logActivity('member_join', { guildId: 'guild-a', guildName: 'Guild A', userId: 'member-new' });
    logActivity('unscoped_event', { note: 'no guild here' });

    const res = await request('/api/activity');
    const times = res.body.map((e) => e.time);
    assert.deepStrictEqual(times, [...times].sort((a, b) => b - a), 'newest first');
    assert.ok(res.body.every((e) => e.guildId), 'rows without a guild are not exposed');
    assert.ok(!JSON.stringify(res.body).includes('no guild here'));
});

test('activity is filtered to a scoped dashboard user', () => {
    const scoped = new Set(['guild-a']);
    const visible = getActivity({ scopedGuildIds: scoped });
    assert.ok(visible.length > 0);
    assert.ok(visible.every((e) => e.guildId === 'guild-a'));
    assert.deepStrictEqual(getActivity({ scopedGuildIds: new Set() }), [], 'an empty grant sees nothing');
});

// End-to-end tests for the report and ban-appeal review paths through the real
// dashboard HTTP surface. The existing suites prove the module CRUD and that a
// handler answers 200; these prove the outcome actually lands: the decision is
// persisted with its reviewer/note, the guild's log channel receives the
// announcement, and an id from another server cannot be reviewed or deleted by
// quoting it under a server the caller does have.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-appeals-e2e-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner-user';

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { setLoggerClient } = require('../src/logging');
const { updateGuildConfig } = require('../src/config');
const { closeDb, getDb } = require('../src/db');
const reports = require('../src/reports');
const appeals = require('../src/banAppeals');

const logged = []; // { guildId, channelId, payload }

function makeChannel(guildId, id) {
    return {
        id,
        guildId,
        send: async (payload) => {
            logged.push({ guildId, channelId: id, payload });
            return payload;
        },
    };
}

function makeGuild(id, name) {
    return {
        id,
        name,
        ownerId: 'owner-user',
        iconURL: () => null,
        roles: { cache: new Map() },
        channels: { cache: new Map(), fetch: async () => null },
        members: { cache: new Map(), fetch: async () => null },
    };
}

const guildA = makeGuild('guild-a', 'Guild A');
const guildB = makeGuild('guild-b', 'Guild B');
const logA = makeChannel('guild-a', 'log-a');
const logB = makeChannel('guild-b', 'log-b');
guildA.channels.cache.set('log-a', logA);
guildB.channels.cache.set('log-b', logB);

const client = {
    guilds: { cache: new Map([[guildA.id, guildA], [guildB.id, guildB]]) },
    channels: { cache: new Map([[logA.id, logA], [logB.id, logB]]), fetch: async () => null },
    users: { fetch: async (id) => ({ id, tag: 'User#0001', username: 'User', displayAvatarURL: () => null }) },
    user: { id: 'bot-1', tag: 'Vigil#0001' },
};

setDashboardClient(client, 'test-password');
setLoggerClient(client);
// Both guilds log into the "moderation" category/default channel, which is what
// makes an announcement land somewhere observable.
updateGuildConfig('guild-a', (cfg) => { cfg.logChannelId = 'log-a'; cfg.logCategories = { ...(cfg.logCategories || {}), moderation: true }; return cfg; });
updateGuildConfig('guild-b', (cfg) => { cfg.logChannelId = 'log-b'; cfg.logCategories = { ...(cfg.logCategories || {}), moderation: true }; return cfg; });

const app = createDashboard();
const server = http.createServer(app);
let PORT;
let cookie;

function request(method, p, { body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
            },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(d); } catch { /* not JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: json, raw: d });
            });
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

test('setup: dashboard listening and owner session', async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
    const login = await request('POST', '/api/login', { body: { password: 'test-password' } });
    assert.strictEqual(login.status, 200);
    cookie = (login.headers['set-cookie'] || [''])[0].split(';')[0];
    assert.ok(cookie, 'a dashboard session cookie exists');
});

test('a report filed by the /report path is reviewable and announced', async () => {
    const report = reports.createReport('guild-a', 'reporter-1', 'Reporter#0001', 'target-9', 'Target#0009',
        'harassment', 'the reported message', 'msg-1');
    getDb().prepare("INSERT INTO mod_cases (id, guild_id, case_number, user_id, moderator_id, moderator_tag, action_type, created_at) VALUES (?, ?, 1, 'target-9', 'mod', 'Moderator', 'warn', ?)").run('case-77', report.guild_id, Date.now());

    const queue = await request('GET', '/api/server/guild-a/reports?status=pending');
    assert.strictEqual(queue.status, 200);
    assert.ok(queue.body.reports.some(r => r.id === report.id), 'the report is in the pending queue');

    logged.length = 0;
    const reviewed = await request('PUT', '/api/server/guild-a/reports/' + report.id, {
        body: { status: 'approved', reviewedBy: 'Mod#1', reviewNote: 'action taken', caseId: 'case-77' },
    });
    assert.strictEqual(reviewed.status, 200);
    assert.strictEqual(reviewed.body.success, true);

    const row = reports.getReport(report.guild_id, report.id);
    assert.strictEqual(row.status, 'approved');
    assert.strictEqual(row.reviewed_by, 'owner-user');
    assert.strictEqual(row.review_note, 'action taken');
    assert.strictEqual(row.case_id, 'case-77');
    assert.ok(row.reviewed_at, 'the decision is timestamped');

    // End-to-end: the outcome actually leaves the database.
    const announced = logged.filter(l => l.guildId === 'guild-a');
    assert.strictEqual(announced.length, 1, 'exactly one log embed for this guild');
    const embed = announced[0].payload.embeds[0].data;
    assert.match(embed.title, /Report accepted/);
    assert.ok(JSON.stringify(embed.fields).includes('harassment'), 'the reason travels with the announcement');
});

test('an appeal can be filed, reviewed with a note, and deleted', async () => {
    const created = await request('POST', '/api/server/guild-a/ban-appeals', {
        body: { userId: 'banned-1', userTag: 'Banned#0001', reason: 'spam', message: 'I am sorry, please let me back' },
    });
    assert.strictEqual(created.status, 200);
    const appealId = created.body.appeal.id;
    assert.ok(appealId);

    const pending = await request('GET', '/api/server/guild-a/ban-appeals?status=pending');
    assert.strictEqual(pending.status, 200);
    assert.ok(pending.body.appeals.some(a => a.id === appealId));

    const stats = await request('GET', '/api/server/guild-a/ban-appeals/stats');
    assert.strictEqual(stats.body.pending, 1);

    const approved = await request('PUT', '/api/server/guild-a/ban-appeals/' + appealId, {
        body: { status: 'approved', reviewedBy: 'Mod#1', reviewNote: 'second chance' },
    });
    assert.strictEqual(approved.status, 200);

    const row = appeals.getBanAppeal(guildA.id, appealId);
    assert.strictEqual(row.status, 'approved');
    assert.strictEqual(row.reviewed_by, 'owner-user');
    assert.strictEqual(row.review_note, 'second chance');
    assert.ok(row.reviewed_at);

    const removed = await request('DELETE', '/api/server/guild-a/ban-appeals/' + appealId);
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(appeals.getBanAppeal(guildA.id, appealId), undefined);
    assert.strictEqual((await request('DELETE', '/api/server/guild-a/ban-appeals/' + appealId)).status, 404);
});

test('a report from another guild cannot be reviewed or deleted through this one', async () => {
    const foreign = reports.createReport('guild-b', 'reporter-2', 'Reporter#0002', 'target-8', 'Target#0008', 'off-topic');

    const put = await request('PUT', '/api/server/guild-a/reports/' + foreign.id, {
        body: { status: 'approved', reviewedBy: 'Mod#1' },
    });
    assert.strictEqual(put.status, 404, 'the row must belong to :id, not just exist');

    const del = await request('DELETE', '/api/server/guild-a/reports/' + foreign.id);
    assert.strictEqual(del.status, 404);

    const intact = reports.getReport(foreign.guild_id, foreign.id);
    assert.ok(intact, 'the other guild report still exists');
    assert.strictEqual(intact.status, 'pending', 'and its status was not changed');
});

test('an appeal from another guild cannot be reviewed or deleted through this one', async () => {
    const foreign = appeals.createBanAppeal('guild-b', 'banned-2', 'Banned#0002', 'reason', 'let me in');

    const put = await request('PUT', '/api/server/guild-a/ban-appeals/' + foreign.id, {
        body: { status: 'approved', reviewedBy: 'Mod#1' },
    });
    assert.strictEqual(put.status, 404);

    const del = await request('DELETE', '/api/server/guild-a/ban-appeals/' + foreign.id);
    assert.strictEqual(del.status, 404);

    const intact = appeals.getBanAppeal(foreign.guild_id, foreign.id);
    assert.ok(intact, 'the other guild appeal still exists');
    assert.strictEqual(intact.status, 'pending');
    assert.strictEqual(intact.reviewed_by, null);
});

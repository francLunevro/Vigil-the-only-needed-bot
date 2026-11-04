const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-p103-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.TRUST_PROXY = '0';
process.env.OWNER_ID = '90001';
process.env.DASHBOARD_STAFF_CAPABILITIES = '{"10001":["records:read"],"10002":["records:write"]}';

const { createDashboard, setDashboardClient, addDashUser } = require('../src/dashboard');
const { getDb, closeDb } = require('../src/db');
const { fetchAvatar, MAX_IMAGE_BYTES } = require('../src/imageSafety');
const reports = require('../src/reports');
const appeals = require('../src/banAppeals');

let base, server, owner, reader, writer;
let avatars = 0;
const guilds = new Map(['guild-a', 'guild-b'].map(id => [id, { id, members: { cache: new Map() } }]));
setDashboardClient({ guilds: { cache: guilds }, user: { setAvatar: async () => { avatars++; } } }, 'fixture-pass');

async function call(url, method = 'GET', cookie, body, headers = {}) {
    if (cookie) headers.Cookie = cookie;
    if (body && !(body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers, body });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text.startsWith('{') ? JSON.parse(text) : text };
}

async function login(payload) {
    const response = await call('/api/login', 'POST', null, payload);
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
}

before(async () => {
    const app = createDashboard();
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
    owner = await login({ password: 'fixture-pass' });
    const grant = getDb().prepare('INSERT INTO dash_user_guilds (user_id, guild_id, granted_at) VALUES (?, ?, ?)');
    async function staff(userId) {
        const { accessToken } = addDashUser(userId, 'fixture');
        grant.run(userId, 'guild-a', Date.now());
        return login({ discordId: userId, accessToken });
    }
    reader = await staff('10001');
    writer = await staff('10002');
});

after(async () => {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('staff capabilities distinguish reading and writing and cannot widen guild scope', async () => {
    const a = reports.createReport('guild-a', 'reporter', 'R', 'target', 'T', 'A');
    const b = reports.createReport('guild-b', 'reporter', 'R', 'target', 'T', 'B');
    const appeal = appeals.createBanAppeal('guild-b', 'target', 'T', 'B', 'private');
    assert.equal((await call('/API/Server/guild-a/REPORTS', 'GET', reader)).status, 200);
    assert.equal((await call('/api/server/guild-a/reports', 'GET', writer)).status, 403);
    assert.equal((await call('/api/server/guild-b/reports', 'GET', reader)).status, 403);
    assert.equal((await call('/API/Server/guild-a/reports/' + a.id, 'PUT', reader, { status: 'approved' })).status, 403);
    assert.equal((await call('/api/server/guild-a/reports/' + b.id, 'DELETE', writer)).status, 404);
    assert.equal((await call('/api/server/guild-a/ban-appeals/' + appeal.id, 'PUT', writer, { status: 'approved' })).status, 404);
    assert.equal(reports.getReport('guild-a', a.id).status, 'pending');
    assert.equal(reports.getReport('guild-b', b.id).status, 'pending');
    assert.equal(appeals.getBanAppeal('guild-b', appeal.id).status, 'pending');

    assert.equal(reports.updateReportStatus('guild-a', b.id, 'approved'), false);
    assert.equal(reports.deleteReport('guild-a', b.id), false);
    assert.equal(appeals.updateBanAppealStatus('guild-a', appeal.id, 'approved'), false);
    assert.equal(appeals.deleteBanAppeal('guild-a', appeal.id), false);

    getDb().prepare("INSERT INTO mod_cases (id, guild_id, case_number, user_id, moderator_id, moderator_tag, action_type, created_at) VALUES ('foreign-case', 'guild-b', 1, 'target', 'mod', 'Mod', 'warn', ?)").run(Date.now());
    const endpoint = '/api/server/guild-a/reports/' + a.id;
    assert.equal((await call(endpoint, 'PUT', writer, { status: 'approved', caseId: 'foreign-case' })).status, 404);
    assert.equal(reports.getReport('guild-a', a.id).status, 'pending');
    assert.equal((await call(endpoint, 'PUT', writer, { status: 'approved', reviewedBy: 'spoofed' })).status, 200);
    assert.equal(reports.getReport('guild-a', a.id).reviewed_by, '10002');
});

test('avatar rejects unsafe URLs before fetching and only returns sanitized image bytes', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
    let attempts = 0;
    const mock = async (target, options) => {
        attempts++;
        assert.equal(target.hostname, 'cdn.discordapp.com');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal);
        return new Response(png);
    };
    for (const url of ['http://cdn.discordapp.com/attachments/a/b', 'https://127.0.0.1/a',
        'https://cdn.discordapp.com.evil.test/attachments/a/b', 'https://cdn.discordapp.com@127.0.0.1/a',
        'https://cdn.discordapp.com:444/attachments/a/b', 'file:///etc/passwd']) {
        await assert.rejects(fetchAvatar(url, mock));
    }
    assert.equal(attempts, 0);
    const valid = 'https://cdn.discordapp.com/attachments/a/b';
    assert.equal((await sharp(await fetchAvatar(valid, mock)).metadata()).width, 2);
    await assert.rejects(fetchAvatar(valid, async () => new Response(new Uint8Array(MAX_IMAGE_BYTES + 1))), /exceeds/);
    await assert.rejects(fetchAvatar(valid, async () => new Response(null, { status: 302 })), /download/);
    assert.equal((await call('/api/bot/avatar', 'POST', owner, { url: 'https://169.254.169.254/latest' })).status, 400);
    assert.equal(avatars, 0);
});

test('uploads reject disguised files and enforce quota while accepting and serving a clean image', async () => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
    function form(bytes) {
        const data = new FormData();
        data.append('background', new Blob([bytes], { type: 'image/png' }), 'fixture.png');
        return data;
    }
    assert.equal((await call('/api/upload', 'POST', reader, form(png))).status, 403);
    assert.equal((await call('/api/upload', 'POST', owner, form(Buffer.from('<script>fake</script>')))).status, 400);
    assert.equal((await call('/api/upload', 'POST', owner, form(png.subarray(0, 16)))).status, 400);
    assert.deepEqual(fs.readdirSync(process.env.UPLOADS_DIR), []);
    const good = await call('/api/upload', 'POST', owner, form(png));
    assert.equal(good.status, 200);
    const served = await fetch(base + good.body.url);
    assert.equal(served.status, 200);
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await sharp(Buffer.from(await served.arrayBuffer())).metadata()).format, 'png');

    const quota = path.join(process.env.UPLOADS_DIR, 'quota-fixture');
    fs.writeFileSync(quota, '');
    fs.truncateSync(quota, 10 * MAX_IMAGE_BYTES);
    assert.equal((await call('/api/upload', 'POST', owner, form(png))).status, 413);
    assert.equal((await call('/uploads/quota-fixture')).status, 404);
    assert.equal(fs.readdirSync(process.env.UPLOADS_DIR).length, 2);
});

test('direct-mode ignores spoofed proto and rejects trust-all proxy configuration', async () => {
    const response = await call('/api/login', 'POST', null, { password: 'fixture-pass' }, { 'X-Forwarded-Proto': 'https', 'X-Request-ID': 'spoofed' });
    assert.equal(response.status, 200);
    assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure/i);
    assert.notEqual(response.headers.get('x-request-id'), 'spoofed');
    process.env.TRUST_PROXY = '1';
    try { assert.throws(createDashboard, /explicit proxy IPs/); }
    finally { process.env.TRUST_PROXY = '0'; }
});

test('giveaway mutations require installation owner and rejected actions leave the row unchanged', async () => {
    const { createGiveaway, getGiveaway } = require('../src/giveaways');
    const giveaway = createGiveaway({
        guildId: 'guild-b', channelId: 'fixture-channel', prize: 'Fixture',
        durationMs: 30000, hostId: 'fixture-host',
    });
    for (const action of ['end', 'cancel', 'reroll']) {
        assert.equal((await call('/api/giveaways/' + action, 'POST', writer, { id: giveaway.id })).status, 403);
        assert.deepEqual(getGiveaway(giveaway.id), giveaway);
    }
    assert.equal((await call('/api/giveaways/cancel', 'POST', owner, { id: giveaway.id })).status, 200);
    assert.equal(getGiveaway(giveaway.id).status, 'cancelled');
    assert.equal((await call('/api/giveaways/cancel', 'POST', owner, { id: giveaway.id })).status, 400);
});

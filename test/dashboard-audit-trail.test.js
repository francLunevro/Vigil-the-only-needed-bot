// Audit trail coverage for dashboard writes. A successful mutation records one
// audit_trail row; an unauthorized, cross-tenant or failed write records none.
// The rows must carry the actor and scope but never a token value.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Collection } = require('discord.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-audit-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner-user';

const { createDashboard, setDashboardClient, addDashUser } = require('../src/dashboard');
const { getDb, closeDb } = require('../src/db');
const giveaways = require('../src/giveaways');

function makeGuild(id, name) {
    return {
        id, name, memberCount: 10, premiumTier: 1, premiumSubscriptionCount: 0,
        iconURL: () => null,
        channels: { cache: new Collection() },
        roles: { cache: new Collection() },
        members: { cache: new Collection() },
    };
}
const guildA = makeGuild('guild-aaa', 'Granted Guild');
const guildB = makeGuild('guild-bbb', 'Other Guild');
setDashboardClient({
    guilds: { cache: new Collection([['guild-aaa', guildA], ['guild-bbb', guildB]]) },
    user: null,
    ws: { ping: 1 },
}, 'test-password');

const server = http.createServer(createDashboard());
let PORT;
let scopedCookie = null;

function request(method, p, { body, cookie } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                ...(cookie ? { Cookie: cookie } : {}),
            },
        }, (res) => {
            let d = '';
            res.on('data', (c) => { d += c; });
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

function auditCount(action) {
    return getDb().prepare('SELECT COUNT(*) AS n FROM audit_trail WHERE action = ?').get(action).n;
}

function auditRows(action) {
    return getDb().prepare('SELECT * FROM audit_trail WHERE action = ? ORDER BY id ASC').all(action);
}

after(async () => {
    closeDb();
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('setup: server listening', async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
});

test('owner token create writes one entry with id and scopes, never the token value', async () => {
    const login = await request('POST', '/api/login', { body: { password: 'test-password' } });
    const cookie = cookieFrom(login);
    const before = auditCount('token.create');

    const res = await request('POST', '/api/tokens', {
        cookie, body: { name: 'ci-bot', scopes: ['read:stats'] },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(auditCount('token.create') - before, 1, 'one entry for one successful write');

    const [row] = auditRows('token.create').slice(-1);
    assert.strictEqual(row.type, 'token');
    assert.strictEqual(row.user_id, 'owner-user', 'actor is the owner session');
    assert.strictEqual(row.guild_id, null, 'token management is not server-scoped');
    const details = JSON.parse(row.details);
    assert.strictEqual(details.tokenId, res.body.entry.id);
    assert.strictEqual(details.name, 'ci-bot');
    assert.deepStrictEqual(details.scopes, ['read:stats']);
    assert.ok(!row.details.includes(res.body.token), 'the raw token must never reach the audit row');
    assert.ok(!row.details.includes('nlux_'), 'no token-shaped value in the audit row');
});

test('failed token create (missing name) writes no entry', async () => {
    const login = await request('POST', '/api/login', { body: { password: 'test-password' } });
    const cookie = cookieFrom(login);
    const before = auditCount('token.create');

    const res = await request('POST', '/api/tokens', { cookie, body: { name: '', scopes: [] } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(auditCount('token.create') - before, 0);
});

test('unauthorized token create by a non-owner dash user is refused and writes no entry', async () => {
    const { accessToken } = addDashUser('audit-scoped', 'test');
    const login = await request('POST', '/api/login', { body: { discordId: 'audit-scoped', accessToken } });
    assert.strictEqual(login.status, 200);
    const cookie = cookieFrom(login);
    const before = auditCount('token.create');

    const res = await request('POST', '/api/tokens', { cookie, body: { name: 'sneaky', scopes: ['admin:all'] } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(auditCount('token.create') - before, 0);
});

test('owner token revoke writes one entry; revoking an unknown id writes none', async () => {
    const login = await request('POST', '/api/login', { body: { password: 'test-password' } });
    const cookie = cookieFrom(login);
    const created = await request('POST', '/api/tokens', { cookie, body: { name: 'to-revoke', scopes: [] } });
    assert.strictEqual(created.status, 200);

    const beforeRevoke = auditCount('token.revoke');
    const revoked = await request('DELETE', '/api/tokens/' + created.body.entry.id, { cookie });
    assert.strictEqual(revoked.body.success, true);
    assert.strictEqual(auditCount('token.revoke') - beforeRevoke, 1);

    const beforeMiss = auditCount('token.revoke');
    const missing = await request('DELETE', '/api/tokens/999999', { cookie });
    assert.strictEqual(missing.body.success, false);
    assert.strictEqual(auditCount('token.revoke') - beforeMiss, 0, 'a no-op revoke is not a change');
});

test('owner server write records one entry scoped to that guild', async () => {
    const login = await request('POST', '/api/login', { body: { password: 'test-password' } });
    const cookie = cookieFrom(login);
    const before = auditCount('prefix.update');

    const res = await request('POST', '/api/server/guild-aaa/prefix', { cookie, body: { prefix: '!' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.prefix, '!');
    assert.strictEqual(auditCount('prefix.update') - before, 1);

    const [row] = auditRows('prefix.update').slice(-1);
    assert.strictEqual(row.type, 'config');
    assert.strictEqual(row.guild_id, 'guild-aaa');
    assert.strictEqual(row.user_id, 'owner-user');
    assert.deepStrictEqual(JSON.parse(row.details), { prefix: '!' });
});

test('failed server write (invalid prefix) writes no entry', async () => {
    const login = await request('POST', '/api/login', { body: { password: 'test-password' } });
    const cookie = cookieFrom(login);
    const before = auditCount('prefix.update');

    const res = await request('POST', '/api/server/guild-aaa/prefix', { cookie, body: { prefix: '' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(auditCount('prefix.update') - before, 0);
});

test('cross-tenant write to an ungranted server is refused and writes no entry', async () => {
    // addDashUser clears existing grants, so the grant is written after it.
    const { accessToken } = addDashUser('audit-scoped', 'test');
    getDb().prepare("INSERT OR REPLACE INTO dash_user_guilds (user_id, guild_id, granted_at) VALUES ('audit-scoped', 'guild-aaa', 1)").run();
    const login = await request('POST', '/api/login', { body: { discordId: 'audit-scoped', accessToken } });
    assert.strictEqual(login.status, 200);
    scopedCookie = cookieFrom(login);
    const cookie = scopedCookie;
    const before = auditCount('prefix.update');

    const res = await request('POST', '/api/server/guild-bbb/prefix', { cookie, body: { prefix: '?' } });
    assert.strictEqual(res.status, 403, 'tenant guard refuses a server the user was not granted');
    assert.strictEqual(auditCount('prefix.update') - before, 0);
});

test('granted scoped user write records the discord user as actor on the granted guild', async () => {
    const cookie = scopedCookie;
    assert.ok(cookie, 'the scoped session from the previous test is reused');
    const before = auditCount('log.config');

    const res = await request('POST', '/api/server/guild-aaa/log/config', {
        cookie, body: { category: 'message', enabled: true },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(auditCount('log.config') - before, 1);

    const [row] = auditRows('log.config').slice(-1);
    assert.strictEqual(row.user_id, 'audit-scoped');
    assert.strictEqual(row.guild_id, 'guild-aaa');
    assert.deepStrictEqual(JSON.parse(row.details), { category: 'message', enabled: true, trackedChannels: null });
});

// ── Dashboard access management ──
// Granting or revoking dashboard access is the most security-relevant write
// this panel performs, so each of the three owner-only routes has to leave a
// trace — and only when it actually changed something.
//
// These cases share one owner session: the login bucket allows 10 attempts per
// minute per IP, and a fresh sign-in per case would spend that budget rather
// than test anything.
let ownerCookiePromise = null;
function ownerCookie() {
    if (!ownerCookiePromise) {
        ownerCookiePromise = request('POST', '/api/login', { body: { password: 'test-password' } })
            .then((res) => { assert.strictEqual(res.status, 200, 'owner login succeeds'); return cookieFrom(res); });
    }
    return ownerCookiePromise;
}

test('owner dash-user add writes one entry with the target id, never the one-time token', async () => {
    const cookie = await ownerCookie();
    const before = auditCount('dash.user.add');

    const res = await request('POST', '/api/dash/users/add', { cookie, body: { userId: '555000000000000055' } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(auditCount('dash.user.add') - before, 1, 'one entry for one successful grant');

    const [row] = auditRows('dash.user.add').slice(-1);
    assert.strictEqual(row.type, 'access');
    assert.strictEqual(row.user_id, 'owner-user', 'actor is the owner session');
    assert.strictEqual(row.guild_id, null, 'access grants are not server-scoped');
    assert.deepStrictEqual(JSON.parse(row.details), { targetUserId: '555000000000000055' });
    assert.ok(!row.details.includes(res.body.accessToken), 'the one-time access token must never reach the audit row');
    assert.ok(!row.details.includes('dash_'), 'no token-shaped value in the audit row');
});

test('dash-user add refused for a non-owner writes no entry', async () => {
    assert.ok(scopedCookie, 'the scoped session from the earlier test is reused');
    const before = auditCount('dash.user.add');

    const res = await request('POST', '/api/dash/users/add', { cookie: scopedCookie, body: { userId: '555000000000000066' } });
    assert.strictEqual(res.status, 403);
    assert.strictEqual(auditCount('dash.user.add') - before, 0);
});

test('dash-user add with an invalid id fails and writes no entry', async () => {
    const cookie = await ownerCookie();
    const before = auditCount('dash.user.add');

    const res = await request('POST', '/api/dash/users/add', { cookie, body: { userId: 'not-a-snowflake' } });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(auditCount('dash.user.add') - before, 0);
});

test('dash-user remove records a real removal only — a no-op keeps the response but writes nothing', async () => {
    const cookie = await ownerCookie();
    const before = auditCount('dash.user.remove');

    const removed = await request('POST', '/api/dash/users/remove', { cookie, body: { userId: '555000000000000055' } });
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.body.success, true);
    assert.strictEqual(auditCount('dash.user.remove') - before, 1);

    const [row] = auditRows('dash.user.remove').slice(-1);
    assert.strictEqual(row.type, 'access');
    assert.strictEqual(row.user_id, 'owner-user');
    assert.deepStrictEqual(JSON.parse(row.details), { targetUserId: '555000000000000055' });

    // Removing an id that is not there still answers success (unchanged), but
    // nothing changed, so nothing is recorded.
    const beforeNoop = auditCount('dash.user.remove');
    const again = await request('POST', '/api/dash/users/remove', { cookie, body: { userId: '555000000000000055' } });
    assert.strictEqual(again.status, 200);
    assert.strictEqual(again.body.success, true);
    assert.deepStrictEqual(Object.keys(again.body).sort(), ['success', 'users'], 'the response shape is unchanged');
    assert.strictEqual(auditCount('dash.user.remove') - beforeNoop, 0, 'a no-op removal is not a change');
});

test('dash-user remove refused for a non-owner writes no entry', async () => {
    const before = auditCount('dash.user.remove');

    const res = await request('POST', '/api/dash/users/remove', { cookie: scopedCookie, body: { userId: 'audit-scoped' } });
    assert.strictEqual(res.status, 403, 'a scoped user cannot strip its own or anyone else’s access');
    assert.strictEqual(auditCount('dash.user.remove') - before, 0);
});

test('guild scope grant records the target and the granted servers', async () => {
    const cookie = await ownerCookie();
    const before = auditCount('dash.user.guilds');

    // This route validates snowflake format on both ids, so the target here is
    // numeric — the mock client's 'guild-aaa' style ids would be refused. The
    // target need not exist: the route only rewrites the scope rows.
    const res = await request('POST', '/api/dash/users/guilds', {
        cookie, body: { userId: '555000000000000077', guildIds: ['111000000000000001', '111000000000000002'] },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(auditCount('dash.user.guilds') - before, 1);

    const [row] = auditRows('dash.user.guilds').slice(-1);
    assert.strictEqual(row.type, 'access');
    assert.strictEqual(row.user_id, 'owner-user');
    assert.strictEqual(row.guild_id, null, 'a multi-server grant has no single guild to scope to');
    assert.deepStrictEqual(JSON.parse(row.details), {
        targetUserId: '555000000000000077', guildIds: ['111000000000000001', '111000000000000002'],
    });
});

test('guild scope grant refused for a non-owner and rejected for invalid input writes no entry', async () => {
    const cookie = await ownerCookie();

    // A scoped user granting itself every server: the owner gate refuses it.
    const beforeScoped = auditCount('dash.user.guilds');
    const scoped = await request('POST', '/api/dash/users/guilds', {
        cookie: scopedCookie, body: { userId: '555000000000000077', guildIds: ['111000000000000001'] },
    });
    assert.strictEqual(scoped.status, 403);
    assert.strictEqual(auditCount('dash.user.guilds') - beforeScoped, 0);

    const beforeInvalid = auditCount('dash.user.guilds');
    const invalidGuild = await request('POST', '/api/dash/users/guilds', {
        cookie, body: { userId: '555000000000000077', guildIds: ['not-an-id'] },
    });
    assert.strictEqual(invalidGuild.status, 400);
    const invalidUser = await request('POST', '/api/dash/users/guilds', {
        cookie, body: { userId: 'nope', guildIds: [] },
    });
    assert.strictEqual(invalidUser.status, 400);
    assert.strictEqual(auditCount('dash.user.guilds') - beforeInvalid, 0);
});

// ── Reminders and role menus ──
// The last two items on the mission's audit-coverage list. Reminders are
// account-level data; role menus are per-server configuration.

const MENU_GUILD = '777000000000000001';
const OTHER_GUILD = '777000000000000002';

// A guild rich enough for the role-menu routes: a text channel that posts and
// re-fetches its message, one assignable role, and the bot's own top role.
function menuFixture(id) {
    const channelId = '666' + id.slice(-12);
    const roleId = '555' + id.slice(-12);
    const message = {
        id: 'menu-msg-' + id, author: { id: 'fixture-bot' }, embeds: [{ title: 'Self-Assignable Roles' }],
        edit: async () => {}, delete: async () => {},
    };
    const channel = {
        id: channelId, name: 'roles', type: 0, position: 0, isTextBased: () => true,
        permissionsFor: () => ({ has: () => true }),
        send: async () => ({ id: message.id }),
        messages: { fetch: async () => message },
    };
    const role = { id: roleId, name: 'Pick Me', managed: false, position: 1, comparePositionTo: () => -1 };
    return {
        channelId, roleId, messageId: message.id,
        guild: {
            id, name: 'Menu Guild', memberCount: 3, iconURL: () => null,
            channels: { cache: new Collection([[channelId, channel]]) },
            roles: { cache: new Collection([[roleId, role]]) },
            members: { me: { permissions: { has: () => true }, roles: { highest: { id: 'bot-role', position: 100 } } } },
        },
    };
}

const menu = menuFixture(MENU_GUILD);
const otherMenu = menuFixture(OTHER_GUILD);

// Installed lazily: the client is shared by every test in this file, so swapping
// it at module load would strip the guilds the earlier cases depend on.
let menuClientInstalled = false;
function installMenuClient() {
    if (menuClientInstalled) return;
    setDashboardClient({
        guilds: { cache: new Collection([
            ['guild-aaa', guildA], ['guild-bbb', guildB],
            [MENU_GUILD, menu.guild], [OTHER_GUILD, otherMenu.guild],
        ]) },
        user: { id: 'fixture-bot' }, ws: { ping: 1 },
    }, 'test-password');
    menuClientInstalled = true;
}

// One scoped session for every cross-tenant case below: the login bucket allows
// 10 attempts a minute per IP, so a fresh sign-in per case would spend that
// budget instead of testing anything.
let menuScopedCookie = null;
async function menuScopedSession() {
    if (!menuScopedCookie) {
        installMenuClient();
        const { accessToken } = addDashUser('audit-menu-user', 'test');
        // addDashUser clears existing grants, so the grant goes in after it.
        getDb().prepare("INSERT OR REPLACE INTO dash_user_guilds (user_id, guild_id, granted_at) VALUES ('audit-menu-user', ?, 1)").run(MENU_GUILD);
        const res = await request('POST', '/api/login', { body: { discordId: 'audit-menu-user', accessToken } });
        assert.strictEqual(res.status, 200, 'the scoped role-menu user signs in');
        menuScopedCookie = cookieFrom(res);
    }
    return menuScopedCookie;
}

// createRoleMenu/re-add are upserts, so this is safe to call from any test.
async function ensureMenu(cookie) {
    installMenuClient();
    const res = await request('POST', '/api/server/' + MENU_GUILD + '/role-menus', {
        cookie, body: { channelId: menu.channelId, title: 'Probe menu' },
    });
    assert.strictEqual(res.status, 200, 'the probe menu is created');
    return res.body.messageId;
}

// ── Reminders ──

test('reminder create writes one entry with the id and target, never the message body', async () => {
    const cookie = await ownerCookie();
    const before = auditCount('reminder.create');

    const res = await request('POST', '/api/reminders', {
        cookie, body: { userId: '900000000000000123', text: 'Secret reminder body', durationMs: 60000 },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(auditCount('reminder.create') - before, 1, 'one entry for one created reminder');

    const [row] = auditRows('reminder.create').slice(-1);
    assert.strictEqual(row.type, 'reminder');
    assert.strictEqual(row.user_id, 'owner-user');
    assert.strictEqual(row.guild_id, null, 'a reminder is not server-scoped');
    const details = JSON.parse(row.details);
    assert.strictEqual(details.reminderId, res.body.reminder.id);
    assert.strictEqual(details.targetUserId, '900000000000000123');
    assert.strictEqual(details.durationMs, 60000);
    assert.ok(!row.details.includes('Secret reminder body'), 'the reminder body must never reach the audit row');
});

test('reminder remove records a real removal only', async () => {
    const cookie = await ownerCookie();
    const made = await request('POST', '/api/reminders', {
        cookie, body: { userId: '900000000000000124', text: 'Delete me', durationMs: 60000 },
    });
    assert.strictEqual(made.status, 200);
    const id = made.body.reminder.id;

    const before = auditCount('reminder.remove');
    const removed = await request('DELETE', '/api/reminders/' + id, { cookie, body: { userId: '900000000000000124' } });
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(auditCount('reminder.remove') - before, 1);

    const [row] = auditRows('reminder.remove').slice(-1);
    assert.deepStrictEqual(JSON.parse(row.details), { reminderId: id, targetUserId: '900000000000000124' });

    // Already gone: refused with 404, so nothing is recorded.
    const beforeAgain = auditCount('reminder.remove');
    const again = await request('DELETE', '/api/reminders/' + id, { cookie, body: { userId: '900000000000000124' } });
    assert.strictEqual(again.status, 404);
    assert.strictEqual(auditCount('reminder.remove') - beforeAgain, 0);
});

test('reminder writes record nothing when the caller is refused or the write fails', async () => {
    const cookie = await ownerCookie();

    // These routes carry no server scope, so the refusal is a plain 401.
    const anonBefore = auditCount('reminder.create');
    const anon = await request('POST', '/api/reminders', { body: { userId: '900000000000000125', text: 'x', durationMs: 1000 } });
    assert.strictEqual(anon.status, 401);
    assert.strictEqual(auditCount('reminder.create') - anonBefore, 0);

    const badBefore = auditCount('reminder.create');
    const bad = await request('POST', '/api/reminders', { cookie, body: { userId: '900000000000000125' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(auditCount('reminder.create') - badBefore, 0);

    const delBefore = auditCount('reminder.remove');
    const anonDel = await request('DELETE', '/api/reminders/whatever', { body: { userId: '900000000000000125' } });
    assert.strictEqual(anonDel.status, 401);
    assert.strictEqual(auditCount('reminder.remove') - delBefore, 0);

    const badDel = await request('DELETE', '/api/reminders/whatever', { cookie, body: {} });
    assert.strictEqual(badDel.status, 400);
    assert.strictEqual(auditCount('reminder.remove') - delBefore, 0);
});

// ── Role menus ──

test('role menu create writes one entry scoped to the guild, without the menu title', async () => {
    const cookie = await ownerCookie();
    installMenuClient();
    const before = auditCount('rolemenu.create');

    const res = await request('POST', '/api/server/' + MENU_GUILD + '/role-menus', {
        cookie, body: { channelId: menu.channelId, title: 'Secret menu title' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(auditCount('rolemenu.create') - before, 1);

    const [row] = auditRows('rolemenu.create').slice(-1);
    assert.strictEqual(row.type, 'rolemenu');
    assert.strictEqual(row.user_id, 'owner-user');
    assert.strictEqual(row.guild_id, MENU_GUILD);
    assert.deepStrictEqual(JSON.parse(row.details), { menuId: menu.messageId });
    assert.ok(!row.details.includes('Secret menu title'), 'the menu title is user text and stays out of the log');
});

test('role menu option add writes one entry with the menu and role ids only', async () => {
    const cookie = await ownerCookie();
    await ensureMenu(cookie);
    const before = auditCount('rolemenu.option.add');

    const res = await request('POST', '/api/server/' + MENU_GUILD + '/role-menus/' + menu.messageId + '/options', {
        cookie, body: { roleId: menu.roleId, label: 'Grab this role', description: 'Not logged' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(auditCount('rolemenu.option.add') - before, 1);

    const [row] = auditRows('rolemenu.option.add').slice(-1);
    assert.strictEqual(row.guild_id, MENU_GUILD);
    assert.deepStrictEqual(JSON.parse(row.details), { menuId: menu.messageId, roleId: menu.roleId });
    assert.ok(!row.details.includes('Grab this role'), 'option label text is not recorded');
});

test('role menu option remove records a real removal only', async () => {
    const cookie = await ownerCookie();
    await ensureMenu(cookie);
    const added = await request('POST', '/api/server/' + MENU_GUILD + '/role-menus/' + menu.messageId + '/options', {
        cookie, body: { roleId: menu.roleId },
    });
    assert.strictEqual(added.status, 200);

    const before = auditCount('rolemenu.option.remove');
    const removed = await request('DELETE', '/api/server/' + MENU_GUILD + '/role-menus/' + menu.messageId + '/options', {
        cookie, body: { roleId: menu.roleId },
    });
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(auditCount('rolemenu.option.remove') - before, 1);

    const [row] = auditRows('rolemenu.option.remove').slice(-1);
    assert.deepStrictEqual(JSON.parse(row.details), { menuId: menu.messageId, roleId: menu.roleId });

    // Nothing left to remove: 404, and nothing recorded.
    const beforeAgain = auditCount('rolemenu.option.remove');
    const again = await request('DELETE', '/api/server/' + MENU_GUILD + '/role-menus/' + menu.messageId + '/options', {
        cookie, body: { roleId: menu.roleId },
    });
    assert.strictEqual(again.status, 404);
    assert.strictEqual(auditCount('rolemenu.option.remove') - beforeAgain, 0);
});

test('role menu publish writes one entry with the option count', async () => {
    const cookie = await ownerCookie();
    await ensureMenu(cookie);
    // The publish route builds a select menu from the stored options, so give
    // them a description and an emoji — the shape the Role Menus screen submits.
    const option = await request('POST', '/api/server/' + MENU_GUILD + '/role-menus/' + menu.messageId + '/options', {
        cookie, body: { roleId: menu.roleId, label: 'Pick Me', description: 'Pick a role', emoji: '🎮' },
    });
    assert.strictEqual(option.status, 200);
    const before = auditCount('rolemenu.publish');

    const res = await request('PUT', '/api/server/' + MENU_GUILD + '/role-menus/' + menu.messageId + '/publish', {
        cookie, body: { channelId: menu.channelId },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(auditCount('rolemenu.publish') - before, 1);

    const [row] = auditRows('rolemenu.publish').slice(-1);
    const details = JSON.parse(row.details);
    assert.strictEqual(details.menuId, menu.messageId);
    assert.ok(details.optionCount >= 1, 'the entry says how many roles the menu carries');
});

test('role menu delete records a real removal only', async () => {
    const cookie = await ownerCookie();
    const messageId = await ensureMenu(cookie);

    const before = auditCount('rolemenu.remove');
    const removed = await request('DELETE', '/api/server/' + MENU_GUILD + '/role-menus/' + messageId, {
        cookie, body: { channelId: menu.channelId },
    });
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(auditCount('rolemenu.remove') - before, 1);

    const [row] = auditRows('rolemenu.remove').slice(-1);
    assert.strictEqual(row.guild_id, MENU_GUILD);
    assert.deepStrictEqual(JSON.parse(row.details), { menuId: messageId });

    const beforeAgain = auditCount('rolemenu.remove');
    const again = await request('DELETE', '/api/server/' + MENU_GUILD + '/role-menus/' + messageId, {
        cookie, body: { channelId: menu.channelId },
    });
    assert.strictEqual(again.status, 404);
    assert.strictEqual(auditCount('rolemenu.remove') - beforeAgain, 0);
});

test('every role menu write records nothing when the server is not granted to the caller', async () => {
    const cookie = await ownerCookie();
    const scoped = await menuScopedSession();
    const messageId = await ensureMenu(cookie);
    const base = '/api/server/' + OTHER_GUILD;

    const attempts = [
        ['rolemenu.create', () => request('POST', base + '/role-menus', { cookie: scoped, body: { channelId: otherMenu.channelId } })],
        ['rolemenu.option.add', () => request('POST', base + '/role-menus/' + messageId + '/options', { cookie: scoped, body: { roleId: otherMenu.roleId } })],
        ['rolemenu.option.remove', () => request('DELETE', base + '/role-menus/' + messageId + '/options', { cookie: scoped, body: { roleId: otherMenu.roleId } })],
        ['rolemenu.publish', () => request('PUT', base + '/role-menus/' + messageId + '/publish', { cookie: scoped, body: { channelId: otherMenu.channelId } })],
        ['rolemenu.remove', () => request('DELETE', base + '/role-menus/' + messageId, { cookie: scoped, body: { channelId: otherMenu.channelId } })],
    ];

    for (const [action, send] of attempts) {
        const before = auditCount(action);
        const res = await send();
        assert.strictEqual(res.status, 403, action + ' is refused for an ungranted server');
        assert.strictEqual(auditCount(action) - before, 0, action + ' records nothing when refused');
    }
});

test('rejected role menu writes record nothing', async () => {
    const cookie = await ownerCookie();
    const messageId = await ensureMenu(cookie);

    const rejected = [
        ['rolemenu.create', 'POST', '/api/server/' + MENU_GUILD + '/role-menus', {}],
        ['rolemenu.option.add', 'POST', '/api/server/' + MENU_GUILD + '/role-menus/' + messageId + '/options', {}],
        ['rolemenu.option.add', 'POST', '/api/server/' + MENU_GUILD + '/role-menus/' + messageId + '/options', { roleId: '444000000000000009' }],
        ['rolemenu.option.remove', 'DELETE', '/api/server/' + MENU_GUILD + '/role-menus/' + messageId + '/options', {}],
        ['rolemenu.publish', 'PUT', '/api/server/' + MENU_GUILD + '/role-menus/no-such-menu/publish', { channelId: menu.channelId }],
        ['rolemenu.remove', 'DELETE', '/api/server/' + MENU_GUILD + '/role-menus/no-such-menu', { channelId: menu.channelId }],
    ];

    for (const [action, method, urlPath, body] of rejected) {
        const before = auditCount(action);
        const res = await request(method, urlPath, { cookie, body });
        assert.ok(res.status >= 400, action + ' is refused (' + res.status + ')');
        assert.strictEqual(auditCount(action) - before, 0, action + ' records nothing on failure');
    }
});

// ── Giveaways: end and reroll ──
// Creating and cancelling a giveaway already leave a trace; the two routes that
// actually decide a result did not. Ending picks winners, rerolling replaces
// them — both are mutations an operator auditing "who ended what" needs to see,
// and neither may carry anything but the giveaway id and the winner count.

const GW_GUILD = 'guild-aaa';
const GW_CHANNEL = 'chan-audit';
const GW_MESSAGE = 'gw-msg-audit';

// The giveaways module keeps its own client (index.js wires it in production).
// A channel whose message carries a 🎉 reaction is all endGiveaway needs to pick
// winners: the fixture has no role rules, so every non-bot reactor is eligible.
function giveawayMessage(entrantIds) {
    const users = new Collection(entrantIds.map((uid) => [uid, { id: uid, bot: false }]));
    return {
        id: GW_MESSAGE,
        edit: async () => {},
        channel: { send: async () => ({}) },
        reactions: { cache: new Collection([['party', { emoji: { name: '🎉' }, users: { fetch: async () => users } }]]) },
    };
}

function makeActiveGiveaway(entrantIds) {
    const gw = giveaways.createGiveaway({
        guildId: GW_GUILD, channelId: GW_CHANNEL, prize: 'Audit prize',
        durationMs: 60000, winners: 2, hostId: 'owner-user', hostTag: 'Dashboard',
    });
    // createGiveaway stores the message id only once postGiveaway has posted;
    // this fixture never posts, so wire it up directly.
    getDb().prepare('UPDATE giveaways SET message_id = ? WHERE id = ?').run(GW_MESSAGE, gw.id);
    giveaways.setGiveawayClient({ channels: { cache: new Collection([[GW_CHANNEL, {
        id: GW_CHANNEL, isTextBased: () => true,
        messages: { fetch: async () => giveawayMessage(entrantIds) },
    }]]) } });
    return gw.id;
}

test('giveaway end writes one entry with the id and the picked winner count', async () => {
    const cookie = await ownerCookie();
    const id = makeActiveGiveaway(['audit-e1', 'audit-e2', 'audit-e3']);
    const before = auditCount('giveaway.end');

    const res = await request('POST', '/api/giveaways/end', { cookie, body: { id } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(auditCount('giveaway.end') - before, 1, 'one entry for one ended giveaway');

    const [row] = auditRows('giveaway.end').slice(-1);
    assert.strictEqual(row.type, 'giveaway');
    assert.strictEqual(row.user_id, 'owner-user');
    assert.strictEqual(row.guild_id, GW_GUILD, 'the entry is scoped to the giveaway\'s server');
    assert.deepStrictEqual(JSON.parse(row.details), { giveawayId: id, winners: 2 }, 'ids and a count, nothing else');
    assert.strictEqual(giveaways.getGiveaway(id).status, 'ended');
});

test('giveaway reroll writes one entry with the id and the new winner count', async () => {
    const cookie = await ownerCookie();
    const id = makeActiveGiveaway(['audit-e1', 'audit-e2', 'audit-e3']);
    const ended = await giveaways.endGiveaway(id);
    assert.strictEqual(ended.success, true, 'the fixture giveaway is ended before the reroll');

    const before = auditCount('giveaway.reroll');
    const res = await request('POST', '/api/giveaways/reroll', { cookie, body: { id } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(auditCount('giveaway.reroll') - before, 1);

    const [row] = auditRows('giveaway.reroll').slice(-1);
    assert.strictEqual(row.type, 'giveaway');
    assert.strictEqual(row.user_id, 'owner-user');
    assert.strictEqual(row.guild_id, GW_GUILD);
    // Three entrants, two of whom already won: the reroll can only add the third.
    assert.deepStrictEqual(JSON.parse(row.details), { giveawayId: id, winners: 1 });
});

test('giveaway list returns winner ids as an array for every stored shape', async () => {
    const cookie = await ownerCookie();
    const id = makeActiveGiveaway(['audit-w1', 'audit-w2']);
    const ended = await giveaways.endGiveaway(id);
    assert.strictEqual(ended.success, true, 'ending the fixture stores a comma-joined winner list');

    // Regression: parsing that column with JSON.parse threw for two winners, so
    // the endpoint answered [] and every screen showed "no giveaways" — the row
    // itself must stay listed with its winners as an array.
    const res = await request('GET', '/api/giveaways', { cookie });
    assert.strictEqual(res.status, 200);
    assert.ok(Array.isArray(res.body));
    const row = res.body.find((g) => g.id === id);
    assert.ok(row, 'an ended two-winner giveaway is still listed');
    assert.deepStrictEqual(row.winnerIds.slice().sort(), ['audit-w1', 'audit-w2']);

    // A row written by an older build (JSON array) must read the same way.
    getDb().prepare('UPDATE giveaways SET winner_ids = ? WHERE id = ?').run(JSON.stringify(['legacy-w1']), id);
    const legacy = await request('GET', '/api/giveaways', { cookie });
    assert.deepStrictEqual(legacy.body.find((g) => g.id === id).winnerIds, ['legacy-w1']);
});

test('giveaway end and reroll record nothing when refused or when nothing changes', async () => {
    const cookie = await ownerCookie();
    const scoped = await menuScopedSession();

    // Refused: ending and rerolling are owner-only.
    const id = makeActiveGiveaway(['audit-e1', 'audit-e2', 'audit-e3']);
    const beforeEnd = auditCount('giveaway.end');
    const beforeReroll = auditCount('giveaway.reroll');

    const refusedEnd = await request('POST', '/api/giveaways/end', { cookie: scoped, body: { id } });
    assert.strictEqual(refusedEnd.status, 403, 'a granted non-owner cannot end a giveaway');
    const refusedReroll = await request('POST', '/api/giveaways/reroll', { cookie: scoped, body: { id } });
    assert.strictEqual(refusedReroll.status, 403);
    assert.strictEqual(auditCount('giveaway.end') - beforeEnd, 0, 'a refused end records nothing');
    assert.strictEqual(auditCount('giveaway.reroll') - beforeReroll, 0, 'a refused reroll records nothing');

    // No-ops: endGiveaway and rerollGiveaway report "not found" / "already X"
    // as a return value rather than a throw, so the routes still answer 200
    // (unchanged, pre-existing) — but nothing changed, so nothing is recorded.
    const beforeNoopEnd = auditCount('giveaway.end');
    const noopEnd = await request('POST', '/api/giveaways/end', { cookie, body: { id: 'gw_does_not_exist' } });
    assert.strictEqual(noopEnd.status, 200);
    assert.strictEqual(auditCount('giveaway.end') - beforeNoopEnd, 0, 'ending an unknown giveaway is not a change');

    const beforeNoopReroll = auditCount('giveaway.reroll');
    const noopReroll = await request('POST', '/api/giveaways/reroll', { cookie, body: { id } });
    assert.strictEqual(noopReroll.status, 200);
    assert.strictEqual(auditCount('giveaway.reroll') - beforeNoopReroll, 0, 'rerolling a still-active giveaway is not a change');
});

// ── Moderation: warn, kick, ban, timeout ──
// These are the writes an audit trail exists for. Each records the actor, the
// server and the target id — and never the reason, which is user-authored text
// that belongs in Discord's own audit log, not in ours.

const MOD_GUILD = '888000000000000001';
const MOD_TARGET = '900000000000000900';
const MOD_MISSING = '900000000000000999';
const MOD_REASON = 'Secret moderation reason';

function modFixture(id) {
    const member = {
        id: MOD_TARGET, kickable: true, moderatable: true,
        kick: async () => {}, timeout: async () => {},
    };
    return {
        guild: {
            id, name: 'Mod Guild', memberCount: 5, iconURL: () => null,
            channels: { cache: new Collection() },
            roles: { cache: new Collection() },
            members: {
                cache: new Collection([[MOD_TARGET, member]]),
                fetch: async (uid) => (String(uid) === MOD_TARGET ? member : null),
                me: { permissions: { has: () => true }, roles: { highest: { id: 'bot-role', position: 100 } } },
            },
            bans: { create: async () => {} },
        },
    };
}
const mod = modFixture(MOD_GUILD);

// Installed lazily and as a superset: every guild the earlier cases rely on is
// kept, so the file passes whatever order its tests run in.
let modClientInstalled = false;
function installModClient() {
    if (modClientInstalled) return;
    setDashboardClient({
        guilds: { cache: new Collection([
            ['guild-aaa', guildA], ['guild-bbb', guildB],
            [MENU_GUILD, menu.guild], [OTHER_GUILD, otherMenu.guild],
            [MOD_GUILD, mod.guild],
        ]) },
        user: null, ws: { ping: 1 },
    }, 'test-password');
    modClientInstalled = true;
}

const MOD_ROUTES = [
    ['mod.warn', '/mod/warn', { userId: MOD_TARGET, reason: MOD_REASON }],
    ['mod.kick', '/mod/kick', { userId: MOD_TARGET, reason: MOD_REASON }],
    ['mod.ban', '/mod/ban', { userId: MOD_TARGET, reason: MOD_REASON }],
    ['mod.timeout', '/mod/timeout', { userId: MOD_TARGET, duration: '10m', reason: MOD_REASON }],
];

test('owner warn records the target and the warning count, never the reason', async () => {
    const cookie = await ownerCookie();
    installModClient();
    const before = auditCount('mod.warn');

    const res = await request('POST', '/api/server/' + MOD_GUILD + '/mod/warn', {
        cookie, body: { userId: MOD_TARGET, reason: MOD_REASON },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(auditCount('mod.warn') - before, 1, 'one entry for one warning');

    const [row] = auditRows('mod.warn').slice(-1);
    assert.strictEqual(row.type, 'mod');
    assert.strictEqual(row.user_id, 'owner-user', 'actor is the owner session');
    assert.strictEqual(row.guild_id, MOD_GUILD);
    assert.deepStrictEqual(JSON.parse(row.details), { targetUserId: MOD_TARGET, warnings: 1 });
    assert.ok(!row.details.includes(MOD_REASON), 'the moderation reason is text and stays out of the log');
});

test('owner kick records the target id only, never the reason', async () => {
    const cookie = await ownerCookie();
    installModClient();
    const before = auditCount('mod.kick');

    const res = await request('POST', '/api/server/' + MOD_GUILD + '/mod/kick', {
        cookie, body: { userId: MOD_TARGET, reason: MOD_REASON },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(auditCount('mod.kick') - before, 1);

    const [row] = auditRows('mod.kick').slice(-1);
    assert.strictEqual(row.type, 'mod');
    assert.strictEqual(row.user_id, 'owner-user');
    assert.strictEqual(row.guild_id, MOD_GUILD);
    assert.deepStrictEqual(JSON.parse(row.details), { targetUserId: MOD_TARGET });
    assert.ok(!row.details.includes(MOD_REASON), 'the kick reason stays out of the log');
});

test('owner ban records the target id only, never the reason', async () => {
    const cookie = await ownerCookie();
    installModClient();
    const before = auditCount('mod.ban');

    const res = await request('POST', '/api/server/' + MOD_GUILD + '/mod/ban', {
        cookie, body: { userId: MOD_TARGET, reason: MOD_REASON, deleteMessages: '24hours' },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(auditCount('mod.ban') - before, 1);

    const [row] = auditRows('mod.ban').slice(-1);
    assert.strictEqual(row.type, 'mod');
    assert.strictEqual(row.guild_id, MOD_GUILD);
    assert.deepStrictEqual(JSON.parse(row.details), { targetUserId: MOD_TARGET });
    assert.ok(!row.details.includes(MOD_REASON), 'the ban reason stays out of the log');
});

test('owner timeout records the target and the duration, never the reason', async () => {
    const cookie = await ownerCookie();
    installModClient();
    const before = auditCount('mod.timeout');

    const res = await request('POST', '/api/server/' + MOD_GUILD + '/mod/timeout', {
        cookie, body: { userId: MOD_TARGET, duration: '10m', reason: MOD_REASON },
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(auditCount('mod.timeout') - before, 1);

    const [row] = auditRows('mod.timeout').slice(-1);
    assert.strictEqual(row.type, 'mod');
    assert.strictEqual(row.guild_id, MOD_GUILD);
    assert.deepStrictEqual(JSON.parse(row.details), { targetUserId: MOD_TARGET, durationMs: 600000 });
    assert.ok(!row.details.includes(MOD_REASON), 'the timeout reason stays out of the log');
});

test('every moderation write records nothing when the caller is refused', async () => {
    installModClient();
    const scoped = await menuScopedSession();

    for (const [action, route, body] of MOD_ROUTES) {
        const before = auditCount(action);
        // Every /api/server/:id route passes the tenant guard first, which
        // refuses a caller it cannot scope to that server — so a request with no
        // session at all is a 403 here, not the 401 the unscoped routes answer.
        const anon = await request('POST', '/api/server/' + MOD_GUILD + route, { body });
        assert.strictEqual(anon.status, 403, action + ' is refused without server access');

        // A dash user granted a server is still not the owner: the route's own
        // owner gate refuses it, wherever the tenant guard left it standing.
        const granted = await request('POST', '/api/server/' + MOD_GUILD + route, { cookie: scoped, body });
        assert.strictEqual(granted.status, 403, action + ' is owner-only');

        assert.strictEqual(auditCount(action) - before, 0, action + ' records nothing when refused');
    }
});

test('every moderation write records nothing when it fails', async () => {
    const cookie = await ownerCookie();
    installModClient();

    const rejected = [
        ['mod.warn', '/mod/warn', { userId: MOD_TARGET }],
        ['mod.kick', '/mod/kick', { userId: MOD_MISSING, reason: MOD_REASON }],
        ['mod.ban', '/mod/ban', { userId: MOD_TARGET }],
        ['mod.timeout', '/mod/timeout', { userId: MOD_MISSING, duration: '10m', reason: MOD_REASON }],
    ];

    for (const [action, route, body] of rejected) {
        const before = auditCount(action);
        const res = await request('POST', '/api/server/' + MOD_GUILD + route, { cookie, body });
        assert.ok(res.status >= 400, action + ' is rejected (' + res.status + ')');
        assert.strictEqual(auditCount(action) - before, 0, action + ' records nothing on failure');
    }
});

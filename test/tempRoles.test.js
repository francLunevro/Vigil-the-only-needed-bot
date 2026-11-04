// Tests for the temporary roles module. The interesting half is the sweep:
// it is the only thing that makes the role actually temporary, so the failure
// paths (member gone, role deleted, permission lost, Discord flaking) each get
// their own case — an expired role that silently stays applied is the whole
// risk of this feature.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'temp-roles-test-'));
process.env.DATA_DIR = tmp;

const { getDb, closeDb } = require('../src/db');
const tr = require('../src/tempRoles');

after(() => {
    tr.setTempRoleClient(null);
    tr.stopTempRoleSweeper();
    try { closeDb(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
    getDb().prepare('DELETE FROM temp_roles').run();
});

const GUILD = 'g1';
const HOUR = 3600000;

// ── Fakes ──

function makeRole(id, name, { position = 1, managed = false } = {}) {
    return {
        id, name, managed, position,
        comparePositionTo(other) { return position - (other ? other.position : 0); },
    };
}

function makeMember(id, { addImpl, removeImpl } = {}) {
    return {
        id,
        user: { id, bot: false },
        roles: {
            added: [], removed: [],
            async add(roleId, reason) {
                if (addImpl) return addImpl(roleId, reason);
                this.added.push(roleId);
            },
            async remove(roleId, reason) {
                if (removeImpl) return removeImpl(roleId, reason);
                this.removed.push(roleId);
            },
        },
    };
}

function makeGuild(id = GUILD, { members = [], topPosition = 100, canManageRoles = true, me = true } = {}) {
    const everyone = makeRole(id + '-everyone', '@everyone', { position: 0 });
    const cache = new Map();
    for (const m of members) cache.set(m.id, m);
    const guild = {
        id,
        roles: { cache: new Map([[everyone.id, everyone]]), everyone },
        members: {
            cache,
            fetch: async (userId) => cache.get(userId) || null,
            me: me ? {
                permissions: { has: () => canManageRoles },
                roles: { highest: makeRole(id + '-botrole', 'Bot', { position: topPosition }) },
            } : null,
        },
        channels: { cache: new Map() },
    };
    return guild;
}

function makeClient(guilds) {
    const cache = new Map();
    for (const g of guilds) cache.set(g.id, g);
    return { guilds: { cache } };
}

// ──────────────────── Storage ────────────────────

test('addTempRole: validates, creates, then extends instead of duplicating', () => {
    assert.ok(tr.addTempRole({ guildId: GUILD, userId: 'u1' }).error, 'a role is required');
    assert.ok(tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: 1000 }).error, 'under a minute');
    assert.ok(tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: 400 * 24 * HOUR }).error, 'over a year');
    assert.ok(tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: NaN }).error);

    const created = tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: HOUR, grantedBy: 'mod1' });
    assert.strictEqual(created.extended, false);
    assert.strictEqual(created.entry.userId, 'u1');
    assert.strictEqual(created.entry.grantedBy, 'mod1');
    assert.ok(created.entry.expiresAt > Date.now() + HOUR - 5000);

    const extended = tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: 2 * HOUR });
    assert.strictEqual(extended.extended, true, 'a re-grant extends');
    assert.ok(extended.entry.expiresAt > created.entry.expiresAt, 'the timer restarts from now');
    assert.strictEqual(extended.entry.grantedBy, 'mod1', 'the original granter is kept');
    assert.strictEqual(tr.listTempRoles(GUILD).length, 1, 'no duplicate rows');

    // Same user, different role = its own row.
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r2', durationMs: HOUR });
    assert.strictEqual(tr.listTempRolesForUser(GUILD, 'u1').length, 2);
    assert.strictEqual(tr.listTempRolesForUser(GUILD, 'someone-else').length, 0);

    assert.strictEqual(tr.deleteTempRole(GUILD, 'u1', 'r1'), true);
    assert.strictEqual(tr.getTempRole(GUILD, 'u1', 'r1'), null);
    assert.strictEqual(tr.deleteTempRole(GUILD, 'u1', 'r1'), false);
});

test('checkAssignable: refuses everything the bot cannot actually hand out', () => {
    const guild = makeGuild();
    assert.ok(!tr.checkAssignable(guild, makeRole('r1', 'Muted')).error, 'a plain role is fine');
    assert.match(tr.checkAssignable(guild, null).error, /no longer exists/);
    assert.match(tr.checkAssignable(guild, guild.roles.everyone).error, /everyone/);
    assert.match(tr.checkAssignable(guild, makeRole('r2', 'Bot', { managed: true })).error, /managed/);
    assert.match(tr.checkAssignable(guild, makeRole('r3', 'High', { position: 150 })).error, /above my highest/);
    assert.match(tr.checkAssignable(makeGuild('g2', { canManageRoles: false }), makeRole('r1', 'Muted')).error,
        /Manage Roles/, 'missing Manage Roles is refused');
    assert.match(tr.checkAssignable(makeGuild('g3', { me: false }), makeRole('r1', 'Muted')).error, /not cached/);
});

// ──────────────────── Grant / revoke ────────────────────

test('grantTempRole: adds the role and records the expiry', async () => {
    const member = makeMember('u1');
    const guild = makeGuild(GUILD, { members: [member] });
    const role = makeRole('r1', 'Muted', { position: 5 });
    guild.roles.cache.set(role.id, role);

    const result = await tr.grantTempRole({ guild, role, userId: 'u1', durationMs: 2 * HOUR, grantedBy: 'mod1' });
    assert.ok(!result.error, result.error);
    assert.deepStrictEqual(member.roles.added, ['r1']);
    assert.strictEqual(tr.getTempRole(GUILD, 'u1', 'r1').grantedBy, 'mod1');

    const missing = await tr.grantTempRole({ guild, role, userId: 'nobody', durationMs: HOUR });
    assert.match(missing.error, /not in this server/);

    const badRole = await tr.grantTempRole({ guild, role: guild.roles.everyone, userId: 'u1', durationMs: HOUR });
    assert.ok(badRole.error, 'an unassignable role is refused before touching Discord');
    assert.strictEqual(member.roles.added.length, 1, 'nothing was sent to Discord');
});

// Regression: the dashboard used to add the role and only then discover the
// duration was out of range, rolling it back — a pointless role update that
// could leave the role stuck (and untracked) if the rollback itself failed.
// Validation must happen before the member is touched at all.
test('grantTempRole: refuses an out-of-range duration before touching Discord', async () => {
    const member = makeMember('u1');
    const guild = makeGuild(GUILD, { members: [member] });
    const role = makeRole('r1', 'Muted', { position: 5 });
    guild.roles.cache.set(role.id, role);

    const tooShort = await tr.grantTempRole({ guild, role, userId: 'u1', durationMs: 1000 });
    assert.match(tooShort.error, /at least 1 minute/);
    const tooLong = await tr.grantTempRole({ guild, role, userId: 'u1', durationMs: 400 * 24 * HOUR });
    assert.match(tooLong.error, /365 days/);

    assert.deepStrictEqual(member.roles.added, [], 'no role was sent to Discord');
    assert.deepStrictEqual(member.roles.removed, [], 'nothing had to be rolled back');
    assert.strictEqual(tr.getTempRole(GUILD, 'u1', 'r1'), null, 'no row is recorded');
});

test('grantTempRole: a role Discord refuses is reported, not half-applied', async () => {
    const member = makeMember('u1', { removeImpl: async () => { throw new Error('nope'); } });
    member.roles.add = async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); };
    const guild = makeGuild(GUILD, { members: [member] });
    const role = makeRole('r1', 'Muted', { position: 5 });

    const result = await tr.grantTempRole({ guild, role, userId: 'u1', durationMs: HOUR });
    assert.match(result.error, /refused/);
    assert.strictEqual(tr.getTempRole(GUILD, 'u1', 'r1'), null, 'no row is written when the add failed');
});

test('revokeTempRole: strips the role, keeps the row if Discord refuses', async () => {
    const member = makeMember('u1');
    const guild = makeGuild(GUILD, { members: [member] });
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: HOUR });

    const missing = await tr.revokeTempRole({ guild, userId: 'u1', roleId: 'r9' });
    assert.ok(missing.error, 'nothing pending for that pair');

    const failedMember = makeMember('u2', { removeImpl: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } });
    guild.members.cache.set('u2', failedMember);
    tr.addTempRole({ guildId: GUILD, userId: 'u2', roleId: 'r2', durationMs: HOUR });
    const failed = await tr.revokeTempRole({ guild, userId: 'u2', roleId: 'r2' });
    assert.ok(failed.error, 'the failure is surfaced');
    assert.ok(tr.getTempRole(GUILD, 'u2', 'r2'), 'the row survives so the sweeper retries');

    const ok = await tr.revokeTempRole({ guild, userId: 'u1', roleId: 'r1' });
    assert.ok(!ok.error, ok.error);
    assert.deepStrictEqual(member.roles.removed, ['r1']);
    assert.strictEqual(tr.getTempRole(GUILD, 'u1', 'r1'), null);
});

test('revokeTempRole: a member who already left just loses the row', async () => {
    const guild = makeGuild(GUILD);
    tr.addTempRole({ guildId: GUILD, userId: 'gone', roleId: 'r1', durationMs: HOUR });
    const result = await tr.revokeTempRole({ guild, userId: 'gone', roleId: 'r1' });
    assert.ok(!result.error, 'no role to strip is not an error');
    assert.strictEqual(tr.getTempRole(GUILD, 'gone', 'r1'), null);
});

// ──────────────────── Sweeper ────────────────────

test('sweep: strips expired roles, leaves future ones, reports a count', async () => {
    const member = makeMember('u1');
    const guild = makeGuild(GUILD, { members: [member] });
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: HOUR });

    tr.setTempRoleClient(makeClient([guild]));
    assert.strictEqual(await tr.sweepExpiredTempRoles(), 0, 'nothing is due yet');
    assert.strictEqual(tr.listTempRoles(GUILD).length, 1);

    // Backdate the expiry.
    getDb().prepare('UPDATE temp_roles SET expires_at = ?').run(Date.now() - 1000);
    assert.strictEqual(await tr.sweepExpiredTempRoles(), 1);
    assert.deepStrictEqual(member.roles.removed, ['r1']);
    assert.strictEqual(tr.listTempRoles(GUILD).length, 0, 'the row is cleaned up');
});

test('sweep: no client means no work', async () => {
    tr.setTempRoleClient(null);
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: HOUR });
    getDb().prepare('UPDATE temp_roles SET expires_at = ?').run(Date.now() - 1000);
    assert.strictEqual(await tr.sweepExpiredTempRoles(), 0);
    assert.strictEqual(tr.listTempRoles(GUILD).length, 1, 'the row is left for the next sweep');
});

test('sweep: rows for guilds we left and members who are gone are dropped', async () => {
    const guild = makeGuild(GUILD);
    tr.addTempRole({ guildId: GUILD, userId: 'gone', roleId: 'r1', durationMs: HOUR });
    tr.addTempRole({ guildId: 'other-guild', userId: 'u1', roleId: 'r2', durationMs: HOUR });
    getDb().prepare('UPDATE temp_roles SET expires_at = ?').run(Date.now() - 1000);

    tr.setTempRoleClient(makeClient([guild]));
    assert.strictEqual(await tr.sweepExpiredTempRoles(), 0, 'nothing was stripped — there was nothing to strip');
    assert.strictEqual(tr.listTempRoles(GUILD).length, 0);
    assert.deepStrictEqual(tr.listTempRoles('other-guild'), [], 'the guild we are not in is cleaned too');
});

test('sweep: terminal errors give up immediately, transient ones retry then give up', async () => {
    const gone = makeMember('u1', { removeImpl: async () => { throw Object.assign(new Error('Unknown Member'), { code: 10007 }); } });
    const flaky = makeMember('u2', { removeImpl: async () => { throw new Error('ECONNRESET'); } });
    const guild = makeGuild(GUILD, { members: [gone, flaky] });
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: HOUR });
    tr.addTempRole({ guildId: GUILD, userId: 'u2', roleId: 'r2', durationMs: HOUR });
    getDb().prepare('UPDATE temp_roles SET expires_at = ?').run(Date.now() - 1000);
    tr.setTempRoleClient(makeClient([guild]));

    assert.strictEqual(await tr.sweepExpiredTempRoles(), 0, 'nothing succeeded');
    assert.strictEqual(tr.getTempRole(GUILD, 'u1', 'r1'), null, 'a code we can never recover from gives up at once');
    const retrying = tr.getTempRole(GUILD, 'u2', 'r2');
    assert.ok(retrying, 'a transient failure keeps the row');
    assert.strictEqual(retrying.attempts, 1);

    // Burn the remaining attempts.
    for (let i = 1; i < tr.MAX_ATTEMPTS; i++) {
        await tr.sweepExpiredTempRoles();
    }
    assert.strictEqual(tr.getTempRole(GUILD, 'u2', 'r2'), null, 'it eventually stops retrying');
});

test('sweep: a success resets nothing it should not — later rows still process', async () => {
    const a = makeMember('u1');
    const b = makeMember('u2');
    const guild = makeGuild(GUILD, { members: [a, b] });
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: HOUR });
    tr.addTempRole({ guildId: GUILD, userId: 'u2', roleId: 'r2', durationMs: HOUR });
    getDb().prepare('UPDATE temp_roles SET expires_at = ?').run(Date.now() - 1000);
    tr.setTempRoleClient(makeClient([guild]));

    assert.strictEqual(await tr.sweepExpiredTempRoles(), 2, 'one bad row must not stop the loop');
    assert.deepStrictEqual(a.roles.removed, ['r1']);
    assert.deepStrictEqual(b.roles.removed, ['r2']);
});

test('startTempRoleSweeper sweeps immediately, then stops cleanly', async () => {
    const member = makeMember('u1');
    const guild = makeGuild(GUILD, { members: [member] });
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: HOUR });
    getDb().prepare('UPDATE temp_roles SET expires_at = ?').run(Date.now() - 1000);
    tr.setTempRoleClient(makeClient([guild]));

    tr.startTempRoleSweeper();
    // The boot sweep is async; give it a tick.
    await new Promise((r) => setImmediate(r));
    tr.stopTempRoleSweeper();
    assert.strictEqual(tr.listTempRoles(GUILD).length, 0, 'roles that expired while offline are not left on members');
    assert.deepStrictEqual(member.roles.removed, ['r1']);
});

// ──────────────────── Rejoin restore ────────────────────

test('restoreTempRolesForMember: re-applies live roles, drops expired ones', async () => {
    const role = makeRole('r1', 'Muted', { position: 5 });
    const member = makeMember('u1');
    member.guild = makeGuild(GUILD, { members: [member] });
    member.guild.roles.cache.set(role.id, role);

    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: HOUR });
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r2', durationMs: HOUR });
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r3', durationMs: HOUR });
    // r2 already expired while they were away; r3's role was deleted.
    getDb().prepare('UPDATE temp_roles SET expires_at = ? WHERE role_id = ?').run(Date.now() - 1000, 'r2');

    assert.strictEqual(await tr.restoreTempRolesForMember(member), 1);
    assert.deepStrictEqual(member.roles.added, ['r1'], 'only the live one comes back');
    assert.strictEqual(tr.getTempRole(GUILD, 'u1', 'r2'), null, 'the expired row is cleaned up');
    assert.strictEqual(tr.getTempRole(GUILD, 'u1', 'r3'), null, 'a deleted role is dropped, not retried forever');
    assert.strictEqual(tr.getTempRole(GUILD, 'u1', 'r1').expiresAt > Date.now(), true);
});

test('restoreTempRolesForMember: ignores bots and malformed members', async () => {
    assert.strictEqual(await tr.restoreTempRolesForMember(null), 0);
    assert.strictEqual(await tr.restoreTempRolesForMember({}), 0);
    const bot = makeMember('bot1');
    bot.user.bot = true;
    bot.guild = makeGuild(GUILD);
    assert.strictEqual(await tr.restoreTempRolesForMember(bot), 0);
});

test('restoreTempRolesForMember: a failing re-add is logged, not fatal', async () => {
    const role = makeRole('r1', 'Muted', { position: 5 });
    const member = makeMember('u1', { addImpl: async () => { throw new Error('Missing Permissions'); } });
    member.guild = makeGuild(GUILD, { members: [member] });
    member.guild.roles.cache.set(role.id, role);
    tr.addTempRole({ guildId: GUILD, userId: 'u1', roleId: 'r1', durationMs: HOUR });

    assert.strictEqual(await tr.restoreTempRolesForMember(member), 0);
    assert.ok(tr.getTempRole(GUILD, 'u1', 'r1'), 'the row stays so the sweeper can still try to strip it');
});

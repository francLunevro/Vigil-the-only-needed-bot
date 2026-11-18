// ─── Actor role hierarchy ───
// Discord refuses a member-modifying action when the actor's highest role is at
// or below the target's (kick, ban, timeout, nickname, role edits). The bot is
// the account making the API call, though, so every check in this codebase was
// about the *bot's* position: member.kickable, member.moderatable, "higher than
// my highest role". None of them look at the person who typed the command, so a
// moderator granted a command with `/perm` could kick, ban or time out an
// administrator who outranks them, and hand out roles above their own rank.
//
// These tests pin the invoker half of the rule, plus the command-level wiring:
// a blocked action must not reach Discord and must say why.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate before requiring db — the path is computed at module load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modhier-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
const BOT_OWNER_ID = 'bot-owner-1';
process.env.OWNER_ID = BOT_OWNER_ID;

const { closeDb } = require('../src/db');
const { checkHierarchy, hierarchyBlock } = require('../src/modGuard');
const { executeKick, executeBan, executeTimeout } = require('../src/commands/moderation');
const { executeRole } = require('../src/commands/admin');
const { handleConfirmKick } = require('../src/interactions/moderation');
const tempRoles = require('../src/tempRoles');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ─── Mocks ───
function member(id, position, extra = {}) {
    return Object.assign({
        id,
        user: { id, username: 'U' + id, tag: 'U' + id + '#0001', displayAvatarURL: () => 'https://cdn.example/a.png' },
        roles: { highest: { position }, cache: { has: () => false, keys: () => [].values() } },
        kickable: true,
        bannable: true,
        moderatable: true,
    }, extra);
}

function role(id, position, extra = {}) {
    return Object.assign({
        id,
        name: 'Role ' + id,
        position,
        managed: false,
        comparePositionTo: () => -1, // below the bot's highest role
        toString: () => '<@&' + id + '>',
    }, extra);
}

// `mePosition` is the bot's own top role: deliberately high, so the bot-level
// checks pass and only the invoker check can stop the action.
function makeGuild({ ownerId = 'server-owner', members = [] } = {}) {
    const cache = new Map(members.map((m) => [m.id, m]));
    return {
        id: 'g1',
        name: 'Guild',
        iconURL: () => null,
        ownerId,
        members: {
            me: { id: 'BOT', permissions: { has: () => true }, roles: { highest: { position: 100 } } },
            cache,
            fetch: async (id) => cache.get(id) || null,
        },
        roles: { everyone: { id: 'g1' }, cache: new Map() },
    };
}

function makeInteraction({ guild, actor, options = {}, customId, update }) {
    const calls = { reply: [], update: [] };
    return {
        options: {
            getSubcommand: () => options.sub || null,
            getUser: () => options.user || null,
            getRole: () => options.role || null,
            getChannel: () => options.channel || null,
            getString: (n) => (options.strings || {})[n] || null,
        },
        customId,
        guild,
        user: actor.user,
        member: actor,
        client: { users: { fetch: async () => actor.user } },
        message: { embeds: [{ fields: [{ name: 'Reason', value: 'spam' }] }] },
        reply: async (o) => { calls.reply.push(o); },
        update: update || (async (o) => { calls.update.push(o); }),
        __calls: calls,
    };
}

// ─── The rule itself ───

test('allows acting on a member you outrank', () => {
    const guild = makeGuild();
    const problem = checkHierarchy({ guild, actorId: 'mod', actor: member('mod', 50), target: member('low', 5) });
    assert.strictEqual(problem, null);
});

test('blocks a member with an equal top role', () => {
    const guild = makeGuild();
    const problem = checkHierarchy({ guild, actorId: 'mod', actor: member('mod', 50), target: member('peer', 50) });
    assert.match(problem, /at or above yours/);
});

test('blocks a member ranked above you', () => {
    const guild = makeGuild();
    const problem = checkHierarchy({ guild, actorId: 'mod', actor: member('mod', 10), target: member('admin', 80) });
    assert.match(problem, /at or above yours/);
});

test('allows acting on yourself', () => {
    // Discord permits changing your own nickname or roles; only other members
    // are a hierarchy question.
    const guild = makeGuild();
    const me = member('mod', 50);
    assert.strictEqual(checkHierarchy({ guild, actorId: 'mod', actor: me, target: me }), null);
});

test('the server owner and the bot owner are never limited by position', () => {
    const guild = makeGuild({ ownerId: 'owner-1' });
    const top = member('top', 99);
    assert.strictEqual(checkHierarchy({ guild, actorId: 'owner-1', actor: member('owner-1', 1), target: top }), null);
    assert.strictEqual(checkHierarchy({ guild, actorId: BOT_OWNER_ID, actor: member(BOT_OWNER_ID, 1), target: top }), null);
});

test('a role at or above your own rank cannot be managed', () => {
    const guild = makeGuild();
    const actor = member('mod', 50);
    assert.match(checkHierarchy({ guild, actorId: 'mod', actor, role: role('r-high', 60) }), /not below your highest role/);
    assert.match(checkHierarchy({ guild, actorId: 'mod', actor, role: role('r-equal', 50) }), /not below your highest role/);
    assert.strictEqual(checkHierarchy({ guild, actorId: 'mod', actor, role: role('r-low', 30) }), null);
});

test('a target who is not in the guild cannot be compared', () => {
    // Banning by id works for users who already left, so there are no roles to
    // weigh up.
    const guild = makeGuild();
    assert.strictEqual(checkHierarchy({ guild, actorId: 'mod', actor: member('mod', 50), target: null }), null);
});

test('members without role data are not blocked', () => {
    // Test doubles and legacy shims carry no roles; an unknown position must
    // never be the reason a real moderator is stopped.
    const guild = makeGuild();
    const standIn = { id: 'someone' };
    assert.strictEqual(checkHierarchy({ guild, actorId: 'mod', actor: member('mod', 50), target: standIn }), null);
    assert.strictEqual(checkHierarchy({ guild, actorId: 'mod', actor: standIn, target: member('x', 5) }), null);
});

test('falls back to the guild member cache for the actor', () => {
    const guild = makeGuild({ members: [member('mod', 50)] });
    assert.match(checkHierarchy({ guild, actorId: 'mod', target: member('admin', 80) }), /at or above yours/);
    assert.strictEqual(checkHierarchy({ guild, actorId: 'mod', target: member('low', 5) }), null);
});

test('a missing guild or actor is not a block', () => {
    assert.strictEqual(checkHierarchy({ guild: null, actorId: 'mod', target: member('x', 5) }), null);
    assert.strictEqual(checkHierarchy({ guild: makeGuild(), actorId: null, target: member('x', 5) }), null);
});

test('hierarchyBlock reads the actor from the interaction', () => {
    const guild = makeGuild();
    const mod = member('mod', 50);
    assert.match(hierarchyBlock(makeInteraction({ guild, actor: mod, options: { user: member('admin', 80).user } }), member('admin', 80)), /at or above yours/);
    assert.strictEqual(hierarchyBlock(null, member('admin', 80)), null);
});

// ─── Wiring: the commands ───

test('/kick refuses a target ranked at or above the moderator', async () => {
    const mod = member('mod', 50);
    let kicked = 0;
    const target = member('target', 80, { kick: async () => { kicked += 1; } });
    const guild = makeGuild({ members: [mod, target] });
    const interaction = makeInteraction({ guild, actor: mod, options: { user: target.user, strings: { reason: 'spam' } } });

    await executeKick(interaction);

    assert.strictEqual(kicked, 0, 'the kick must not reach Discord');
    assert.match(interaction.__calls.reply[0].content, /at or above yours/);
});

test('/kick still works when the moderator outranks the target', async () => {
    const mod = member('mod', 80);
    const target = member('target', 5);
    const guild = makeGuild({ members: [mod, target] });
    const interaction = makeInteraction({ guild, actor: mod, options: { user: target.user, strings: { reason: 'spam' } } });

    await executeKick(interaction);

    assert.strictEqual(interaction.__calls.reply.length, 1);
    assert.ok(interaction.__calls.reply[0].embeds, 'the confirmation prompt is shown');
});

test('/ban refuses a target ranked above the moderator', async () => {
    const mod = member('mod', 50);
    const target = member('admin', 80);
    const guild = makeGuild({ members: [mod, target] });
    const interaction = makeInteraction({
        guild,
        actor: mod,
        options: { user: target.user, strings: { reason: 'spam', proof: null, delete_messages: 'none' } },
    });

    await executeBan(interaction);

    assert.match(interaction.__calls.reply[0].content, /at or above yours/);
    assert.ok(!interaction.__calls.reply[0].embeds, 'no confirmation prompt for a blocked ban');
});

test('/timeout refuses a target ranked above the moderator', async () => {
    const mod = member('mod', 50);
    let timedOut = 0;
    const target = member('admin', 80, { timeout: async () => { timedOut += 1; } });
    const guild = makeGuild({ members: [mod, target] });
    const interaction = makeInteraction({
        guild,
        actor: mod,
        options: { user: target.user, strings: { duration: '10m', reason: 'spam', proof: null } },
    });

    await executeTimeout(interaction);

    assert.strictEqual(timedOut, 0);
    assert.match(interaction.__calls.reply[0].content, /at or above yours/);
});

test('/role add refuses a role above the moderator rank', async () => {
    const mod = member('mod', 50);
    let added = 0;
    const target = member('target', 5, { roles: { highest: { position: 5 }, cache: { has: () => false }, add: async () => { added += 1; } } });
    const guild = makeGuild({ members: [mod, target] });
    const interaction = makeInteraction({ guild, actor: mod, options: { sub: 'add', user: target.user, role: role('r-admin', 60) } });

    await executeRole(interaction);

    assert.strictEqual(added, 0, 'the role must not be granted');
    assert.match(interaction.__calls.reply[0].content, /not below your highest role/);
});

test('confirm button re-checks the hierarchy at execution time', async () => {
    // Roles can change between the prompt and the click.
    const mod = member('mod', 50);
    let kicked = 0;
    const target = member('target', 80, { kick: async () => { kicked += 1; } });
    const guild = makeGuild({ members: [mod, target] });
    const interaction = makeInteraction({ guild, actor: mod, customId: 'ck_mod_target' });

    await handleConfirmKick(interaction, ['ck', 'mod', 'target']);

    assert.strictEqual(kicked, 0);
    assert.match(interaction.__calls.update[0].content, /at or above yours/);
    assert.deepStrictEqual(interaction.__calls.update[0].components, [], 'the buttons are cleared');
});

test('temp role grant refuses a role above the invoker rank', async () => {
    const mod = member('mod', 50);
    const target = member('target', 5, { roles: { highest: { position: 5 }, cache: { has: () => false }, add: async () => {} } });
    const guild = makeGuild({ members: [mod, target] });

    const blocked = await tempRoles.grantTempRole({
        guild, role: role('r-admin', 60), userId: 'target', durationMs: 60000, grantedBy: 'mod', actorId: 'mod',
    });
    assert.match(blocked.error, /not below your highest role/);

    const allowed = await tempRoles.grantTempRole({
        guild, role: role('r-trial', 30), userId: 'target', durationMs: 60000, grantedBy: 'mod', actorId: 'mod',
    });
    assert.ok(allowed.entry, 'a role below the invoker rank is granted');
    assert.strictEqual(allowed.error, undefined);
});

test('temp role grant refuses a member who outranks the invoker', async () => {
    const mod = member('mod', 50);
    const target = member('admin', 80, { roles: { highest: { position: 80 }, cache: { has: () => false }, add: async () => {} } });
    const guild = makeGuild({ members: [mod, target] });

    const blocked = await tempRoles.grantTempRole({
        guild, role: role('r-trial', 30), userId: 'admin', durationMs: 60000, grantedBy: 'mod', actorId: 'mod',
    });
    assert.match(blocked.error, /at or above yours/);
});

test('a dashboard-style grant with no actor id keeps its old behaviour', async () => {
    // The dashboard's mod routes are already owner-gated and carry no Discord
    // id for the session, so the actor check is skipped rather than guessed.
    const admin = member('admin-1', 80);
    admin.roles.add = async () => {};
    const guild = makeGuild({ members: [admin] });
    const allowed = await tempRoles.grantTempRole({
        guild, role: role('r-trial', 30), userId: 'admin-1', durationMs: 60000, grantedBy: 'Dashboard',
    });
    assert.ok(allowed.entry);
});

// Tests for the shared command pipeline — the single execution path behind
// BOTH command surfaces. Covers dispatch/recognition, the owner guard, the
// persistent cooldown, usage tracking, and friendly-error mapping. This
// module had no direct test file, despite being where cooldowns, permission
// checks and error handling actually happen.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate the DB before requiring anything that opens it.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'command-pipeline-test-'));
process.env.DATA_DIR = tmp;
process.env.OWNER_ID = 'owner-1';

const { runCommand, checkCooldown, getFriendlyError } = require('../src/commandPipeline');
const { grantPermission, revokePermission } = require('../src/permissions');
const { getDb, closeDb } = require('../src/db');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

let seq = 0;
function makeInteraction(commandName, { userId = 'user-1', guildId = 'guild-1' } = {}) {
    const calls = { replies: [], edits: [] };
    const interaction = {
        commandName,
        user: { id: userId },
        guild: { id: guildId },
        deferred: false,
        replied: false,
        reply(payload) {
            calls.replies.push(payload);
            interaction.replied = true;
            return Promise.resolve();
        },
        editReply(payload) {
            calls.edits.push(payload);
            return Promise.resolve();
        },
        calls,
    };
    return interaction;
}

// Cooldowns are keyed guild+command+user in SQLite, and the owner guard
// checks the command NAME against publicCommands — so tests vary the guild
// (never the command name) to stay isolated without changing behaviour.
function uniqueGuild(base) {
    return base + '-' + (++seq);
}

test('unknown command returns false and never replies', async () => {
    const interaction = makeInteraction('definitely-not-a-command');
    assert.strictEqual(await runCommand(interaction), false);
    assert.strictEqual(interaction.calls.replies.length, 0);
});

test('recognized command runs its handler and records command usage', async () => {
    const guild = uniqueGuild('g-usage');
    const id = makeInteraction('ping', { guildId: guild });
    let ran = 0;
    const handled = await runCommand(id, async () => { ran++; });

    assert.strictEqual(handled, true);
    assert.strictEqual(ran, 1);

    const row = getDb().prepare('SELECT COUNT(*) AS n FROM command_usage WHERE guild_id = ? AND command = ? AND user_id = ?')
        .get(guild, 'ping', 'user-1');
    assert.strictEqual(row.n, 1);
});

test('public commands skip the owner guard', async () => {
    // 'ping' is in publicCommands, so a random user runs it without a grant.
    const id = makeInteraction('ping', { userId: 'random-user', guildId: uniqueGuild('g-public') });
    let ran = 0;
    await runCommand(id, async () => { ran++; });
    assert.strictEqual(ran, 1);
});

test('non-public command is blocked for a user without a grant', async () => {
    const id = makeInteraction('ban', { userId: 'random-user', guildId: 'guild-guard-1' });
    let ran = 0;
    const handled = await runCommand(id, async () => { ran++; });

    assert.strictEqual(handled, true, 'command is recognized, just refused');
    assert.strictEqual(ran, 0, 'handler must not run');
    assert.match(id.calls.replies[0].content, /don't have permission/i);
});

test('the bot owner bypasses the owner guard', async () => {
    const id = makeInteraction('ban', { userId: 'owner-1', guildId: 'guild-guard-2' });
    let ran = 0;
    await runCommand(id, async () => { ran++; });
    assert.strictEqual(ran, 1);
});

test('a user granted the command via /perm may run it', async () => {
    const guild = uniqueGuild('g-grant');
    grantPermission(guild, 'ban', 'trusted-user');
    const id = makeInteraction('ban', { userId: 'trusted-user', guildId: guild });
    let ran = 0;
    await runCommand(id, async () => { ran++; });
    assert.strictEqual(ran, 1);

    // Revoking takes effect immediately (the permission cache is invalidated).
    // A fresh guild is used for the second call so the /ban cooldown — which
    // is keyed by guild — can't be what blocks it.
    revokePermission(guild, 'ban', 'trusted-user');
    const id2 = makeInteraction('ban', { userId: 'trusted-user', guildId: uniqueGuild('g-grant-revoked') });
    let ran2 = 0;
    await runCommand(id2, async () => { ran2++; });
    assert.strictEqual(ran2, 0, 'revoked grant must block the next call');
    assert.match(id2.calls.replies[0].content, /don't have permission/i, 'blocked by the guard, not the cooldown');
});

test('cooldown blocks the second run inside the window', async () => {
    // 'deploy' has a 30s override; the owner passes the guard, so the only
    // thing that can block the second call is the cooldown itself.
    const guild = uniqueGuild('g-cd');
    let ran = 0;
    const first = makeInteraction('deploy', { userId: 'owner-1', guildId: guild });
    await runCommand(first, async () => { ran++; });

    const second = makeInteraction('deploy', { userId: 'owner-1', guildId: guild });
    const handled = await runCommand(second, async () => { ran++; });

    assert.strictEqual(ran, 1, 'handler runs once');
    assert.strictEqual(handled, true);
    assert.match(second.calls.replies[0].content, /Please wait/i);
});

test('checkCooldown: zero-cooldown commands are always allowed', async () => {
    // 'shutdown' is overridden to 0 seconds — an override of 0 must mean
    // "no cooldown", not "fall back to the default".
    assert.strictEqual(await checkCooldown('shutdown', 'u', 'g'), true);
    assert.strictEqual(await checkCooldown('shutdown', 'u', 'g'), true);
});

test('checkCooldown: the per-command override sets the window', async () => {
    const guild = uniqueGuild('g-cd2');
    assert.strictEqual(await checkCooldown('purge', 'u1', guild), true);
    const second = await checkCooldown('purge', 'u1', guild);
    assert.notStrictEqual(second, true);
    const remaining = Number(second.remaining);
    assert.ok(remaining > 0, 'remaining seconds reported');
    assert.ok(remaining <= 5, `purge override is 5s, got ${remaining}`);
});

test('a throwing handler is converted into a friendly ephemeral reply', async () => {
    const id = makeInteraction('ping', { guildId: uniqueGuild('g-err') });
    await runCommand(id, async () => { throw new Error('Missing Permissions'); });
    assert.match(id.calls.replies[0].content, /required permission/i);
    assert.strictEqual(id.calls.replies[0].ephemeral, true);
});

test('a throwing handler after defer replies through editReply', async () => {
    const id = makeInteraction('ping', { guildId: uniqueGuild('g-err-2') });
    id.deferred = true;
    await runCommand(id, async () => { throw new Error('Unknown Channel'); });
    assert.strictEqual(id.calls.replies.length, 0);
    assert.match(id.calls.edits[0].content, /no longer exists/i);
});

test('getFriendlyError maps the common Discord failures', () => {
    assert.match(getFriendlyError(new Error('Missing Access')), /access/i);
    assert.match(getFriendlyError(new Error('Unknown User')), /not found/i);
    assert.match(getFriendlyError(new Error('Unknown Role')), /no longer exists/i);
    assert.match(getFriendlyError(new Error('ECONNRESET')), /Could not reach Discord/i);
    // Unmapped errors fall back to a generic message that doesn't leak internals.
    const generic = getFriendlyError(new Error('kaboom-internal-detail'), 'mycmd');
    assert.match(generic, /error occurred/i);
    assert.ok(!generic.includes('kaboom-internal-detail'), 'internal message must not leak to users');
});

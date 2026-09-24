// Tests for the per-command permission model — the whole authorization
// surface for non-public commands (owner, or an explicit grant of one
// command to one user per guild). Untested before this file.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'permissions-test-'));
process.env.DATA_DIR = tmp;

const {
    grantPermission, revokePermission, hasPermission,
    getGrantedUsers, getAllPermissions, invalidatePermissionCache,
} = require('../src/permissions');
const { getDb, closeDb } = require('../src/db');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('grants are per guild, per command, per user', () => {
    grantPermission('g1', 'ban', 'mod-a');
    grantPermission('g1', 'ban', 'mod-b');
    grantPermission('g1', 'kick', 'mod-a');
    grantPermission('g2', 'ban', 'other-guild-user');

    assert.strictEqual(hasPermission('g1', 'ban', 'mod-a'), true);
    assert.strictEqual(hasPermission('g1', 'ban', 'mod-b'), true);
    assert.strictEqual(hasPermission('g1', 'kick', 'mod-a'), true);
    // Granting /ban must not grant /kick or any other command
    assert.strictEqual(hasPermission('g1', 'kick', 'mod-b'), false);
    // Grants never leak across guilds
    assert.strictEqual(hasPermission('g1', 'ban', 'other-guild-user'), false);
    assert.strictEqual(hasPermission('g2', 'ban', 'mod-a'), false);
    // Unknown user
    assert.strictEqual(hasPermission('g1', 'ban', 'nobody'), false);
});

test('an empty grant set denies everything (fail-closed)', () => {
    assert.strictEqual(hasPermission('guild-with-nothing', 'ban', 'someone'), false);
    assert.deepStrictEqual(getAllPermissions('guild-with-nothing'), {});
    assert.deepStrictEqual(getGrantedUsers('guild-with-nothing', 'ban'), []);
});

test('granting twice is idempotent', () => {
    grantPermission('g-idem', 'warn', 'mod-a');
    grantPermission('g-idem', 'warn', 'mod-a');
    assert.deepStrictEqual(getGrantedUsers('g-idem', 'warn'), ['mod-a']);
});

test('revoking removes exactly one user and takes effect immediately', () => {
    grantPermission('g-revoke', 'ban', 'mod-a');
    grantPermission('g-revoke', 'ban', 'mod-b');

    revokePermission('g-revoke', 'ban', 'mod-a');

    assert.strictEqual(hasPermission('g-revoke', 'ban', 'mod-a'), false);
    assert.strictEqual(hasPermission('g-revoke', 'ban', 'mod-b'), true);
});

test('revoking a user who was never granted is a no-op', () => {
    revokePermission('g-noop', 'ban', 'ghost');
    assert.strictEqual(hasPermission('g-noop', 'ban', 'ghost'), false);
});

test('getAllPermissions returns command → users, and the cache survives reads', () => {
    grantPermission('g-all', 'ban', 'u1');
    grantPermission('g-all', 'kick', 'u2');
    grantPermission('g-all', 'kick', 'u3');

    assert.deepStrictEqual(getAllPermissions('g-all'), {
        ban: ['u1'],
        kick: ['u2', 'u3'],
    });

    // A cached read must agree with the DB-backed one
    invalidatePermissionCache('g-all');
    assert.deepStrictEqual(getAllPermissions('g-all'), {
        ban: ['u1'],
        kick: ['u2', 'u3'],
    });
});

test('changing the database behind a warm cache is not visible until invalidation', () => {
    grantPermission('g-direct', 'ban', 'u1');
    assert.strictEqual(hasPermission('g-direct', 'ban', 'u2'), false);

    // Simulate an out-of-band write (e.g. an import) that skips the helpers
    getDb().prepare('INSERT INTO permissions (guild_id, command, user_id) VALUES (?, ?, ?)')
        .run('g-direct', 'ban', 'u2');
    assert.strictEqual(hasPermission('g-direct', 'ban', 'u2'), false, 'cache still holds the old view');

    invalidatePermissionCache('g-direct');
    assert.strictEqual(hasPermission('g-direct', 'ban', 'u2'), true, 'invalidation exposes the new row');
});

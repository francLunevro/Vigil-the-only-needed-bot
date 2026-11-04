// ─── Command visibility ───
// `default_member_permissions` is enforced by Discord itself: a member without
// the permission never reaches the command, and Administrator holders always
// bypass it. Not one of the ~50 non-public commands used to set it, so kick,
// ban, config and the bot-owner plumbing were all listed in every member's
// picker in every server.
//
// These tests pin the policy and, more importantly, keep it honest: every
// registered command has to be classified, nothing public may be restricted,
// and the fields tested here are the exact objects deployCommands PUTs.
const { test } = require('node:test');
const assert = require('node:assert');
const { PermissionFlagsBits, InteractionContextType } = require('discord.js');

const { commandDefs } = require('../src/deploy');
const { commandRegistry, publicCommands } = require('../src/commands/registry');
const { MODERATION_COMMANDS, ADMIN_COMMANDS, permissionFor } = require('../src/commandPolicy');

const byName = new Map(commandDefs.map((d) => [d.name, d]));

test('every registered command is classified', () => {
    const unclassified = Object.keys(commandRegistry).filter((name) =>
        !publicCommands.includes(name) && !MODERATION_COMMANDS.has(name) && !ADMIN_COMMANDS.has(name));
    assert.deepStrictEqual(unclassified, [], 'new commands must be classified in src/commandPolicy.js');
});

test('the policy has no typos or stale entries', () => {
    for (const name of [...MODERATION_COMMANDS, ...ADMIN_COMMANDS]) {
        assert.ok(commandRegistry[name], name + ' is in the policy but has no handler');
        assert.ok(!publicCommands.includes(name), name + ' is public and must not be restricted');
        assert.ok(byName.has(name), name + ' is in the policy but has no command definition');
    }
});

test('public commands stay open to everyone', () => {
    for (const name of publicCommands) {
        assert.strictEqual(byName.get(name).default_member_permissions, undefined,
            name + ' is public — restricting it would hide it from the members it is for');
    }
});

test('every non-public command carries a permission', () => {
    for (const [name, def] of byName) {
        if (publicCommands.includes(name)) continue;
        const expected = permissionFor(name);
        assert.notStrictEqual(expected, null, name + ' has no permission');
        assert.strictEqual(def.default_member_permissions, expected.toString(), name);
    }
});

test('moderation needs Moderate Members, configuration needs Manage Server', () => {
    const mod = PermissionFlagsBits.ModerateMembers.toString();
    const admin = PermissionFlagsBits.ManageGuild.toString();
    assert.strictEqual(byName.get('kick').default_member_permissions, mod);
    assert.strictEqual(byName.get('warn').default_member_permissions, mod);
    assert.strictEqual(byName.get('automod').default_member_permissions, admin);
    assert.strictEqual(byName.get('shutdown').default_member_permissions, admin);
    assert.strictEqual(PermissionFlagsBits.ModerateMembers.toString(), '1099511627776');
    assert.strictEqual(PermissionFlagsBits.ManageGuild.toString(), '32');
});

test('every command is registered guild-only', () => {
    // Cooldowns and config are per-guild and the pipeline reads
    // `interaction.guild.id` before anything else, so a DM invocation throws.
    for (const def of commandDefs) {
        assert.deepStrictEqual(def.contexts, [InteractionContextType.Guild], def.name + ' must be guild-only');
    }
});

test('the deploy payload is the object the policy was applied to', () => {
    // deployCommands PUTs `commandDefs` as-is, so these are the fields Discord
    // receives — no second copy can drift out of sync.
    const restricted = commandDefs.filter((d) => d.default_member_permissions !== undefined);
    assert.strictEqual(restricted.length, commandDefs.length - publicCommands.length);
    assert.strictEqual(commandDefs.length, Object.keys(commandRegistry).length);
});

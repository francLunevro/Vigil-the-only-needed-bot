// `/report` was gated like a staff command: it was absent from the registry's
// publicCommands (so ownerGuard refused every ordinary member) and listed as a
// ModerateMembers command in commandPolicy.js (so Discord refused the
// invocation before the bot saw it). The reports screen is built for member
// reports, so the queue could only ever fill from staff.
//
// These tests pin the fix at both gates and prove the real handler runs for a
// plain member: the report is stored and the member gets the success receipt.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'report-access-'));
process.env.DATA_DIR = tmp;
process.env.OWNER_ID = 'owner-1';

const { runCommand } = require('../src/commandPipeline');
const { publicCommands, commandRegistry } = require('../src/commands/registry');
const { MODERATION_COMMANDS, ADMIN_COMMANDS, permissionFor, applyCommandPolicy } = require('../src/commandPolicy');
const { getDb, closeDb } = require('../src/db');

after(() => {
    try { closeDb(); } catch { /* already closed */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

function makeReportInteraction({ guildId = 'guild-report', userId = 'member-1' } = {}) {
    const target = { id: 'target-1', tag: 'Target#0001', username: 'Target', bot: false, displayAvatarURL: () => null };
    const interaction = {
        commandName: 'report',
        user: { id: userId, tag: 'Member#0001' },
        guild: { id: guildId, name: 'Report Guild', members: { fetch: async () => null, cache: new Map() } },
        channel: { id: 'chan-1', messages: { fetch: async () => null } },
        deferred: false,
        replied: false,
        last: null,
        options: {
            getUser: () => target,
            getString: (name) => (name === 'reason' ? 'posting scam links' : null),
        },
        reply(payload) {
            interaction.replied = true;
            interaction.last = payload;
            return Promise.resolve();
        },
        editReply(payload) {
            interaction.last = payload;
            return Promise.resolve(payload);
        },
    };
    return interaction;
}

test('/report is a public command at both gates', () => {
    assert.ok(publicCommands.includes('report'), 'the pipeline guard must let members through');
    assert.ok(!MODERATION_COMMANDS.has('report'), 'Discord must not require Moderate Members to invoke it');
    assert.ok(!ADMIN_COMMANDS.has('report'));
    assert.strictEqual(permissionFor('report'), null);

    const def = applyCommandPolicy({ name: 'report', description: 'Report a member' });
    assert.strictEqual(def.default_member_permissions, undefined,
        'a restricted /report is hidden from the members it exists for');
    assert.ok(commandRegistry.report, 'the handler stays registered');
});

test('an ordinary member can file a report through the real command pipeline', async () => {
    const interaction = makeReportInteraction({ guildId: 'guild-report-live', userId: 'just-a-member' });
    const handled = await runCommand(interaction);

    assert.strictEqual(handled, true, 'the command is recognized');
    assert.ok(interaction.last, 'the member got a reply');
    const content = interaction.last.content || '';
    assert.ok(!/don't have permission/i.test(content), 'the owner guard must not refuse a member');
    assert.ok(Array.isArray(interaction.last.embeds) && interaction.last.embeds.length === 1,
        'the success receipt is an embed, not a refusal');
    assert.strictEqual(interaction.last.ephemeral, true);

    const row = getDb().prepare('SELECT * FROM reports WHERE guild_id = ?').get('guild-report-live');
    assert.ok(row, 'the report reached the queue');
    assert.strictEqual(row.reporter_id, 'just-a-member');
    assert.strictEqual(row.target_id, 'target-1');
    assert.strictEqual(row.status, 'pending');
    assert.strictEqual(row.reason, 'posting scam links');
});

test('staff-only commands are still refused for the same member', async () => {
    // The control: making /report public must not have opened anything else.
    const interaction = makeReportInteraction({ guildId: 'guild-control', userId: 'just-a-member' });
    interaction.commandName = 'ban';
    let ran = 0;
    await runCommand(interaction, async () => { ran++; });
    assert.strictEqual(ran, 0, 'the guard still blocks /ban');
    assert.match(interaction.last.content, /don't have permission/i);
});

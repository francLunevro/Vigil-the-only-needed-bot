'use strict';
// Tests for manual-kick logging on guildMemberRemove:
//   1. Manual kick (human executor in the audit log) → Wick-style Kick embed
//      in the moderation category, no generic "Member Left" embed.
//   2. Kick performed by this bot → silent here (the command handler logged).
//   3. Plain leave (no fresh audit entry) → generic "Member Left" embed.
//   4. Manual ban → silent here (guildBanAdd in extras.js logs it).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate BEFORE requiring db — DB_PATH is computed at module load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kick-log-test-'));
process.env.DATA_DIR = tmp;

const { closeDb } = require('../src/db');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

const events = require('../src/events/members');
const removeHandler = events.find((e) => e.name === 'guildMemberRemove');
assert.ok(removeHandler, 'guildMemberRemove event exists');

const TARGET_USER = {
    id: '555000111',
    username: 'ZtUi3Vc',
    tag: 'ZtUi3Vc#0001',
    bot: false,
    createdTimestamp: Date.now() - 400 * 86400000,
    displayAvatarURL: () => 'https://cdn.example/avatar.png',
    toString() { return '<@555000111>'; },
};

const HUMAN_MOD = {
    id: '111',
    tag: 'BossMod#0001',
    bot: false,
    displayAvatarURL: () => 'https://cdn.example/mod.png',
};

const SELF_BOT = {
    id: 'BOTID',
    tag: 'Vigil#0000',
    bot: true,
    displayAvatarURL: () => 'https://cdn.example/bot.png',
};

function auditEntry(executor, type, reason) {
    return {
        actionType: type,
        targetId: TARGET_USER.id,
        executor,
        createdTimestamp: Date.now() - 1000,
        reason: reason || null,
    };
}

function makeMember({ audits }) {
    return {
        id: TARGET_USER.id,
        user: TARGET_USER,
        bot: false,
        client: { user: { id: 'BOTID' } },
        guild: {
            id: 'g1',
            name: 'Test Guild',
            memberCount: 42,
            iconURL: () => null,
            fetchAuditLogs: async ({ type }) => {
                const hits = audits.filter((a) => a.actionType === type);
                return { entries: Object.assign([...hits], { size: hits.length }) };
            },
        },
        joinedAt: new Date(Date.now() - 3 * 86400000),
        joinedTimestamp: Date.now() - 3 * 86400000,
        roles: { cache: { filter: () => ({ map: () => [] }) } },
    };
}

const DEPS = {
    recordLeave: () => {},
    formatUptime: () => '3 days',
    truncate: (s) => s,
};

async function runRemove(member) {
    const sent = [];
    const deps = Object.assign({}, DEPS, {
        sendLog: (embed, category) => { sent.push({ category, embed }); },
    });
    await removeHandler.execute(deps)(member);
    return sent;
}

test('manual kick → Wick-style Kick log in moderation, no generic left embed', async () => {
    const member = makeMember({ audits: [auditEntry(HUMAN_MOD, 20, 'raiding')] });
    const sent = await runRemove(member);
    assert.strictEqual(sent.length, 1, 'exactly one log entry');
    assert.strictEqual(sent[0].category, 'moderation');
    const e = sent[0].embed.data;
    assert.strictEqual(e.title, 'Kick ZtUi3Vc');
    assert.strictEqual(e.color, 0xE74C3C);
    assert.strictEqual(e.fields.find((f) => f.name === 'Reason').value, 'raiding');
    assert.strictEqual(e.fields.find((f) => f.name === 'User').value, '@ZtUi3Vc (<@555000111>)');
    assert.strictEqual(e.footer.text, 'BossMod#0001');
    assert.ok(e.fields.find((f) => f.name === 'Membership'), 'membership info preserved');
    assert.ok(e.thumbnail.url, 'target avatar as thumbnail');
});

test('kick without a reason → "No reason provided"', async () => {
    const member = makeMember({ audits: [auditEntry(HUMAN_MOD, 20, null)] });
    const sent = await runRemove(member);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].embed.data.fields.find((f) => f.name === 'Reason').value, 'No reason provided');
});

test('kick performed by this bot → silent (command handler already logged)', async () => {
    const member = makeMember({ audits: [auditEntry(SELF_BOT, 20, 'spamming')] });
    const sent = await runRemove(member);
    assert.strictEqual(sent.length, 0);
});

test('manual ban → silent here (guildBanAdd event logs it Wick-style)', async () => {
    const member = makeMember({ audits: [auditEntry(HUMAN_MOD, 22, 'ban evasion')] });
    const sent = await runRemove(member);
    assert.strictEqual(sent.length, 0);
});

test('plain leave → generic "Member Left" embed in members category', async () => {
    const member = makeMember({ audits: [] });
    const sent = await runRemove(member);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].category, 'members');
    assert.strictEqual(sent[0].embed.data.title, '\uD83D\uDEAA Member Left');
});

test('stale audit entry (>15s old) counts as a plain leave', async () => {
    const member = makeMember({ audits: [] });
    // Manually age the entry beyond the freshness window.
    const stale = auditEntry(HUMAN_MOD, 20, 'old');
    stale.createdTimestamp = Date.now() - 60000;
    member.guild.fetchAuditLogs = async () => ({ entries: Object.assign([stale], { size: 1 }) });
    const sent = await runRemove(member);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].category, 'members', 'falls back to the generic left embed');
});

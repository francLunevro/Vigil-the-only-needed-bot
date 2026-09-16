'use strict';
// Tests for the Wick/Carl-style mod log embeds:
//   1. modActionLogEmbed — colored side bar, "Verb Username" title, pingable
//      user field, target avatar thumbnail, moderator footer.
//   2. relativeTime — chip-style "2 years ago" strings.
//   3. userStatsValue — the report embed's User stats block.
//   4. Integration: approving/dismissing a dashboard report posts a
//      "Report accepted"/"Report dismissed" log to the log channel.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate BEFORE requiring db — DB_PATH is computed at module load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'modlog-style-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { closeDb } = require('../src/db');
const { relativeTime, modActionLogEmbed, userStatsValue, setLoggerClient, sendLog } = require('../src/logging');
const { updateGuildConfig } = require('../src/config');
const reports = require('../src/reports');
const { createCase } = require('../src/modCases');

// ─── Mock user/member shapes ───
function avatarFor(size) { return 'https://cdn.example/avatar-' + (size && size.size ? size.size : 128) + '.png'; }

const TARGET = {
    id: '555000111',
    username: 'ZtUi3Vc',
    tag: 'ZtUi3Vc#0001',
    createdTimestamp: Date.now() - 2 * 31557600000, // ~2 years ago
    displayAvatarURL: avatarFor,
};

const MOD = {
    id: '999',
    username: 'mod_user',
    tag: 'mod_user#0009',
    displayAvatarURL: avatarFor,
};

const MEMBER = { id: TARGET.id, joinedTimestamp: Date.now() - 24 * 86400000 }; // 24 days ago

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ─── relativeTime ───

test('relativeTime: years / days / hours / minutes / just now / future', () => {
    assert.strictEqual(relativeTime(Date.now() - 2 * 31557600000), '2 years ago');
    assert.strictEqual(relativeTime(Date.now() - 24 * 86400000), '24 days ago');
    assert.strictEqual(relativeTime(Date.now() - 13 * 86400000), '13 days ago');
    assert.strictEqual(relativeTime(Date.now() - 90 * 60000), '1 hour ago');
    assert.strictEqual(relativeTime(Date.now() - 2 * 60000), '2 minutes ago');
    assert.strictEqual(relativeTime(Date.now() - 5000), 'just now');
    assert.strictEqual(relativeTime(Date.now() + 3 * 86400000), '3 days from now');
    assert.strictEqual(relativeTime(0), null);
    assert.strictEqual(relativeTime(null), null);
});

// ─── modActionLogEmbed: the screenshot contract ───

test('mute log: "Mute <username>" title, user field with pingable mention, duration', () => {
    const e = modActionLogEmbed({
        verb: 'Mute', color: 0xE74C3C,
        target: TARGET, moderator: MOD,
        reason: '10',
        duration: 'Permanent',
    });
    assert.strictEqual(e.data.title, 'Mute ZtUi3Vc'); // raw username, no @
    assert.strictEqual(e.data.color, 0xE74C3C);       // red side bar
    const user = e.data.fields.find((f) => f.name === 'User');
    assert.ok(user, 'has User field');
    assert.strictEqual(user.value, '@ZtUi3Vc (<@555000111>)');
    assert.strictEqual(e.data.fields.find((f) => f.name === 'Reason').value, '10');
    assert.strictEqual(e.data.fields.find((f) => f.name === 'Duration').value, 'Permanent');
    assert.strictEqual(e.data.thumbnail.url, 'https://cdn.example/avatar-128.png');
    assert.strictEqual(e.data.footer.text, 'mod_user#0009');
    assert.strictEqual(e.data.footer.icon_url, 'https://cdn.example/avatar-64.png');
    assert.ok(e.data.timestamp, 'embed has a timestamp');
});

test('default reason and optional Duration/Proof fields', () => {
    const e = modActionLogEmbed({ verb: 'Ban', color: 0xE74C3C, target: TARGET, moderator: MOD });
    assert.strictEqual(e.data.title, 'Ban ZtUi3Vc');
    assert.strictEqual(e.data.fields.find((f) => f.name === 'Reason').value, 'No reason provided');
    assert.ok(!e.data.fields.some((f) => f.name === 'Duration'), 'no Duration when omitted');
    assert.ok(!e.data.fields.some((f) => f.name === 'Proof'), 'no Proof when omitted');

    const p = modActionLogEmbed({ verb: 'Ban', color: 0xE74C3C, target: TARGET, moderator: MOD, reason: 'cheating', proof: 'its ok u can be best counterer' });
    assert.strictEqual(p.data.fields.find((f) => f.name === 'Proof').value, 'its ok u can be best counterer');
});

test('green reversal log and unknown-moderator fallback', () => {
    const e = modActionLogEmbed({ verb: 'Unmute', color: 0x2ECC71, target: TARGET, moderator: null });
    assert.strictEqual(e.data.title, 'Unmute ZtUi3Vc');
    assert.strictEqual(e.data.color, 0x2ECC71);
    assert.strictEqual(e.data.footer.text, 'Moderator unknown');
    assert.strictEqual(e.data.footer.icon_url, undefined);
});

test('extraFields append after the default set', () => {
    const e = modActionLogEmbed({
        verb: 'Warn', color: 0xF1C40F,
        target: TARGET, moderator: MOD, reason: 'spam',
        extraFields: [{ name: 'Warning Count', value: '3' }],
    });
    const names = e.data.fields.map((f) => f.name);
    assert.deepStrictEqual(names, ['User', 'Reason', 'Warning Count']);
});

test('fields override replaces the default set (report embeds)', () => {
    const e = modActionLogEmbed({
        title: '✅ Report accepted',
        color: 0x2ECC71,
        target: TARGET,
        footerText: 'kestrys. accepted this report',
        fields: [
            { name: 'Reason(s)', value: 'AutoMod Report' },
            { name: 'Reported by', value: 'Sapphire#8184 (<@777>)' },
        ],
    });
    assert.strictEqual(e.data.title, '✅ Report accepted');
    const names = e.data.fields.map((f) => f.name);
    assert.ok(!names.includes('Reason'), 'default Reason field not added when fields override');
    assert.ok(!names.includes('User'), 'default User field not added when fields override');
    assert.deepStrictEqual(names, ['Reason(s)', 'Reported by']);
    assert.strictEqual(e.data.footer.text, 'kestrys. accepted this report');
});

// ─── userStatsValue: the report User block ───

test('userStatsValue: ID / Created / Joined / Last case chips', () => {
    const lastCase = { action_type: 'warn', created_at: Date.now() - 13 * 86400000 };
    const v = userStatsValue({ user: TARGET, member: MEMBER, lastCase });
    const lines = v.split('\n');
    assert.ok(lines[0].includes('**User:** @ZtUi3Vc (<@555000111>)'));
    assert.ok(lines[1].includes('**ID:** `555000111`'));
    assert.ok(lines[2].includes('**Created:** `2 years ago`'));
    assert.ok(lines[3].includes('**Joined:** `24 days ago`'));
    assert.ok(lines[4].includes('**Last case:** `WARN` `13 days ago`'));
});

test('userStatsValue: skips missing pieces', () => {
    const v = userStatsValue({ user: { id: '42', username: 'x' }, member: null, lastCase: null });
    assert.ok(!v.includes('Joined'), 'no Joined line without member');
    assert.ok(!v.includes('Last case'), 'no Last case line without history');
    assert.ok(!v.includes('Created'), 'no Created line without timestamp');
    assert.ok(v.includes('<@42>'));
});

// ─── Integration: dashboard report review posts a Wick-style log ───

const sent = [];
const channels = {};
function makeChannel(id) {
    if (!channels[id]) {
        channels[id] = {
            id,
            guildId: 'g1',
            send: async (msg) => { sent.push({ channelId: id, msg }); },
        };
    }
    return channels[id];
}

const { createDashboard, setDashboardClient } = require('../src/dashboard');
setDashboardClient({
    guilds: { cache: new Map([['g1', {
        id: 'g1',
        members: { fetch: async () => MEMBER },
    }]]) },
    users: { fetch: async () => TARGET },
}, 'test-password');

setLoggerClient({
    channels: {
        cache: { get: (id) => channels[id] || null },
        fetch: async (id) => channels[id] || makeChannel(id),
    },
});

updateGuildConfig('g1', (g) => {
    g.logChannelId = 'log-ch';
    return g;
});

const app = createDashboard();
const server = http.createServer(app);
let PORT;
let cookie;

function request(method, p, { body, headers } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                ...headers,
            },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function waitFor(fn, ms = 1500) {
    const start = Date.now();
    while (Date.now() - start < ms) {
        if (fn()) return true;
        await new Promise((r) => setTimeout(r, 25));
    }
    return fn();
}

after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
});

test('setup: dashboard listening + login', async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
    const res = await request('POST', '/api/login', { body: { password: 'test-password' } });
    assert.strictEqual(res.status, 200);
    cookie = (res.headers['set-cookie'] || [''])[0].split(';')[0];
});

test('approving a report posts "Report accepted" to the log channel', async () => {
    sent.length = 0;
    const rep = reports.createReport('g1', 'u1', 'Alice#1234', TARGET.id, TARGET.tag, 'AutoMod Report', 'flag message', 'm1');
    createCase('g1', TARGET.id, '999', 'mod_user#0009', 'warn', 'earlier offense');
    const res = await request('PUT', '/api/server/g1/reports/' + rep.id, {
        body: { status: 'approved', reviewedBy: 'kestrys.' },
        headers: { cookie },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(await waitFor(() => sent.length > 0), 'log message sent');
    const embed = sent[0].msg.embeds[0];
    assert.strictEqual(embed.data.title, '✅ Report accepted');
    assert.strictEqual(embed.data.color, 0x2ECC71);
    const userField = embed.data.fields.find((f) => f.name === 'User');
    assert.ok(userField.value.includes('**ID:** `555000111`'));
    assert.ok(userField.value.includes('**Last case:** `WARN`'));
    assert.ok(embed.data.fields.some((f) => f.name === 'Highlighted message(s)' && f.value === 'flag message'));
    assert.ok(embed.data.fields.some((f) => f.name === 'Reported by' && f.value.includes('Alice#1234')));
    assert.strictEqual(embed.data.footer.text, 'kestrys. accepted this report');
    assert.strictEqual(embed.data.thumbnail.url, 'https://cdn.example/avatar-128.png');
});

test('dismissing a report posts "Report dismissed" to the log channel', async () => {
    sent.length = 0;
    const rep = reports.createReport('g1', 'u1', 'Alice#1234', TARGET.id, TARGET.tag, 'heated moment');
    const res = await request('PUT', '/api/server/g1/reports/' + rep.id, {
        body: { status: 'dismissed', reviewedBy: 'kestrys.' },
        headers: { cookie },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(await waitFor(() => sent.length > 0), 'log message sent');
    const embed = sent[0].msg.embeds[0];
    assert.strictEqual(embed.data.title, '🔕 Report dismissed');
    assert.strictEqual(embed.data.color, 0x95A5A6);
    assert.strictEqual(embed.data.footer.text, 'kestrys. dismissed this report');
});

test('sendLog delivers a mod action embed through the moderation category', async () => {
    sent.length = 0;
    const e = modActionLogEmbed({ verb: 'Mute', color: 0xE74C3C, target: TARGET, moderator: MOD, reason: '10', duration: 'Permanent' });
    await sendLog(e, 'moderation', null, 'g1');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].channelId, 'log-ch');
    assert.strictEqual(sent[0].msg.embeds[0].data.title, 'Mute ZtUi3Vc');
});

// ─── Proof support: /ban, /tempban, /timeout ───

test('deploy: ban, tempban and timeout expose an optional proof option', () => {
    const deploy = require('../src/deploy');
    for (const name of ['ban', 'tempban', 'timeout']) {
        const def = deploy.commandDefs.find((c) => c.name === name);
        assert.ok(def, name + ' command exists');
        const proof = def.options.find((o) => o.name === 'proof');
        assert.ok(proof, name + ' has a proof option');
        assert.strictEqual(proof.required, false);
        assert.strictEqual(proof.max_length, 1000);
    }
});

test('ban confirm embed carries the Proof field into the flow', async () => {
    const { executeBan } = require('../src/commands/moderation');
    const replies = [];
    await executeBan({
        options: {
            getUser: () => TARGET,
            getString: (n) => ({ reason: 'cheating', delete_messages: 'none', proof: 'its ok u can be best counterer' }[n] || null),
        },
        guild: {
            id: 'g1', name: 'G', iconURL: () => null,
            members: { me: { permissions: { has: () => true } }, fetch: async () => ({ bannable: true }) },
        },
        user: MOD,
        reply: async (p) => { replies.push(p); },
    });
    assert.strictEqual(replies.length, 1);
    const proof = replies[0].embeds[0].data.fields.find((f) => f.name === 'Proof');
    assert.ok(proof, 'Proof field present on confirm embed');
    assert.strictEqual(proof.value, 'its ok u can be best counterer');
});

test('bot /kick confirm log includes the Was-Here membership chip', async () => {
    sent.length = 0;
    const { handleInteraction } = require('../src/interactions');
    const kickedMember = {
        id: TARGET.id,
        user: TARGET,
        kickable: true,
        kick: async () => {},
        joinedTimestamp: Date.now() - 24 * 86400000, // 24 days ago
    };
    await handleInteraction({
        isButton: () => true,
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        isUserSelect: () => false,
        customId: 'ck_999_555000111', // initiator 999 (MOD), target 555000111
        user: MOD,
        guild: {
            id: 'g1',
            members: {
                me: { permissions: { has: () => true } },
                fetch: async () => kickedMember,
            },
        },
        message: { embeds: [{ fields: [{ name: 'Reason', value: 'raiding' }] }] },
        update: async () => {},
    });
    assert.ok(await waitFor(() => sent.length > 0), 'kick log sent');
    const embed = sent[0].msg.embeds[0];
    assert.strictEqual(embed.data.title, 'Kick ZtUi3Vc');
    assert.strictEqual(embed.data.footer.text, 'mod_user#0009');
    const membership = embed.data.fields.find((f) => f.name === 'Membership');
    assert.ok(membership, 'Membership field present on bot kick log');
    assert.ok(membership.value.includes('Joined: <t:'), 'Joined timestamp chip');
    assert.ok(membership.value.includes('Was here: 24d'), 'Was-here duration chip');
});

test('mute log includes the proof from /timeout', async () => {
    sent.length = 0;
    const { executeTimeout } = require('../src/commands/moderation');
    const timeoutMember = { id: TARGET.id, moderatable: true, timeout: async () => {} };
    await executeTimeout({
        options: {
            getUser: () => TARGET,
            getString: (n) => ({ duration: '10m', reason: 'spam', proof: 'clip link' }[n] || null),
        },
        guild: {
            id: 'g1',
            members: { me: { permissions: { has: () => true } }, fetch: async () => timeoutMember },
        },
        user: MOD,
        reply: async () => {},
    });
    assert.ok(sent.length > 0, 'log sent');
    const embed = sent[sent.length - 1].msg.embeds[0];
    assert.strictEqual(embed.data.title, 'Mute ZtUi3Vc');
    assert.ok(embed.data.fields.find((f) => f.name === 'Duration'), 'Duration field present');
    assert.strictEqual(embed.data.fields.find((f) => f.name === 'Proof').value, 'clip link');
});

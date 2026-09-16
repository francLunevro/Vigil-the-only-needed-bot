'use strict';
// Dedicated 🧩 Applications log category for bots and webhooks:
//   · guildMemberAdd for bots → 'applications' category, Wick-style with
//     the Application Added title, inviter info, and bot-badge fields.
//   · webhooksUpdate → 'applications' category with webhook name/ID and
//     the executor (who added/removed/updated it).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate BEFORE requiring db — DB_PATH is computed at module load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-log-test-'));
process.env.DATA_DIR = tmp;

const { closeDb } = require('../src/db');
const { setLoggerClient } = require('../src/logging');
const { updateGuildConfig } = require('../src/config');

// ─── Mock client with a capture channel ───
const sent = [];
const fakeChannel = {
    id: 'log-ch',
    guildId: 'g1',
    send: async (payload) => { sent.push(payload); },
};
setLoggerClient({
    channels: {
        cache: { get: (id) => (id === 'log-ch' ? fakeChannel : null) },
        fetch: async (id) => (id === 'log-ch' ? fakeChannel : null),
    },
});
updateGuildConfig('g1', (g) => {
    g.logChannelId = 'log-ch';
    return g;
});

const events = require('../src/events/members');
const serverEvents = require('../src/events/server');

function deps() {
    return {
        sendLog: (embed, category, channelId, guildId) => {
            sent.push({ __route: { category, channelId, guildId }, embed });
        },
        recordJoin: () => {},
        recordLeave: () => {},
        formatUptime: (ms) => Math.floor((ms || 0) / 86400000) + 'd',
        truncate: (s) => s,
    };
}

function makeAvatar(size) { return 'https://cdn.example/a-' + (size && size.size ? size.size : 128) + '.png'; }

const HUMAN = {
    id: '111222333',
    username: 'human_user',
    tag: 'human_user#0001',
    bot: false,
    createdTimestamp: Date.now() - 400 * 86400000,
    displayAvatarURL: makeAvatar,
    toString: () => '<@111222333>',
};

const ADDED_BY = {
    id: '444555666',
    username: 'Lune',
    tag: 'Lune#7777',
    bot: false,
    createdTimestamp: Date.now() - 900 * 86400000,
    displayAvatarURL: makeAvatar,
    toString: () => '<@444555666>',
};

function botUser(id) {
    return {
        id,
        username: 'heist',
        tag: 'heist#9325',
        bot: true,
        createdTimestamp: Date.now() - 730 * 86400000,
        displayAvatarURL: makeAvatar,
        toString: () => '<@' + id + '>',
    };
}

function botMember(id) {
    return {
        user: botUser(id),
        guild: {
            id: 'g1',
            name: 'EU | Dying Light',
            iconURL: () => null,
            memberCount: 133,
            fetchAuditLogs: async ({ type }) => ({
                entries: {
                    size: type === 28 ? 1 : 0,
                    first: () => (type === 28
                        ? { target: { id }, executor: ADDED_BY }
                        : undefined),
                    filter: () => ({ first: () => undefined }),
                },
            }),
        },
        client: { user: { id: 'self-bot-id' } },
    };
}

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('bot add logs to the applications category, not members', async () => {
    sent.length = 0;
    const handler = events.find((e) => e.name === 'guildMemberAdd').execute(deps());
    await handler(botMember('999000111'));

    const routed = sent.find((s) => s.__route);
    assert.ok(routed, 'one routed log sent');
    assert.strictEqual(routed.__route.category, 'applications');
    const embed = routed.embed;
    assert.strictEqual(embed.data.title, '🧩 Application Added');
    assert.ok(embed.data.description.includes('was added to the server'), 'description present');
    const inviter = embed.data.fields.find((f) => f.name === 'Added By');
    assert.ok(inviter, 'Added By field present');
    assert.ok(inviter.value.includes('Lune#7777'), 'inviter tag shown');
    assert.ok(inviter.value.includes('<@444555666>'), 'inviter pingable');
    assert.ok(inviter.value.includes('444555666'), 'inviter ID shown');
    const botField = embed.data.fields.find((f) => f.name === 'Application');
    assert.ok(botField, 'Application field present');
    assert.ok(botField.value.includes('999000111'), 'bot user ID shown');
    assert.strictEqual(embed.data.footer.text, 'EU | Dying Light');
});

test('human join still logs to the members category', async () => {
    sent.length = 0;
    const handler = events.find((e) => e.name === 'guildMemberAdd').execute(deps());
    await handler({
        user: HUMAN,
        guild: botMember('x').guild,
        client: { user: { id: 'self-bot-id' } },
        roles: { cache: { filter: () => ({ map: () => [] }) } },
        joinedTimestamp: Date.now(),
    });

    const routed = sent.find((s) => s.__route);
    assert.ok(routed, 'one routed log sent');
    assert.strictEqual(routed.__route.category, 'members');
    assert.strictEqual(routed.embed.data.title, '👋 Member Joined');
});

test('webhook events route to applications with name, id and executor', async () => {
    sent.length = 0;
    const handler = serverEvents.find((e) => e.name === 'webhooksUpdate').execute(deps());
    await handler({
        id: 'wh-1',
        guild: {
            id: 'g1',
            name: 'EU | Dying Light',
            iconURL: () => null,
            fetchAuditLogs: async ({ type }) => ({
                entries: {
                    size: type === 50 ? 1 : 0,
                    first: () => undefined,
                    filter: () => ({
                        first: () => (type === 50
                            ? { target: { id: 'wh-1' }, targetId: 'wh-1', action: 50, executor: ADDED_BY }
                            : undefined),
                    }),
                },
            }),
        },
        toString: () => '<#555>',
    });

    const routed = sent.find((s) => s.__route);
    assert.ok(routed, 'one routed log sent');
    assert.strictEqual(routed.__route.category, 'applications');
    const embed = routed.embed;
    assert.strictEqual(embed.data.title, '🔗 Webhook Created');
    assert.strictEqual(embed.data.color, 0x2ECC71);
    const whField = embed.data.fields.find((f) => f.name === 'Webhook');
    assert.ok(whField, 'Webhook field present');
    assert.ok(whField.value.includes('wh-1'), 'webhook ID shown');
    const byField = embed.data.fields.find((f) => f.name === 'Added By');
    assert.ok(byField, 'Added By field present');
    assert.ok(byField.value.includes('Lune#7777'), 'executor shown');
    assert.strictEqual(embed.data.footer.text, 'EU | Dying Light');
});

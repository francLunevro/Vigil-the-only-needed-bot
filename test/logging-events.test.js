'use strict';
// Regression tests for the logging fixes:
//   1. sendLog falls back to the guild's default log channel when a category
//      has no per-category channel (this is what made the dashboard's
//      "Default (auto)" option silently drop events).
//   2. The Discord-native automod event handler logs autoModerationActionExecution.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate BEFORE requiring db — DB_PATH is computed at module load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logging-test-'));
process.env.DATA_DIR = tmp;

const { closeDb } = require('../src/db');
const { setLoggerClient, sendLog } = require('../src/logging');
const { updateGuildConfig } = require('../src/config');
const { EmbedBuilder } = require('discord.js');

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

function makeClient() {
    return {
        channels: {
            cache: { get: (id) => channels[id] || null },
            fetch: async (id) => channels[id] || makeChannel(id),
        },
    };
}

function testEmbed() {
    return new EmbedBuilder().setTitle('Test').setDescription('hello');
}

after(() => {
    try { closeDb(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('sendLog falls back to the guild default channel when a category has no channel', async () => {
    sent.length = 0;
    setLoggerClient(makeClient());
    updateGuildConfig('g1', (g) => {
        g.logChannelId = 'default-ch';
        g.logChannels.members = null; // category left on "Default (auto)"
        return g;
    });
    await sendLog(testEmbed(), 'members', null, 'g1');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].channelId, 'default-ch');
});

test('sendLog prefers the per-category channel over the guild default', async () => {
    sent.length = 0;
    setLoggerClient(makeClient());
    updateGuildConfig('g1', (g) => {
        g.logChannelId = 'default-ch';
        g.logChannels.members = 'members-ch';
        return g;
    });
    await sendLog(testEmbed(), 'members', null, 'g1');
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].channelId, 'members-ch');
});

test('sendLog respects the category enabled toggle', async () => {
    sent.length = 0;
    setLoggerClient(makeClient());
    updateGuildConfig('g1', (g) => {
        g.logChannelId = 'default-ch';
        g.logCategories.members = false;
        return g;
    });
    await sendLog(testEmbed(), 'members', null, 'g1');
    assert.strictEqual(sent.length, 0);
});

test('sendLog does nothing when no channel resolves', async () => {
    sent.length = 0;
    setLoggerClient(makeClient());
    updateGuildConfig('g1', (g) => {
        g.logChannelId = null;
        g.logChannels.members = null;
        return g;
    });
    await sendLog(testEmbed(), 'members', null, 'g1');
    assert.strictEqual(sent.length, 0);
});

// ─── Discord native automod event handler ───
const automodEvents = require('../src/events/automod');
const automodHandler = automodEvents.find((e) => e.name === 'autoModerationActionExecution');

test('automod event handler logs Discord native automod executions', async () => {
    assert.ok(automodHandler, 'autoModerationActionExecution handler must be registered');
    const logged = [];
    const deps = { sendLog: async (embed, cat, ch, guildId) => logged.push({ embed, cat, ch, guildId }) };
    const execution = {
        guild: { id: 'g1', name: 'Test Guild', iconURL: () => null },
        action: { type: 1, metadata: {} },
        ruleTriggerType: 1,
        user: { id: 'u1', tag: 'User#1' },
        channel: { toString: () => '<#c1>' },
        content: 'a banned keyword',
        matchedContent: 'banned',
    };
    await automodHandler.execute(deps)(execution);
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0].cat, 'automod');
    assert.strictEqual(logged[0].guildId, 'g1');
    const data = logged[0].embed.toJSON();
    assert.match(data.title, /Block Message/);
    assert.match(data.description, /Keyword/);
    assert.match(data.description, /User#1/);
});

test('automod handler falls back gracefully for unknown action/trigger types', async () => {
    const logged = [];
    const deps = { sendLog: async (embed, cat) => logged.push({ embed, cat }) };
    const execution = {
        guild: { id: 'g1', name: 'Test Guild', iconURL: () => null },
        action: { type: 99, metadata: {} },
        ruleTriggerType: 99,
        user: null,
        channel: null,
        content: null,
        matchedContent: null,
    };
    await automodHandler.execute(deps)(execution);
    assert.strictEqual(logged.length, 1);
    const data = logged[0].embed.toJSON();
    assert.match(data.title, /Automod Action/);
    assert.match(data.description, /Rule/);
});

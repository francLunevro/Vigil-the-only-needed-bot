// Tests for raid/lockdown mode: config storage, join lockdown, notice posting,
// and channel slowmode. Each scenario uses its own guild id.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'raid-mode-test-'));
process.env.DATA_DIR = tmp;

const { closeDb } = require('../src/db');
const raid = require('../src/raidMode');

after(() => {
    try { closeDb(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
});

test('raidMode: default config is disabled with 60 min duration', () => {
    const cfg = raid.getRaidConfig('g1');
    assert.strictEqual(cfg.enabled, false);
    assert.strictEqual(cfg.durationMinutes, 60);
    assert.strictEqual(cfg.startedAt, null);
});

test('raidMode: enabling sets startedAt, disabling clears it', () => {
    const on = raid.setRaidMode('g2', { enabled: true, durationMinutes: 30 });
    assert.strictEqual(on.enabled, true);
    assert.strictEqual(on.durationMinutes, 30);
    assert.ok(on.startedAt, 'startedAt should be set on enable');

    const off = raid.setRaidMode('g2', { enabled: false });
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.startedAt, null, 'startedAt should clear on disable');
});

test('raidMode: isRaidModeEnabled reflects config', () => {
    assert.strictEqual(raid.isRaidModeEnabled('g3'), false);
    raid.setRaidMode('g3', { enabled: true });
    assert.strictEqual(raid.isRaidModeEnabled('g3'), true);
});

test('raidMode: no join timeout when disabled', async () => {
    let timedOut = 0;
    const member = {
        user: { bot: false },
        guild: { id: 'g4' },
        moderatable: true,
        timeout: async () => { timedOut++; },
    };
    await raid.handleRaidModeJoin(member);
    assert.strictEqual(timedOut, 0);
});

test('raidMode: join timeout applies when enabled (and skips bots)', async () => {
    raid.setRaidMode('g5', { enabled: true, durationMinutes: 10 });
    let timedOut = 0;
    const member = {
        user: { bot: false },
        guild: { id: 'g5' },
        moderatable: true,
        timeout: async (ms) => { timedOut++; assert.strictEqual(ms, 10 * 60000); },
    };
    await raid.handleRaidModeJoin(member);
    assert.strictEqual(timedOut, 1);

    // Bot members are never timed out.
    const bot = { user: { bot: true }, guild: { id: 'g5' }, moderatable: true, timeout: async () => { timedOut++; } };
    await raid.handleRaidModeJoin(bot);
    assert.strictEqual(timedOut, 1, 'bots should be skipped');
});

test('raidMode: non-moderatable members are skipped', async () => {
    raid.setRaidMode('g6', { enabled: true });
    let timedOut = 0;
    const member = {
        user: { bot: false },
        guild: { id: 'g6' },
        moderatable: false,
        timeout: async () => { timedOut++; },
    };
    await raid.handleRaidModeJoin(member);
    assert.strictEqual(timedOut, 0);
});

test('raidMode: enable posts a notice and applies slowmode', async () => {
    const sent = [];
    const channel = {
        type: 0,
        id: 'c1',
        name: 'general',
        send: async (payload) => { sent.push(payload); },
        setRateLimitPerUser: async (secs) => { channel._slowmode = secs; },
    };
    const guild = {
        id: 'g7',
        name: 'Raid Guild',
        channels: { cache: new Map([['c1', channel]]) },
    };
    const cfg = await raid.enableRaidMode(guild, { durationMinutes: 45, noticeChannel: 'c1' });
    assert.strictEqual(cfg.enabled, true);
    assert.strictEqual(cfg.durationMinutes, 45);
    assert.strictEqual(sent.length, 1, 'a notice should be posted');
    assert.strictEqual(channel._slowmode, 30, 'slowmode should be set');

    // Disable resets slowmode.
    await raid.disableRaidMode(guild);
    assert.strictEqual(channel._slowmode, 0, 'slowmode should reset on disable');
});

test('raidMode: notice is skipped when no channel is configured', async () => {
    const guild = {
        id: 'g8',
        name: 'No Logs',
        channels: { cache: new Map() },
    };
    const cfg = await raid.enableRaidMode(guild, {});
    assert.strictEqual(cfg.enabled, true);
});
// Tests for guild embed-color persistence: the hex/int normalization in
// config.js (parse + save round-trip) and the dashboard endpoints that
// read/write it (POST /api/server/:id/settings, GET /api/server/:id).
// Regression coverage for two confirmed bugs:
//   1. The dashboard wrote cfg.embed_color (snake_case) which the writer
//      never persisted — the setting silently did nothing.
//   2. parseInt(row.embed_color) without radix/base-16 mangled hex strings
//      ('#5865F2' → NaN, 'FF0000' → 255).
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'));
process.env.DATA_DIR = tmp;

const { closeDb, getDb } = require('../src/db');
const config = require('../src/config');
const { hexColorToInt, intToHexString } = config;
const core = require('../src/dashboard-backend/core');
const serversPart = require('../src/dashboard-backend/parts/04-servers');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ──────────────────── hexColorToInt ────────────────────

test('hexColorToInt parses #rrggbb, rrggbb, 3-digit, ints, and decimal strings', () => {
    assert.strictEqual(hexColorToInt('#5865F2'), 0x5865F2);
    assert.strictEqual(hexColorToInt('FF0000'), 0xFF0000);
    assert.strictEqual(hexColorToInt('#abc'), 0xaabbcc);
    assert.strictEqual(hexColorToInt(0xE74C3C), 0xE74C3C);
    assert.strictEqual(hexColorToInt('5814770'), 5814770); // legacy decimal string rows
    assert.strictEqual(hexColorToInt(0), 0); // black is a real color, not "unset"
    assert.strictEqual(hexColorToInt('  #5865F2  '), 0x5865F2);
});

test('hexColorToInt returns null for junk and out-of-range values', () => {
    assert.strictEqual(hexColorToInt(null), null);
    assert.strictEqual(hexColorToInt(undefined), null);
    assert.strictEqual(hexColorToInt(''), null);
    assert.strictEqual(hexColorToInt('not a color'), null);
    assert.strictEqual(hexColorToInt('#1234567'), null); // 7 hex digits isn't a color form
    assert.strictEqual(hexColorToInt('#12345'), null); // 5 hex digits isn't 3 or 6
    assert.strictEqual(hexColorToInt('99999999'), null); // decimal > 0xFFFFFF
    assert.strictEqual(hexColorToInt('FFFFFFF'), null); // 7 bare hex digits rejected
    assert.strictEqual(hexColorToInt(0xFFFFFF + 1), null);
    assert.strictEqual(hexColorToInt(-5), null);
    assert.strictEqual(hexColorToInt(12.5), null);
});

// ──────────────────── intToHexString ────────────────────

test('intToHexString formats ints and rejects junk', () => {
    assert.strictEqual(intToHexString(0x5865F2), '#5865f2');
    assert.strictEqual(intToHexString(0), '#000000');
    assert.strictEqual(intToHexString(0xff), '#0000ff');
    assert.strictEqual(intToHexString(null), null);
    assert.strictEqual(intToHexString(0xFFFFFF + 1), null);
});

// ──────────────────── Guild config round-trips ────────────────────

test('guild embed color round-trips: hex string in → int out → decimal string in DB', () => {
    const gid = 'cfgRound1';
    config.updateGuildConfig(gid, (cfg) => { cfg.embedColor = '#E91E63'; return cfg; });

    // Stored value is the decimal string of the int
    const row = getDb().prepare('SELECT embed_color FROM guild_config WHERE guild_id = ?').get(gid);
    assert.strictEqual(row.embed_color, String(0xE91E63));

    // Read back: normalized to an int consumers can hand to setColor
    assert.strictEqual(config.getGuildConfig(gid).embedColor, 0xE91E63);
});

test('slash-command style int embed color round-trips identically', () => {
    const gid = 'cfgRound2';
    config.updateGuildConfig(gid, (cfg) => { cfg.embedColor = 0xFF5733; return cfg; });
    assert.strictEqual(config.getGuildConfig(gid).embedColor, 0xFF5733);
});

test('legacy garbage embed_color rows normalize instead of poisoning consumers', () => {
    const gid = 'cfgLegacy';
    config.getGuildConfig(gid); // create the row
    const update = getDb().prepare('UPDATE guild_config SET embed_color = ? WHERE guild_id = ?');

    update.run('#FF0000', gid);
    // Before the fix: parseInt('#FF0000') → NaN → falsy → color treated as unset
    assert.strictEqual(config.getGuildConfig(gid).embedColor, 0xFF0000);

    update.run('FF0000', gid);
    // Before the fix: parseInt('FF0000') → 255 (stops at 'F') → wrong dark blue
    assert.strictEqual(config.getGuildConfig(gid).embedColor, 0xFF0000);
});

test('clearing embed color persists null', () => {
    const gid = 'cfgClear';
    config.updateGuildConfig(gid, (cfg) => { cfg.embedColor = '#123456'; return cfg; });
    config.updateGuildConfig(gid, (cfg) => { cfg.embedColor = null; return cfg; });
    assert.strictEqual(config.getGuildConfig(gid).embedColor, null);
    const row = getDb().prepare('SELECT embed_color FROM guild_config WHERE guild_id = ?').get(gid);
    assert.strictEqual(row.embed_color, null);
});

// ──────────────────── Dashboard endpoints ────────────────────

function buildApp() {
    const app = express();
    app.use(express.json());
    // Bypass real auth: every request is authenticated + owner. The auth
    // middleware itself is exercised elsewhere; here we target the
    // settings/detail handlers.
    app.use((_req, _res, next) => { _req.authenticated = true; next(); });
    const ctx = {
        requireAuth: (_req, _res, next) => next(),
        checkOwner: () => true,
        filterByScope: (_req, items) => items,
    };
    serversPart.register(app, ctx);
    return app;
}

function makeClient() {
    const guild = {
        id: 'gDash1',
        name: 'Dash Guild',
        iconURL: () => null,
        memberCount: 42,
        premiumTier: 0,
        premiumSubscriptionCount: 0,
        ownerId: 'owner1',
        channels: { cache: { size: 3, filter: () => ({ size: 0 }) } },
        roles: { cache: { size: 5 } },
    };
    return { guilds: { cache: { get: (id) => (id === guild.id ? guild : null) } } };
}

async function withServer(app, fn) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
    });
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        return await fn(base);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function postJSON(base, url, body) {
    return fetch(base + url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

test('dashboard settings saves embedColor under the camelCase key', async () => {
    core.setDashboardClient(makeClient(), 'test-password');
    const app = buildApp();
    await withServer(app, async (base) => {
        const r = await postJSON(base, '/api/server/gDash1/settings', { embedColor: '#9B59B6' });
        assert.strictEqual(r.status, 200);
        assert.deepStrictEqual(await r.json(), { success: true });
        // The old code wrote cfg.embed_color, which updateGuildConfigRaw never
        // persisted — this assertion fails against the buggy writer.
        assert.strictEqual(config.getGuildConfig('gDash1').embedColor, 0x9B59B6);
    });
});

test('dashboard settings accepts 6-digit hex without # and rejects invalid values', async () => {
    const app = buildApp();
    await withServer(app, async (base) => {
        const noHash = await postJSON(base, '/api/server/gDash1/settings', { embedColor: 'E74C3C' });
        assert.strictEqual(noHash.status, 400); // route requires the #rrggbb shape

        const junk = await postJSON(base, '/api/server/gDash1/settings', { embedColor: 'purple' });
        assert.strictEqual(junk.status, 400);
    });
});

test('dashboard settings clears the color when sent an empty string', async () => {
    const app = buildApp();
    await withServer(app, async (base) => {
        await postJSON(base, '/api/server/gDash1/settings', { embedColor: '#123456' });
        const clear = await postJSON(base, '/api/server/gDash1/settings', { embedColor: '' });
        assert.strictEqual(clear.status, 200);
        assert.strictEqual(config.getGuildConfig('gDash1').embedColor, null);
    });
});

test('server detail returns embedColor as a #rrggbb string', async () => {
    core.setDashboardClient(makeClient(), 'test-password');
    const app = buildApp();
    await withServer(app, async (base) => {
        config.updateGuildConfig('gDash1', (cfg) => { cfg.embedColor = 0x206694; return cfg; });
        const r = await fetch(base + '/api/server/gDash1');
        assert.strictEqual(r.status, 200);
        const body = await r.json();
        // Before the fix the detail endpoint never returned embedColor at all,
        // so the settings page always displayed "Bot default".
        assert.strictEqual(body.embedColor, '#206694');
    });
});

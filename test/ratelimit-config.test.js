// The dashboard's Rate Limits panel used to save settings that nothing read,
// and the mod-actions bucket wasn't enforced anywhere. These tests pin the
// wiring: saved overrides must actually change enforcement, per bucket.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ratelimit-config-test-'));
process.env.DATA_DIR = tmp;

const {
    checkBucketRateLimit, getRateLimitConfig, invalidateRateLimitConfigCache, DEFAULT_RATE_LIMITS,
} = require('../src/dashboard-backend/core');
const { getDb, closeDb } = require('../src/db');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

function saveLimits(cfg) {
    getDb().prepare('INSERT OR REPLACE INTO bot_config (key, value) VALUES (?, ?)')
        .run('ratelimit_config', JSON.stringify(cfg));
    invalidateRateLimitConfigCache();
}

// Every test uses its own IP so the per-IP counters never bleed together.
test('with nothing saved, the effective config is the defaults', () => {
    const cfg = getRateLimitConfig();
    assert.deepStrictEqual(cfg, DEFAULT_RATE_LIMITS);
    assert.strictEqual(cfg.login.max, 10);
    assert.strictEqual(cfg.modActions.max, 30);
});

test('a saved override changes real enforcement', () => {
    saveLimits({ login: { windowMs: 60000, max: 2 } });

    assert.strictEqual(checkBucketRateLimit('login', '10.0.0.1').allowed, true);
    assert.strictEqual(checkBucketRateLimit('login', '10.0.0.1').allowed, true);
    const third = checkBucketRateLimit('login', '10.0.0.1');
    assert.strictEqual(third.allowed, false, 'third attempt must be blocked once max=2 is configured');
    assert.strictEqual(third.limit, 2);
});

test('buckets keep independent counters', () => {
    saveLimits({ login: { windowMs: 60000, max: 1 }, api: { windowMs: 60000, max: 5 } });

    assert.strictEqual(checkBucketRateLimit('login', '10.0.0.2').allowed, true);
    assert.strictEqual(checkBucketRateLimit('login', '10.0.0.2').allowed, false, 'login bucket is exhausted');

    // The same IP still has its full API budget — buckets must not share.
    const apiCheck = checkBucketRateLimit('api', '10.0.0.2');
    assert.strictEqual(apiCheck.allowed, true);
    assert.strictEqual(apiCheck.limit, 5);
});

test('the mod-actions bucket is enforced separately and tighter than api', () => {
    saveLimits({ api: { windowMs: 60000, max: 100 }, modActions: { windowMs: 60000, max: 2 } });

    assert.strictEqual(checkBucketRateLimit('modActions', '10.0.0.3').allowed, true);
    assert.strictEqual(checkBucketRateLimit('modActions', '10.0.0.3').allowed, true);
    assert.strictEqual(checkBucketRateLimit('modActions', '10.0.0.3').allowed, false);
    // api traffic from the same IP is unaffected by mod actions
    assert.strictEqual(checkBucketRateLimit('api', '10.0.0.3').allowed, true);
});

test('garbage or hostile values fall back to the defaults', () => {
    saveLimits({
        login: { windowMs: 'not-a-number', max: 'not-a-number' },
        api: { windowMs: -5, max: 0 },
    });

    const cfg = getRateLimitConfig();
    assert.deepStrictEqual(cfg.login, DEFAULT_RATE_LIMITS.login);
    assert.deepStrictEqual(cfg.api, DEFAULT_RATE_LIMITS.api);
});

test('a partially saved config leaves the other buckets on their defaults', () => {
    saveLimits({ api: { windowMs: 30000, max: 7 } });

    const cfg = getRateLimitConfig();
    assert.strictEqual(cfg.api.max, 7);
    assert.strictEqual(cfg.api.windowMs, 30000);
    assert.deepStrictEqual(cfg.login, DEFAULT_RATE_LIMITS.login);
    assert.deepStrictEqual(cfg.modActions, DEFAULT_RATE_LIMITS.modActions);
});

test('a corrupt stored config does not break enforcement', () => {
    getDb().prepare('INSERT OR REPLACE INTO bot_config (key, value) VALUES (?, ?)')
        .run('ratelimit_config', '{not json');
    invalidateRateLimitConfigCache();

    const cfg = getRateLimitConfig();
    assert.deepStrictEqual(cfg, DEFAULT_RATE_LIMITS);
    assert.strictEqual(checkBucketRateLimit('api', '10.0.0.4').allowed, true);
});

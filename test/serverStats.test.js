// Temp-isolated tests for the server stats module: computation, formatting,
// DB lifecycle, and the refresh/rename loop.
const { test, after, mock } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-test-'));
process.env.DATA_DIR = tmp;

const { closeDb } = require('../src/db');
const ss = require('../src/serverStats');

after(() => {
    try { closeDb(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
});

// ── Mocks ──
function makeMember(id, { bot = false, status = null } = {}) {
    const m = { id, user: { bot }, presence: status ? { status } : null };
    return m;
}
function makeChannel(id, name) {
    return {
        id,
        name,
        manageable: true,
        renames: 0,
        async setName(n) { this.name = n; this.renames += 1; },
    };
}
function makeGuild(opts = {}) {
    const members = new Map();
    for (const [id, m] of Object.entries(opts.members || {})) members.set(id, m);
    const channels = new Map();
    for (const c of (opts.channels || [])) channels.set(c.id, c);
    const roles = new Map();
    for (let i = 0; i < (opts.roleCount || 0); i++) roles.set('r' + i, { id: 'r' + i });
    const emojis = new Map();
    for (let i = 0; i < (opts.emojiCount || 0); i++) emojis.set('e' + i, { id: 'e' + i });
    return {
        id: opts.id || 'g1',
        memberCount: opts.memberCount || 0,
        premiumSubscriptionCount: opts.premiumSubscriptionCount || 0,
        premiumTier: opts.premiumTier || 0,
        members: { cache: members },
        channels: { cache: channels },
        roles: { cache: roles },
        emojis: { cache: emojis },
    };
}

// ── computeStat ──
test('computeStat: counts members, humans, bots, online', () => {
    const g = makeGuild({
        memberCount: 100,
        members: {
            a: makeMember('a'),
            b: makeMember('b', { bot: true }),
            c: makeMember('c', { status: 'online' }),
            d: makeMember('d', { status: 'dnd' }),
            e: makeMember('e', { status: 'offline' }),
        },
    });
    assert.strictEqual(ss.computeStat(g, g.members, 'members'), 100);
    assert.strictEqual(ss.computeStat(g, g.members, 'humans'), 4);
    assert.strictEqual(ss.computeStat(g, g.members, 'bots'), 1);
    assert.strictEqual(ss.computeStat(g, g.members, 'online'), 2);
});

test('computeStat: boosts, tier, channels, roles, emojis', () => {
    const g = makeGuild({
        premiumSubscriptionCount: 7,
        premiumTier: 2,
        channels: [makeChannel('c1', 'x'), makeChannel('c2', 'y')],
        roleCount: 5,
        emojiCount: 3,
    });
    assert.strictEqual(ss.computeStat(g, g.members, 'boosting'), 7);
    assert.strictEqual(ss.computeStat(g, g.members, 'boost_tier'), 2);
    assert.strictEqual(ss.computeStat(g, g.members, 'channels'), 2);
    assert.strictEqual(ss.computeStat(g, g.members, 'roles'), 5);
    assert.strictEqual(ss.computeStat(g, g.members, 'emojis'), 3);
});

test('computeStat: unknown type or missing guild is 0', () => {
    assert.strictEqual(ss.computeStat(makeGuild(), makeGuild().members, 'nope'), 0);
    assert.strictEqual(ss.computeStat(null, null, 'members'), 0);
});

// ── formatStatName ──
test('formatStatName: default label, thousands separators, custom label', () => {
    assert.strictEqual(ss.formatStatName('members', 1234, null), '👥 Members • 1,234');
    assert.strictEqual(ss.formatStatName('members', 50, 'Total'), '👥 Total • 50');
    assert.strictEqual(ss.formatStatName('boost_tier', 2, null), '💎 Boost Tier • Tier 2');
    assert.strictEqual(ss.formatStatName('nope', 1, null), '');
});

test('formatStatName: zero values and boost tier 0', () => {
    assert.strictEqual(ss.formatStatName('members', 0, null), '👥 Members • 0');
    assert.strictEqual(ss.formatStatName('boost_tier', 0, null), '💎 Boost Tier • Tier 0');
    assert.strictEqual(ss.formatStatName('boosting', 0, null), '🚀 Boosts • 0');
});

test('formatStatName: never exceeds 100 chars and never contains @ # :', () => {
    const long = ss.formatStatName('members', 123456789, 'X'.repeat(200));
    assert.ok(long.length <= 100);
    assert.ok(!/[@#:]/.test(long), 'channel-name-invalid chars present: ' + long);
});

// ── DB lifecycle ──
test('DB: set, get, update (replace), remove', () => {
    const r1 = ss.setServerStat('g1', 'c1', 'members', null);
    assert.ok(r1.success);
    const r2 = ss.setServerStat('g1', 'c2', 'boosting', 'Boosters');
    assert.ok(r2.success);
    assert.strictEqual(ss.getServerStats('g1').length, 2);

    // Replace same channel -> still one row, new type
    ss.setServerStat('g1', 'c1', 'online', null);
    const rows = ss.getServerStats('g1');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows.find(r => r.channel_id === 'c1').stat_type, 'online');

    // Invalid type rejected
    assert.ok(ss.setServerStat('g1', 'c3', 'bogus', null).error);

    ss.removeServerStat('g1', 'c1');
    assert.strictEqual(ss.getServerStats('g1').length, 1);
    // Per-guild isolation
    assert.strictEqual(ss.getServerStats('other').length, 0);
});

// ── refreshGuildStats ──
test('refresh: renames channel to the computed name', async () => {
    const ch = makeChannel('c1', 'old name');
    const g = makeGuild({ memberCount: 42, channels: [ch], members: {} });
    ss.setServerStat('g1', 'c1', 'members', null);

    await ss.refreshGuildStats(g);
    assert.strictEqual(ch.name, '👥 Members • 42');
    assert.strictEqual(ch.renames, 1);

    // Second refresh with same value -> no rename (rate-limit safety)
    await ss.refreshGuildStats(g);
    assert.strictEqual(ch.renames, 1);
});

test('refresh: drops config when the channel is deleted', async () => {
    const g = makeGuild({ memberCount: 10, channels: [], members: {} });
    ss.setServerStat('g1', 'gone', 'members', null);
    await ss.refreshGuildStats(g);
    assert.strictEqual(ss.getServerStats('g1').length, 0);
});

test('refresh: respects custom label and never throws on unmanageable channel', async () => {
    const ch = makeChannel('c1', 'x');
    ch.manageable = false;
    const g = makeGuild({ memberCount: 7, channels: [ch], members: {} });
    ss.setServerStat('g1', 'c1', 'members', 'Total Humans');
    await ss.refreshGuildStats(g); // must not throw
    assert.strictEqual(ch.name, 'x'); // untouched
});

// ── Burst coalescing & rename pacing ──
// A raid used to fire one refresh per join event, and every refresh renamed the
// counter channel: Discord's ~2 renames per 10 minutes per channel was spent
// within seconds, every later rename 429'd, and the counter froze on a wrong
// number until the next 10-minute sweep. Two layers replace that — a per-guild
// debounce and per-channel pacing that re-queues a skipped rename instead of
// dropping it.

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setImmediate(r)); };

// Each test uses its own guild/channel ids and a clean scheduler, because the
// pacing state is module-level (deliberately — it mirrors Discord's bucket).
// The mocked clock starts at epoch 0, so pin it to the real time first:
// otherwise every channel looks like it was renamed a moment ago (`since` of 0)
// and the pacing layer defers everything.
function withMockClock(fn) {
    return async () => {
        const realNow = Date.now();
        mock.timers.enable({ apis: ['setTimeout', 'Date'] });
        mock.timers.setTime(realNow);
        ss.resetStatsScheduler();
        try {
            await fn();
        } finally {
            ss.resetStatsScheduler();
            mock.timers.reset();
        }
    };
}

test('pacing constant stays at or under Discord\'s rename refill rate', () => {
    // Two renames per 10 minutes = one per 5 minutes. Going below that drains
    // the bucket, which is the bug these tests exist to prevent.
    assert.ok(
        ss.MIN_RENAME_INTERVAL_MS >= 5 * 60 * 1000,
        'MIN_RENAME_INTERVAL_MS must not be faster than ~1 rename per 5 minutes'
    );
});

test('a single join still refreshes immediately (leading edge)', withMockClock(async () => {
    const ch = makeChannel('lead1', 'old name');
    const g = makeGuild({ id: 'lg1', memberCount: 12, channels: [ch] });
    ss.setServerStat('lg1', 'lead1', 'members', null);

    ss.scheduleGuildStatsRefresh(g);
    await flush();

    assert.strictEqual(ch.name, '👥 Members • 12', 'a lone event must not wait out the debounce window');
    assert.strictEqual(ch.renames, 1);
}));

test('a join raid collapses into one refresh and two renames total', withMockClock(async () => {
    const ch = makeChannel('burst1', 'old name');
    const g = makeGuild({ id: 'bg1', memberCount: 100, channels: [ch] });
    ss.setServerStat('bg1', 'burst1', 'members', null);

    // One join on its own: refreshed at once.
    ss.scheduleGuildStatsRefresh(g);
    await flush();
    assert.strictEqual(ch.renames, 1);

    // A raid: 50 joins, each firing the member-add hook.
    for (let i = 0; i < 50; i++) {
        g.memberCount = 101 + i;
        ss.scheduleGuildStatsRefresh(g);
    }
    await flush();
    assert.strictEqual(ch.renames, 1, 'the burst must not rename while it is still landing');

    // The coalesced trailing refresh runs, but the rename is paced out.
    mock.timers.tick(ss.REFRESH_DEBOUNCE_MS);
    await flush();
    assert.strictEqual(ch.renames, 1, 'pacing holds the rename back, it is not attempted and 429\'d');

    // The update is not lost: it lands as soon as the channel budget refills.
    mock.timers.tick(ss.MIN_RENAME_INTERVAL_MS);
    await flush();
    assert.strictEqual(ch.name, '👥 Members • 150', 'the final count still arrives');
    assert.strictEqual(ch.renames, 2, '50 joins must not become 50 renames');
}));

test('a rename skipped by pacing is re-queued, not dropped', withMockClock(async () => {
    const ch = makeChannel('pace1', 'old name');
    const g = makeGuild({ id: 'pg1', memberCount: 5, channels: [ch] });
    ss.setServerStat('pg1', 'pace1', 'members', null);

    const first = await ss.refreshGuildStats(g);
    assert.deepStrictEqual(first.renamed, ['pace1']);
    assert.deepStrictEqual(first.deferred, []);
    assert.strictEqual(ch.name, '👥 Members • 5');

    g.memberCount = 6;
    const second = await ss.refreshGuildStats(g);
    assert.deepStrictEqual(second.renamed, []);
    assert.deepStrictEqual(second.deferred, ['pace1'], 'the caller can tell the update is pending');
    assert.strictEqual(ch.name, '👥 Members • 5', 'stale until the budget refills, but scheduled');

    mock.timers.tick(4 * 60 * 1000);
    await flush();
    assert.strictEqual(ch.name, '👥 Members • 5', 'still inside the 5-minute window');

    mock.timers.tick(2 * 60 * 1000);
    await flush();
    assert.strictEqual(ch.name, '👥 Members • 6', 'the queued retry applied the missed update');
}));

test('a rename Discord rejects backs off instead of retrying', withMockClock(async () => {
    const ch = makeChannel('rl1', 'old name');
    ch.attempts = 0;
    ch.setName = async () => { ch.attempts += 1; throw new Error('429 Too Many Requests'); };
    const g = makeGuild({ id: 'rg1', memberCount: 9, channels: [ch] });
    ss.setServerStat('rg1', 'rl1', 'members', null);

    const out = await ss.refreshGuildStats(g);
    assert.strictEqual(ch.attempts, 1);
    assert.deepStrictEqual(out.deferred, ['rl1'], 'a failed rename is reported as deferred, not renamed');

    mock.timers.tick(60 * 1000);
    await flush();
    assert.strictEqual(ch.attempts, 1, 'a rejected rename must not become a retry storm');

    mock.timers.tick(5 * 60 * 1000);
    await flush();
    assert.strictEqual(ch.attempts, 2, 'one retry after the backoff, then it waits again');
}));

test('stopServerStats cancels queued refreshes', withMockClock(async () => {
    const ch = makeChannel('stop1', 'old name');
    const g = makeGuild({ id: 'sg1', memberCount: 3, channels: [ch] });
    ss.setServerStat('sg1', 'stop1', 'members', null);

    ss.scheduleGuildStatsRefresh(g); // leading edge
    await flush();
    g.memberCount = 4;
    ss.scheduleGuildStatsRefresh(g); // queued behind the debounce window

    ss.stopServerStats();
    mock.timers.tick(60 * 60 * 1000);
    await flush();

    assert.strictEqual(ch.name, '👥 Members • 3', 'shutdown must not leave a rename in flight');
}));

// Isolated tests for auto-moderation detection + bypass logic.
// Each scenario uses its own guild id so DB rows and the in-memory spam
// tracker never leak between tests.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Isolate BEFORE requiring db — DB_PATH is computed at module load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'automod-test-'));
process.env.DATA_DIR = tmp;

const { closeDb } = require('../src/db');
const am = require('../src/automod');

after(() => {
    try { closeDb(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
});

function makeMessage(overrides = {}) {
    const msg = {
        content: '',
        channelId: 'c1',
        author: { id: 'u1', tag: 'User#1', bot: false },
        member: {
            user: { bot: false },
            permissions: { has: () => false },
            roles: { cache: { some: () => false } },
            send: async () => {},
            moderatable: true,
            kickable: true,
            timeout: async () => {},
            kick: async () => {},
        },
        deletable: true,
        delete: async () => {},
        mentions: { users: { size: 0 }, roles: { size: 0 }, channels: { size: 0 } },
        guild: { id: 'g1', name: 'Test Guild' },
        channel: { toString: () => '<#c1>' },
        ...overrides,
    };
    return msg;
}

function enableRule(guildId, rule, extra = {}) {
    am.updateAutoModRule(guildId, rule, {
        enabled: true, threshold: 0, time_window: 0, action: 'delete', duration: null, ...extra,
    });
}

test('automod: all rules disabled → message passes', async () => {
    const msg = makeMessage({ content: 'hello world', deletable: true, delete: async () => { throw new Error('should not delete'); } });
    const hit = await am.checkMessage(msg, 'ga');
    assert.strictEqual(hit, false);
});

test('automod: banned word triggers the configured action', async () => {
    enableRule('gb', 'words');
    am.addAutoModFilter('gb', 'words', 'badword', 'delete');
    let deleted = 0;
    const msg = makeMessage({ content: 'this message has a badword in it', delete: async () => { deleted++; } });
    const hit = await am.checkMessage(msg, 'gb');
    assert.strictEqual(hit, true);
    assert.strictEqual(deleted, 1);
});

test('automod: banned word matching is case-insensitive', async () => {
    enableRule('gc', 'words');
    am.addAutoModFilter('gc', 'words', 'spamword', 'delete');
    let deleted = 0;
    const msg = makeMessage({ content: 'SPAMWORD here', delete: async () => { deleted++; } });
    const hit = await am.checkMessage(msg, 'gc');
    assert.strictEqual(hit, true);
    assert.strictEqual(deleted, 1);
});

test('automod: excessive caps triggers', async () => {
    enableRule('gd', 'caps', { threshold: 70 });
    let deleted = 0;
    const msg = makeMessage({ content: 'A'.repeat(40), delete: async () => { deleted++; } });
    const hit = await am.checkMessage(msg, 'gd');
    assert.strictEqual(hit, true);
    assert.strictEqual(deleted, 1);
});

test('automod: short all-caps messages are not flagged', async () => {
    enableRule('ge', 'caps', { threshold: 70 });
    let deleted = 0;
    const msg = makeMessage({ content: 'OK FINE', delete: async () => { deleted++; } }); // < 20 chars
    const hit = await am.checkMessage(msg, 'ge');
    assert.strictEqual(hit, false);
    assert.strictEqual(deleted, 0);
});

test('automod: mass mentions trigger', async () => {
    enableRule('gf', 'mentions', { threshold: 5 });
    let deleted = 0;
    const msg = makeMessage({
        content: '<@1> <@2> <@3> <@4> <@5> <@6>',
        mentions: { users: { size: 6 }, roles: { size: 0 }, channels: { size: 0 } },
        delete: async () => { deleted++; },
    });
    const hit = await am.checkMessage(msg, 'gf');
    assert.strictEqual(hit, true);
    assert.strictEqual(deleted, 1);
});

test('automod: timeout action deletes the message and times out the member', async () => {
    enableRule('gg', 'words');
    am.addAutoModFilter('gg', 'words', 'nasty', 'timeout');
    let deleted = 0;
    let timedOut = 0;
    const msg = makeMessage({
        content: 'that is nasty',
        delete: async () => { deleted++; },
        member: { user: { bot: false }, permissions: { has: () => false }, roles: { cache: { some: () => false } }, send: async () => {}, moderatable: true, kickable: true, timeout: async () => { timedOut++; }, kick: async () => {} },
    });
    const hit = await am.checkMessage(msg, 'gg');
    assert.strictEqual(hit, true);
    assert.strictEqual(deleted, 1);
    assert.strictEqual(timedOut, 1);
});

test('automod: whitelisted role bypasses all rules', async () => {
    enableRule('gh', 'words');
    am.addAutoModFilter('gh', 'words', 'badword', 'delete');
    am.updateAutoModConfig('gh', { whitelistedRoles: ['R1'] });
    let deleted = 0;
    const msg = makeMessage({
        content: 'has badword',
        member: { user: { bot: false }, permissions: { has: () => false }, roles: { cache: { some: (fn) => fn({ id: 'R1' }) } }, send: async () => {}, moderatable: true, kickable: true, timeout: async () => {}, kick: async () => {} },
        delete: async () => { deleted++; },
    });
    const hit = await am.checkMessage(msg, 'gh');
    assert.ok(!hit);
    assert.strictEqual(deleted, 0);
});

test('automod: excluded channel is not checked', async () => {
    enableRule('gi', 'words');
    am.addAutoModFilter('gi', 'words', 'badword', 'delete');
    am.updateAutoModConfig('gi', { excludedChannels: ['c9'] });
    let deleted = 0;
    const msg = makeMessage({ content: 'has badword', channelId: 'c9', delete: async () => { deleted++; } });
    const hit = await am.checkMessage(msg, 'gi');
    assert.ok(!hit);
    assert.strictEqual(deleted, 0);
});

test('automod: bot messages are never flagged', async () => {
    enableRule('gj', 'words');
    am.addAutoModFilter('gj', 'words', 'badword', 'delete');
    let deleted = 0;
    const msg = makeMessage({
        content: 'has badword',
        member: { user: { bot: true }, permissions: { has: () => false }, roles: { cache: { some: () => false } } },
        delete: async () => { deleted++; },
    });
    const hit = await am.checkMessage(msg, 'gj');
    assert.ok(!hit);
    assert.strictEqual(deleted, 0);
});

test('automod: members with ManageMessages permission are skipped', async () => {
    enableRule('gk', 'words');
    am.addAutoModFilter('gk', 'words', 'badword', 'delete');
    let deleted = 0;
    const msg = makeMessage({
        content: 'has badword',
        member: { user: { bot: false }, permissions: { has: () => true }, roles: { cache: { some: () => false } } },
        delete: async () => { deleted++; },
    });
    const hit = await am.checkMessage(msg, 'gk');
    assert.ok(!hit);
    assert.strictEqual(deleted, 0);
});

test('automod: spam detection fires once the threshold is reached within the window', async () => {
    am.updateAutoModRule('gs', 'spam', { enabled: true, threshold: 2, time_window: 10, action: 'delete', duration: null });
    let deleted = 0;
    const mk = () => makeMessage({ author: { id: 'spammer', tag: 'Spam#1', bot: false }, content: 'hi', delete: async () => { deleted++; } });
    const first = await am.checkMessage(mk(), 'gs');
    assert.strictEqual(first, false); // 1st message: under threshold
    assert.strictEqual(deleted, 0);
    const second = await am.checkMessage(mk(), 'gs');
    assert.strictEqual(second, true); // 2nd within window: threshold reached
    assert.strictEqual(deleted, 1);
});

test('automod: export/import round-trips rules and filters', async () => {
    enableRule('gl', 'words');
    am.addAutoModFilter('gl', 'words', 'roundtripword', 'delete');
    const exported = am.exportAutoModConfig('gl');
    assert.ok(exported.rules.words.enabled);
    assert.strictEqual(exported.filters.words.length, 1);
    assert.strictEqual(exported.filters.words[0].pattern, 'roundtripword');

    // Import into a fresh guild and confirm the filter is live.
    am.importAutoModConfig('gm', exported);
    let deleted = 0;
    const msg = makeMessage({ content: 'roundtripword!', delete: async () => { deleted++; } });
    const hit = await am.checkMessage(msg, 'gm');
    assert.strictEqual(hit, true);
    assert.strictEqual(deleted, 1);
});

test('automod: regex filter matches patterns, not literals', async () => {
    enableRule('gr1', 'words');
    am.addAutoModFilter('gr1', 'regex', 'discord\\.gg|bit\\.ly/', 'delete');
    let deleted = 0;
    const hit = await am.checkMessage(makeMessage({ content: 'join my server at https://discord.gg/xyz', delete: async () => { deleted++; } }), 'gr1');
    assert.strictEqual(hit, true);
    assert.strictEqual(deleted, 1);
});

test('automod: regex filter is case-sensitive by design', async () => {
    enableRule('gr2', 'words');
    am.addAutoModFilter('gr2', 'regex', 'VIP', 'delete');
    let deleted = 0;
    const hit = await am.checkMessage(makeMessage({ content: 'I am a VIP member', delete: async () => { deleted++; } }), 'gr2');
    assert.strictEqual(hit, true);
    const miss = await am.checkMessage(makeMessage({ content: 'I am a vip member', delete: async () => { deleted++; } }), 'gr2');
    assert.strictEqual(miss, false);
    assert.strictEqual(deleted, 1);
});

test('automod: regex filter pattern is stored verbatim (not lowercased)', async () => {
    enableRule('gr3', 'words');
    am.addAutoModFilter('gr3', 'regex', '[A-Z]{5,}', 'delete');
    const filters = am.getAutoModFilters('gr3', 'regex');
    assert.strictEqual(filters.length, 1);
    assert.strictEqual(filters[0].pattern, '[A-Z]{5,}');
});

test('automod: invalid regex is rejected at add time', () => {
    assert.strictEqual(am.isValidRegex('discord\\.gg'), true);
    assert.strictEqual(am.isValidRegex('('), false);
    assert.strictEqual(am.isValidRegex('[a-z'), false);
});

test('automod: invalid stored regex cannot crash the message pipeline', async () => {
    enableRule('gr4', 'words');
    // Insert a bad pattern directly (bypassing add-time validation, as a
    // legacy import might) and confirm checkMessage skips it defensively.
    const { getDb } = require('../src/db');
    getDb().prepare('INSERT OR REPLACE INTO automod_filters (guild_id, filter_type, pattern, action) VALUES (?, ?, ?, ?)')
        .run('gr4', 'regex', '(', 'delete');
    am.invalidateAutoModCache('gr4'); // a raw write is not seen until the cache is dropped
    const hit = await am.checkMessage(makeMessage({ content: 'anything at all' }), 'gr4');
    assert.strictEqual(hit, false);
});

test('automod: reads are cached per guild, and a raw SQL change needs the cache dropped', async () => {
    // The message path used to do five or six SQLite round trips per message.
    // The cache is only safe because every write in the module drops it — this
    // pins both halves of that bargain.
    enableRule('gc1', 'words');
    am.addAutoModFilter('gc1', 'words', 'cachedword', 'delete');
    assert.strictEqual(await am.checkMessage(makeMessage({ content: 'say cachedword' }), 'gc1'), true);

    // Change the database behind the module's back, the way a hand-run SQL fix
    // or a restored database file would.
    const { getDb } = require('../src/db');
    getDb().prepare('DELETE FROM automod_filters WHERE guild_id = ?').run('gc1');
    assert.strictEqual(await am.checkMessage(makeMessage({ content: 'say cachedword' }), 'gc1'), true,
        'still served from the cache');

    am.invalidateAutoModCache('gc1');
    assert.strictEqual(await am.checkMessage(makeMessage({ content: 'say cachedword' }), 'gc1'), false,
        'and gone the moment the cache is dropped');

    // The module's own writes never need that manual step.
    am.addAutoModFilter('gc1', 'words', 'freshword', 'delete');
    assert.strictEqual(await am.checkMessage(makeMessage({ content: 'say freshword' }), 'gc1'), true,
        'a filter added through the API is live on the next message');
    assert.strictEqual(am.removeAutoModFilter('gc1', 'words', 'freshword'), true);
    assert.strictEqual(await am.checkMessage(makeMessage({ content: 'say freshword' }), 'gc1'), false,
        'and removal is live too');
});

test('automod: regex filters round-trip through export/import', async () => {
    enableRule('gr5', 'words');
    am.addAutoModFilter('gr5', 'regex', 'discord\\.gg', 'warn');
    const exported = am.exportAutoModConfig('gr5');
    assert.strictEqual(exported.filters.regex.length, 1);
    assert.strictEqual(exported.filters.regex[0].pattern, 'discord\\.gg');
    assert.strictEqual(exported.filters.regex[0].action, 'warn');

    am.importAutoModConfig('gr6', exported);
    let warned = 0;
    const msg = makeMessage({
        content: 'check discord.gg now',
        member: { user: { bot: false }, permissions: { has: () => false }, roles: { cache: { some: () => false } }, send: async () => { warned++; }, moderatable: true, kickable: true, timeout: async () => {}, kick: async () => {} },
        deletable: false,
    });
    const hit = await am.checkMessage(msg, 'gr6');
    assert.strictEqual(hit, true);
    assert.strictEqual(warned, 1);
});

test('automod: bulkAddFilters (array) skips invalid regexes and keeps case', async () => {
    // Array input avoids comma-splitting, which can't represent regexes that
    // contain a comma (e.g. `{3,}`) — pass an array for regex bulk imports.
    const added = am.bulkAddFilters('gr7', 'regex', ['discord\\.gg:delete', '(', '[A-Z]{3,}:warn']);
    assert.strictEqual(added.length, 2);
    const filters = am.getAutoModFilters('gr7', 'regex');
    // getAutoModFilters returns rows ordered by primary key (pattern), so
    // compare as a sorted set rather than insertion order.
    const patterns = filters.map(f => f.pattern).sort();
    assert.deepStrictEqual(patterns, ['[A-Z]{3,}', 'discord\\.gg']);
    const warns = filters.filter(f => f.action === 'warn');
    assert.strictEqual(warns.length, 1);
    assert.strictEqual(warns[0].pattern, '[A-Z]{3,}');
});

test('automod: removing a regex filter matches the stored (case-sensitive) pattern', async () => {
    // Regression: removeAutoModFilter used to lowercase every pattern, which
    // made it impossible to remove a regex like `[A-Z]{5,}` (stored verbatim).
    enableRule('gr8', 'words');
    am.addAutoModFilter('gr8', 'regex', '[A-Z]{5,}', 'delete');
    assert.strictEqual(am.getAutoModFilters('gr8', 'regex').length, 1);
    assert.strictEqual(am.removeAutoModFilter('gr8', 'regex', '[A-Z]{5,}'), true);
    assert.strictEqual(am.getAutoModFilters('gr8', 'regex').length, 0);
});

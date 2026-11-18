// Tests for the regex safety guard (src/regexGuard.js) — the choke point that
// keeps user-authored regexes (automod filters, autoresponder triggers) from
// freezing the bot via catastrophic backtracking.
const { test } = require('node:test');
const assert = require('node:assert');

const { regexIssue, isValidRegex, hasBacktrackingShape, MAX_REGEX_LENGTH } = require('../src/regexGuard');

// ──────────────────── Safe patterns must pass ────────────────────

test('guard: every legitimate filter form passes', () => {
    const safe = [
        'discord\\.gg|bit\\.ly/',   // alternation of literals (real invite filter)
        '[A-Z]{5,}',                // char class + bounded quantifier
        'a+',                       // plain unbounded quantifier
        'a{3,}',                    // unbounded repeat of a literal
        '(ab)+',                    // unbounded group over two literals
        'https?://[^\\s]+',         // the link matcher itself
        '\\b\\w+@\\w+\\.\\w+\\b',   // email-ish filter
        'foo|bar',                  // bare alternation (the fix for a rejected (foo|bar)+)
        '(foo|bar)',                // bounded group with alternation — fine without a quantifier
        'a?',                       // optional literal
        'a{2,4}',                   // bounded repeat
    ];
    for (const p of safe) {
        assert.strictEqual(regexIssue(p), null, 'expected safe: ' + p);
        assert.strictEqual(isValidRegex(p), true, 'expected valid: ' + p);
    }
});

// ──────────────────── Catastrophic shapes must be rejected ────────────────────

test('guard: classic catastrophic-backtracking patterns are rejected', () => {
    const catastrophic = [
        '(a+)+$',           // the canonical ReDoS bomb
        '([a-zA-Z]+)*$',    // nested quantified class inside an unbounded group
        '(a|aa)+$',         // alternation inside an unbounded group
        '(.*)*',            // unbounded group over an unbounded atom
        '(a?)+$',           // empty-match loop (bounded quantifier inside unbounded group)
        '(a{0,2})*$',       // same, with a bounded brace quantifier
        '((a+)b)+',         // nested unbounded quantifiers two levels deep
        '(x|(a+)+)+',       // catastrophic alternation branch nested again
    ];
    for (const p of catastrophic) {
        assert.match(String(regexIssue(p)), /backtracking/i, 'expected rejection: ' + p);
    }
});

test('guard: unbounded quantifier directly after an ambiguous group body is caught', () => {
    // The quantifier-after-`)` path, distinct from quantifier-inside-body.
    assert.strictEqual(hasBacktrackingShape('(a+)+'), true);
    assert.strictEqual(hasBacktrackingShape('(a*)*'), true);
    // Non-catastrophic control: unbounded group over literals only.
    assert.strictEqual(hasBacktrackingShape('(ab)+'), false);
});

test('guard: escaped characters and char classes are not misread', () => {
    // `\(` is a literal paren — must not open a group; `\\)` closes nothing.
    assert.strictEqual(hasBacktrackingShape('\\(a\\+\\)+'), false);
    // A quantifier inside a char class is just a literal character.
    assert.strictEqual(hasBacktrackingShape('[a+*]{3,}'), false);
    // Class contents must not leak out: `[)]+` is a literal `)` repeated.
    assert.strictEqual(hasBacktrackingShape('[)]+'), false);
});

test('guard: non-regex groups (lookarounds, non-capturing) are parsed correctly', () => {
    // `(?:(ab)+)` has NO outer quantifier, so the inner unbounded loop over
    // literals is safe — the marker consumption must not turn `?:` into one.
    assert.strictEqual(regexIssue('(?:(ab)+)'), null);
    // But quantifying the (?:…) group restores the catastrophic shape.
    assert.match(String(regexIssue('(?:(a+))+')), /backtracking/i);
    // A lookahead with safe content is fine.
    assert.strictEqual(regexIssue('(?=abc)a+'), null);
});

// ──────────────────── Length + syntax guards ────────────────────

test('guard: overlong patterns are rejected before anything else', () => {
    const long = 'a'.repeat(MAX_REGEX_LENGTH + 1);
    assert.match(String(regexIssue(long)), /too long/i);
    // Exactly at the cap is fine (when not catastrophic).
    assert.strictEqual(regexIssue('a'.repeat(MAX_REGEX_LENGTH)), null);
});

test('guard: invalid syntax is still rejected with its message', () => {
    assert.match(String(regexIssue('(') || ''), /valid regular expression/i);
    assert.match(String(regexIssue('[a-z') || ''), /valid regular expression/i);
    assert.match(String(regexIssue('') || ''), /empty/i);
    assert.strictEqual(regexIssue(null) !== null, true, 'non-string input rejected');
    assert.strictEqual(regexIssue(42) !== null, true, 'non-string input rejected');
});

// ──────────────────── Choke-point integration ────────────────────
// These need the DB, so isolate DATA_DIR exactly like automod.test.js.

const fs = require('fs');
const os = require('os');
const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'regex-guard-test-'));
process.env.DATA_DIR = tmp;

const { closeDb } = require('../src/db');
const am = require('../src/automod');
const cc = require('../src/customCommands');

require('node:test').after(() => {
    try { closeDb(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
});

function makeMessage(overrides = {}) {
    return {
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
}

function enableWords(guildId) {
    am.updateAutoModRule(guildId, 'words', { enabled: true, threshold: 0, time_window: 0, action: 'delete', duration: null });
}

test('choke point: addAutoModFilter stores a catastrophic pattern only if it passes the guard', () => {
    // Safe pattern stores.
    enableWords('rg1');
    assert.strictEqual(am.addAutoModFilter('rg1', 'regex', 'discord\\.gg', 'delete'), true);
    assert.strictEqual(am.getAutoModFilters('rg1', 'regex').length, 1);

    // Catastrophic pattern is refused at the choke point and never stored.
    assert.strictEqual(am.addAutoModFilter('rg1', 'regex', '(a+)+$', 'delete'), false);
    assert.strictEqual(am.getAutoModFilters('rg1', 'regex').length, 1, 'only the safe pattern was stored');
});

test('choke point: importAutoModConfig skips catastrophic regexes from untrusted exports', () => {
    am.importAutoModConfig('rg2', {
        rules: { words: { enabled: true, threshold: 0, time_window: 0, action: 'delete' } },
        filters: {
            words: [],
            links: [],
            regex: [
                { pattern: 'discord\\.gg', action: 'delete' },  // safe → stored
                { pattern: '(a+)+$', action: 'delete' },        // catastrophic → skipped
                { pattern: '(', action: 'delete' },             // invalid → skipped
            ],
        },
        channelSettings: { includedChannels: [], excludedChannels: [], whitelistedRoles: [] },
    });
    const filters = am.getAutoModFilters('rg2', 'regex').map(f => f.pattern);
    assert.deepStrictEqual(filters, ['discord\\.gg']);
});

test('choke point: bulkAddFilters skips catastrophic regexes', () => {
    const added = am.bulkAddFilters('rg3', 'regex', ['discord\\.gg:delete', '(a+)+$:delete']);
    assert.strictEqual(added.length, 1);
    assert.strictEqual(added[0].pattern, 'discord\\.gg');
});

test('choke point: a catastrophic pattern inserted directly (legacy DB) can match but never on unbounded input', async () => {
    // Defense in depth: bypass the choke point like an old database might,
    // and confirm the match path still bounds the haystack (REGEX_INPUT_CAP)
    // so even a smuggled pattern cannot see unbounded input.
    enableWords('rg4');
    const { getDb } = require('../src/db');
    getDb().prepare('INSERT OR REPLACE INTO automod_filters (guild_id, filter_type, pattern, action) VALUES (?, ?, ?, ?)')
        .run('rg4', 'regex', '(b|bb)+$', 'delete');
    am.invalidateAutoModCache('rg4'); // raw SQL bypasses the module's cache invalidation

    // Small crafted message matching the shape: violation fires (bounded cost).
    assert.strictEqual(await am.checkMessage(makeMessage({ content: 'abb' }), 'rg4'), true);

    // The real assertion is that this returns at all: a 1000-char run of b's
    // against `(b|bb)+$` with no input cap would backtrack for effectively
    // forever. With the cap it must return quickly.
    const start = Date.now();
    assert.strictEqual(await am.checkMessage(makeMessage({ content: 'b'.repeat(1000) }), 'rg4'), true);
    assert.ok(Date.now() - start < 5000, 'regex match on unbounded-looking input must stay fast');
});

test('choke point: autoresponder regex triggers reject catastrophic shapes with a reason', () => {
    const bad = cc.addAutoresponder('rg5', { matchType: 'regex', trigger: '(a+)+$', response: 'hi' }, 'u1');
    assert.ok(bad.error && /backtracking/i.test(bad.error), 'must be refused with the guard reason');

    const good = cc.addAutoresponder('rg5', { matchType: 'regex', trigger: 'discord\\.gg', response: 'no invite links' }, 'u1');
    assert.ok(!good.error, 'safe regex trigger stores');
    assert.strictEqual(good.responder.matchType, 'regex');
});

test('choke point: autoresponder regex still matches real content after the guard', () => {
    cc.addAutoresponder('rg6', { matchType: 'regex', trigger: 'discord\\.gg', response: 'no invite links' }, 'u1');
    const responders = cc.listAutoresponders('rg6');
    assert.strictEqual(responders.length, 1);
    assert.strictEqual(cc.triggerMatches(responders[0], 'join https://discord.gg/xyz now'), true);
    assert.strictEqual(cc.triggerMatches(responders[0], 'nothing here'), false);
});

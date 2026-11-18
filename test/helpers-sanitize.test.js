// sanitizeForEmbed used to append its ellipsis *after* slicing, so a truncated
// value came out maxLen + 1 characters long (1025 for an embed field) and
// Discord rejected the whole payload with "Invalid Form Body". It also decided
// whether to add the ellipsis by comparing the cleaned text to the *raw* input,
// so anything the regexes shortened (mentions) gained a bogus '…' while text
// that escapeMarkdown grew was truncated without one.
//
// The contract these tests pin: the result is never longer than maxLen, the
// ellipsis is only added when content was actually dropped, and truncation
// never splits an emoji in half.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'helpers-sanitize-test-'));
process.env.DATA_DIR = tmp;

const { sanitizeForEmbed, sanitizeForDM, validateModalInput } = require('../src/helpers');
const { closeDb } = require('../src/db');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// Discord's hard limit for an embed field value; the default maxLen.
const FIELD_LIMIT = 1024;

test('sanitizeForEmbed never exceeds maxLen on truncation', () => {
    const out = sanitizeForEmbed('a'.repeat(2000));
    assert.strictEqual(out.length, FIELD_LIMIT, 'a 1025th character is an invalid form body');
    assert.ok(out.endsWith('…'), 'truncated output should be visibly truncated');
});

test('sanitizeForEmbed leaves text at or under the limit untouched', () => {
    const exact = 'b'.repeat(FIELD_LIMIT);
    assert.strictEqual(sanitizeForEmbed(exact), exact, 'exactly 1024 is legal and must not be marked truncated');
    assert.strictEqual(sanitizeForEmbed(exact).includes('…'), false);

    const short = 'just some text';
    assert.strictEqual(sanitizeForEmbed(short), short);
});

test('sanitizeForEmbed adds the ellipsis only when content was actually dropped', () => {
    // Longer than maxLen as raw text, but every character is a mention that gets
    // stripped — nothing survives, so nothing was truncated away.
    const mentions = '<@123456789012345678>'.repeat(80);
    assert.ok(mentions.length > FIELD_LIMIT, 'precondition: raw input is over the limit');
    assert.strictEqual(sanitizeForEmbed(mentions), '');
    assert.strictEqual(sanitizeForEmbed(mentions).includes('…'), false, 'no content dropped, no ellipsis');
});

test('sanitizeForEmbed stays within the limit even when escaping grows the string', () => {
    // escapeMarkdown prefixes every '*' with a backslash, doubling the length.
    const out = sanitizeForEmbed('*'.repeat(900));
    assert.ok(out.length <= FIELD_LIMIT, `escaped output was ${out.length} characters`);
    assert.ok(out.endsWith('…'));
});

test('sanitizeForEmbed honours an explicit maxLen and keeps Discord limits', () => {
    assert.strictEqual(sanitizeForEmbed('c'.repeat(500), 100).length, 100);
    assert.strictEqual(sanitizeForEmbed('c'.repeat(50), 100), 'c'.repeat(50));
    // Degenerate limits must not produce an over-long string.
    assert.strictEqual(sanitizeForEmbed('hello world', 1), 'h');
    assert.strictEqual(sanitizeForEmbed('hello world', 0), '');
});

test('sanitizeForEmbed does not split a surrogate pair', () => {
    const out = sanitizeForEmbed('😀'.repeat(1000)); // 2000 UTF-16 code units
    assert.ok(out.length <= FIELD_LIMIT);
    assert.deepStrictEqual(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out),
        false,
        'output contains a lone high surrogate (would render as a replacement character)'
    );
    assert.deepStrictEqual(
        /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out),
        false,
        'output contains a lone low surrogate'
    );
});

test('sanitizeForEmbed still neutralises pings', () => {
    assert.ok(sanitizeForEmbed('@everyone hello').includes('@\u200beveryone'));
    assert.ok(sanitizeForEmbed('@here hello').includes('@\u200bhere'));
    assert.strictEqual(sanitizeForEmbed('<@123456789>').includes('<@'), false);
    assert.strictEqual(sanitizeForEmbed(''), '*Empty*');
});

test('validateModalInput keeps markdown fields inside maxLength', () => {
    // escapeMarkdown can expand the input, so the stored value must still be
    // capped — a 1000-char modal answer must not become 1001 characters.
    const { valid, value } = validateModalInput('*'.repeat(900), {
        allowMarkdown: true,
        maxLength: 1000,
    });
    assert.strictEqual(valid, true);
    assert.ok(value.length <= 1000, `modal value was ${value.length} characters`);

    const plain = validateModalInput('x'.repeat(1000), { maxLength: 1000 });
    assert.strictEqual(plain.valid, true);
    assert.ok(plain.value.length <= 1000);
    assert.strictEqual(plain.value.includes('…'), false, 'no truncation happened, so no ellipsis');

    const tooLong = validateModalInput('x'.repeat(1001), { maxLength: 1000 });
    assert.strictEqual(tooLong.valid, false, 'over-length input is still rejected outright');
});

test('sanitizeForDM truncates to exactly its limit', () => {
    assert.strictEqual(sanitizeForDM('d'.repeat(3000), 500).length, 500);
    assert.strictEqual(sanitizeForDM('d'.repeat(10), 500), 'd'.repeat(10));
});

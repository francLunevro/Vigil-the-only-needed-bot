// One canonical color parser. Greetings and tickets each grew their own copy
// (one of which had already lost the null/NaN handling), and disagreeing about
// whether a bare '5865F2' is hex or decimal is exactly how a color turns into
// nonsense. These tests pin the two distinct semantics:
//   displayColorToInt — strict hex strings ('#RRGGBB' / 'RRGGBB')
//   hexColorToInt     — guild_config storage (decimal string, or legacy hex)
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'color-helpers-test-'));
process.env.DATA_DIR = tmp;

const { displayColorToInt, hexColorToInt, intToHexString } = require('../src/config');
const { closeDb } = require('../src/db');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('displayColorToInt parses the display forms', () => {
    assert.strictEqual(displayColorToInt('#5865F2'), 0x5865F2);
    assert.strictEqual(displayColorToInt('5865F2'), 0x5865F2, 'bare hex must be read as hex, not decimal');
    assert.strictEqual(displayColorToInt('#5865f2'), 0x5865F2, 'lowercase is fine');
    assert.strictEqual(displayColorToInt('  #5865F2  '), 0x5865F2, 'surrounding whitespace is tolerated');
    assert.strictEqual(displayColorToInt('#ffffff'), 0xFFFFFF);
    assert.strictEqual(displayColorToInt('#000000'), 0, 'black is 0, not a falsy failure');
});

test('displayColorToInt rejects malformed values instead of guessing', () => {
    assert.strictEqual(displayColorToInt('nope'), null);
    assert.strictEqual(displayColorToInt('#12345'), null, '5 digits is not a color');
    assert.strictEqual(displayColorToInt('#1234567'), null);
    assert.strictEqual(displayColorToInt(''), null);
    assert.strictEqual(displayColorToInt(null), null);
    assert.strictEqual(displayColorToInt(undefined), null);
    assert.strictEqual(displayColorToInt(0x5865F2), null, 'numbers are not display strings');
});

test('displayColorToInt returns the caller-supplied fallback', () => {
    assert.strictEqual(displayColorToInt(undefined, 0x5865F2), 0x5865F2);
    assert.strictEqual(displayColorToInt('garbage', 0xE74C3C), 0xE74C3C);
    // A valid value ignores the fallback
    assert.strictEqual(displayColorToInt('#E74C3C', 0x5865F2), 0xE74C3C);
});

test('hexColorToInt still accepts the decimal-string storage format', () => {
    assert.strictEqual(hexColorToInt('5815782'), 5815782, 'canonical form is the decimal string');
    assert.strictEqual(hexColorToInt(5815782), 5815782, 'numbers pass through');
    assert.strictEqual(hexColorToInt('#5865F2'), 0x5865F2, 'legacy hex rows keep working');
    assert.strictEqual(hexColorToInt('#abc'), 0xAABBCC, '3-digit shorthand expands');
    assert.strictEqual(hexColorToInt('garbage'), null);
    assert.strictEqual(hexColorToInt(null), null);
});

test('intToHexString is the inverse of the display parser', () => {
    assert.strictEqual(intToHexString(0x5865F2), '#5865f2');
    assert.strictEqual(intToHexString(0), '#000000');
    for (const n of [0, 1, 0xAABBCC, 0xFFFFFF]) {
        assert.strictEqual(displayColorToInt(intToHexString(n)), n);
    }
    assert.strictEqual(intToHexString(null), null);
    assert.strictEqual(intToHexString(-1), null);
    assert.strictEqual(intToHexString(0x1000000), null, 'out of range');
});

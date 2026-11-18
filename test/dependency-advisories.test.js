// Regression pins for the production dependency advisories fixed in this
// pass. They fail on the previous lockfile (proxy-addr 2.0.7, undici 6.28.0,
// multer 2.3.0) and pass on the patched one, so a future `npm install` cannot
// quietly reintroduce a vulnerable range.
const { test } = require('node:test');
const assert = require('node:assert');

function versionOf(name) {
    return require(name + '/package.json').version;
}

function parts(version) {
    return String(version).split('.').map(n => parseInt(n, 10) || 0);
}

function atLeast(version, minimum) {
    const a = parts(version);
    const b = parts(minimum);
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const x = a[i] || 0;
        const y = b[i] || 0;
        if (x !== y) return x > y;
    }
    return true;
}

test('express ships a patched proxy-addr (CVE-2026-90711 / GHSA-jqcg-44mw-7w3h)', () => {
    const express = versionOf('express');
    const proxyAddr = versionOf('proxy-addr');
    assert.ok(atLeast(express, '5.3.0'), 'express must resolve to the release that depends on proxy-addr 2.0.8, got ' + express);
    assert.ok(atLeast(proxyAddr, '2.0.8'), 'proxy-addr must be 2.0.8 or newer, got ' + proxyAddr);
});

test('a malformed IPv4-mapped trust subnet no longer trusts every IPv4 client', () => {
    const proxyaddr = require('proxy-addr');
    // The advisory's exact trigger: ::ffff:10.0.0.0/8 (instead of /104) used to
    // compile to all-zero leading bits and match every IPv4 address.
    const malformed = proxyaddr.compile('::ffff:10.0.0.0/8');
    assert.strictEqual(malformed('203.0.113.9', 0), false, 'a public client must not be treated as a proxy');

    // The correctly written prefix still behaves as the 10/8 block.
    const correct = proxyaddr.compile('::ffff:10.0.0.0/104');
    assert.strictEqual(correct('::ffff:10.0.0.1', 0), true);
    assert.strictEqual(correct('203.0.113.9', 0), false);
});

test('the dashboard trust-proxy presets still mean loopback/link-local/private only', () => {
    // src/dashboard-backend/index.js sets `trust proxy` to exactly this list, so
    // Express compiles it with proxy-addr. Pinned here because a proxy-addr
    // upgrade that widened a preset would let any client spoof X-Forwarded-For
    // and dodge the per-IP login rate limit.
    const proxyaddr = require('proxy-addr');
    const trusted = proxyaddr.compile(['loopback', 'linklocal', 'uniquelocal']);
    for (const ip of ['127.0.0.1', '::1', '10.1.2.3', '192.168.1.9', 'fe80::1', 'fd00::1']) {
        assert.strictEqual(trusted(ip, 0), true, ip + ' is a legitimate proxy peer');
    }
    for (const ip of ['203.0.113.9', '8.8.8.8', '::ffff:203.0.113.9', '2606:4700::1111']) {
        assert.strictEqual(trusted(ip, 0), false, ip + ' must not be trusted as a proxy');
    }
});

test('undici is past the WebSocket/retry advisories', () => {
    const undici = versionOf('undici');
    assert.ok(atLeast(undici, '6.28.1'), 'undici must be 6.28.1 or newer, got ' + undici);
});

test('multer is past the aborted-upload denial of service', () => {
    const multer = versionOf('multer');
    assert.ok(atLeast(multer, '2.4.0'), 'multer must be 2.4.0 or newer, got ' + multer);
});

test('body-parser and Multer resolve past the request teardown advisories', () => {
    const { createRequire } = require('node:module');
    const fromExpress = createRequire(require.resolve('express/package.json'));
    assert.ok(atLeast(fromExpress('body-parser/package.json').version, '2.4.0'));
    assert.ok(atLeast(versionOf('multer'), '2.5.0'));
    assert.ok(atLeast(versionOf('qs'), '6.17.1'));
});

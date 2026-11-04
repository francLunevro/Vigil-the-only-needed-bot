// web/dist is served publicly — the login page loads it before anyone signs in —
// and the build used to set `sourcemap: true`. That published a ~1.8 MB
// index-*.js.map next to the bundle, i.e. the whole source tree to any visitor.
//
// Two layers are pinned here, against the real artifact rather than the config
// file alone:
//   1. the project's actual Vite config, run into a temp directory, emits no
//      .map files and no sourceMappingURL comments;
//   2. the middleware the dashboard serves that build with refuses .map
//      requests, so a stale dist cannot leak one either.
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const express = require('express');
const { buildAssetMiddleware } = require('../src/dashboard-backend/static-assets');

const root = path.join(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-dist-'));

after(() => {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function walk(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...walk(full));
        else out.push(full);
    }
    return out;
}

let built = false;

function buildOnce() {
    if (built) return;
    const viteDir = path.dirname(require.resolve('vite/package.json'));
    const bin = path.join(viteDir, 'bin', 'vite.js');
    const res = spawnSync(process.execPath, [
        bin, 'build',
        '--config', path.join(root, 'web', 'vite.config.mjs'),
        '--outDir', outDir,
        '--emptyOutDir',
        '--logLevel', 'error',
    ], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(res.status, 0, 'the real build must succeed:\n' + (res.stderr || res.stdout || ''));
    built = true;
}

test('the shipped build carries no source maps', () => {
    buildOnce();
    const files = walk(outDir);

    const maps = files.filter((f) => f.endsWith('.map'));
    assert.deepStrictEqual(maps.map((f) => path.relative(outDir, f)), [], 'no .map may be emitted');

    const scripts = files.filter((f) => f.endsWith('.js'));
    assert.ok(scripts.length > 0, 'the build produced JavaScript');
    for (const file of scripts) {
        assert.ok(!/sourceMappingURL/.test(fs.readFileSync(file, 'utf8')),
            path.basename(file) + ' must not point at a source map');
    }
});

test('the static handler serves the built bundle but refuses a .map request', async () => {
    buildOnce();
    const assets = walk(outDir).filter((f) => f.endsWith('.js'));
    const rel = '/' + path.relative(outDir, assets[0]).split(path.sep).join('/');

    // A stale build would still have these; the handler must not serve them.
    const legacyMap = assets[0] + '.map';
    fs.writeFileSync(legacyMap, '{"version":3,"sources":["src/secret.js"]}');

    const app = express();
    app.use(buildAssetMiddleware(outDir));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const get = (p) => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: p }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body }));
        }).on('error', reject);
    });

    try {
        const bundle = await get(rel);
        assert.strictEqual(bundle.status, 200, 'the real bundle is still served');
        assert.ok(!bundle.body.includes('sourceMappingURL'));

        const map = await get(rel + '.map');
        assert.strictEqual(map.status, 404, 'the map file exists on disk but must not be exposed');
        assert.ok(!map.body.includes('secret.js'), 'no map content leaks in the refusal');
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(legacyMap, { force: true });
    }
});

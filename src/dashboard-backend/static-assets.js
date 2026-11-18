const express = require('express');

// ──────────────────── Built frontend assets ────────────────────
// Serves a Vite build directory, minus its source maps.
//
// `build.sourcemap` is off in web/vite.config.mjs, so a current build ships no
// `.map` files. This guard exists for the dist that is already on disk: a build
// made before that change (or with an override) would otherwise hand the whole
// source tree to anyone who can load the login bundle, because the assets are
// public by design. A `.map` request is answered 404 here even when the file is
// present.
function buildAssetMiddleware(dir) {
    const serve = express.static(dir, { index: false });
    return function assetMiddleware(req, res, next) {
        if (/\.map$/i.test(String(req.path || ''))) {
            return res.status(404).json({ error: 'Not found' });
        }
        return serve(req, res, next);
    };
}

module.exports = { buildAssetMiddleware };

// ──────────────────── Dashboard backend entry ────────────────────
// Assembles the Express app: base middleware, then every part registered
// in the SAME ORDER the routes lived in the original monolith
// (src/dashboard.js) — the auth part first (session resolution, guards,
// tenant scoping), route groups next, and the frontend shell plus the
// error handler last, because both are catch-alls.
//
// The public API (createDashboard, setDashboardClient, addDashUser,
// removeDashUser, getDashUsers) is re-exported unchanged, so callers
// keep importing from src/dashboard.js as before.

const express = require('express');
const crypto = require('crypto');
const { logInfo } = require('../logError');
const core = require('./core');

const parts = [
    require('./parts/02-auth'),
    require('./parts/03-dash-admin'),
    require('./parts/04-servers'),
    require('./parts/05-moderation'),
    require('./parts/06-engagement'),
    require('./parts/07-voice'),
    require('./parts/08-automod'),
    require('./parts/09-tickets'),
    require('./parts/10-insights'),
    require('./parts/11-ops'),
];

function createDashboard() {
    const app = express();
    // Proxy trust policy. Makes req.ip and req.secure reflect the real client
    // (X-Forwarded-For / X-Forwarded-Proto) — but only from peers we can trust.
    //
    // Default: XFF is honored only when the direct peer is a local address —
    // loopback (same-host nginx/Caddy, Docker on localhost), link-local, or a
    // private/ULA range (Railway, Discloud, Docker bridge networks). A bare VPS
    // sees public peers, so client-supplied XFF is ignored and the per-IP rate
    // limits can't be bypassed by rotating the header.
    //
    // TRUST_PROXY=1  trust XFF unconditionally (dashboard behind a public
    //                 proxy such as Cloudflare)
    // TRUST_PROXY=0  never trust XFF (strictest; no proxy at all)
    const trustProxyEnv = process.env.TRUST_PROXY;
    const trustProxy = trustProxyEnv === undefined
        ? ['loopback', 'linklocal', 'uniquelocal']
        : String(trustProxyEnv) === '1' || String(trustProxyEnv).toLowerCase() === 'true';
    app.set('trust proxy', trustProxy);
    // Body limits: 1 MB comfortably covers normal dashboard traffic; the bulk
    // import endpoint is the one route that legitimately carries an entire
    // exported database, so it gets its own larger parser instead of raising
    // the limit for every route.
    const jsonSmall = express.json({ limit: '1mb' });
    const jsonLarge = express.json({ limit: '25mb' });
    const formSmall = express.urlencoded({ extended: true, limit: '1mb' });
    const formLarge = express.urlencoded({ extended: true, limit: '25mb' });
    const LARGE_BODY_PATHS = new Set(['/api/import/all']);
    app.use((req, res, next) => {
        const path = String(req.path || '').split('?')[0];
        const isLarge = LARGE_BODY_PATHS.has(path);
        (isLarge ? jsonLarge : jsonSmall)(req, res, () =>
            (isLarge ? formLarge : formSmall)(req, res, next));
    });

    // Defense-in-depth CSP. No 'unsafe-inline' in script-src: the frontend
    // dispatches all events through a delegated listener reading data-fn /
    // data-args attributes (see dashboard/parts/00-entry.mjs), so inline event
    // handlers and injected <script> are both dead.
    app.use((req, res, next) => {
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
        );
        next();
    });

    // Request ID + timing for observability
    app.use((req, res, next) => {
        const requestId = req.headers['x-request-id'] || crypto.randomUUID();
        req.requestId = requestId;
        res.setHeader('X-Request-ID', requestId);
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
            logInfo(`${req.method} ${req.path} ${res.statusCode} ${durationMs.toFixed(2)}ms`, 'http', { requestId, ip: req.ip, userAgent: req.headers['user-agent'] });
        });
        next();
    });

    // Shared context: the parts attach the auth guards here (02-auth) and
    // every later part consumes them from ctx.
    const ctx = {
        getClient: core.getClient,
        upload: core.upload,
        uploadsDir: core.uploadsDir,
    };

    for (const part of parts) {
        part.register(app, ctx);
    }

    return app;
}

module.exports = {
    createDashboard,
    setDashboardClient: core.setDashboardClient,
    addDashUser: core.addDashUser,
    removeDashUser: core.removeDashUser,
    getDashUsers: core.getDashUsers,
};

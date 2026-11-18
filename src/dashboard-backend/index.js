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
const { isIP } = require('node:net');
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
    // The token-authenticated API goes in front of 11-ops: that part owns the
    // SPA fallback and the central error handler, and both have to stay last.
    require('./parts/12-public-api'),
    require('./parts/11-ops'),
];

function createDashboard() {
    const app = express();
    // Configure only proxy peers that sanitize the forwarding headers.
    const configured = process.env.TRUST_PROXY?.trim().toLowerCase();
    const peers = configured?.split(',').map(peer => peer.trim());
    if (configured && !['0', 'false'].includes(configured) && peers.some(peer => {
        const [address, prefix, extra] = peer.split('/');
        const family = isIP(address);
        return !family || extra !== undefined || (prefix !== undefined &&
            (!/^\d+$/.test(prefix) || Number(prefix) < 1 || Number(prefix) > (family === 4 ? 32 : 128)));
    })) {
        throw new Error('TRUST_PROXY requires explicit proxy IPs or CIDRs. Use 0 for direct access.');
    }
    const trustProxy = !configured ? 'loopback'
        : ['0', 'false'].includes(configured) ? false : peers;
    app.set('trust proxy', trustProxy);

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
        const requestId = crypto.randomUUID();
        req.requestId = requestId;
        res.setHeader('X-Request-ID', requestId);
        const start = process.hrtime.bigint();
        res.on('finish', () => {
            const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
            logInfo(`${req.method} ${req.baseUrl || ''}${req.path} ${res.statusCode} ${durationMs.toFixed(2)}ms`, 'http', { requestId });
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

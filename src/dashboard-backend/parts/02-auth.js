// ──────────────────── Part 02: Auth & middleware ────────────────────
// Session resolution, the global API rate limiter, login/logout/branding,
// and every access guard (requireAuth/requireOwner/checkOwner) plus the
// fail-closed tenant scoping that all later parts consume via ctx.

const express = require('express');
const {
    passwordMatches, checkRateLimit, checkBucketRateLimit,
    sessions, SESSION_TTL_MS, SESSION_MAX_MS, generateSession, sessionCookieOptions,
    getDashUsers, isDashUser,
} = require('../core');

// ── Auth (password OR Discord ID + Access Token) ──
const RECORD_CAPABILITIES = new Set(['records:read', 'records:write']);
const RECORD_PATH = /^\/(?:notes|reports|ban-appeals)(?:\/|$)|^\/member\/[^/]+\/profile(?:\/|$)/i;

function configuredStaffCapabilities() {
    const raw = process.env.DASHBOARD_STAFF_CAPABILITIES;
    if (!raw) return new Map();
    let config;
    try { config = JSON.parse(raw); } catch { /* handled below */ }
    if (!config || typeof config !== 'object' || Array.isArray(config) ||
        Object.entries(config).some(([userId, capabilities]) => !/^\d{5,25}$/.test(userId) ||
            !Array.isArray(capabilities) || capabilities.some(capability => !RECORD_CAPABILITIES.has(capability)))) {
        throw new Error('Invalid DASHBOARD_STAFF_CAPABILITIES configuration');
    }
    return new Map(Object.entries(config).map(([id, capabilities]) => [id, new Set(capabilities)]));
}

function register(app, ctx) {
    const staffCapabilities = configuredStaffCapabilities();
    function resolveSession(token) {
        const session = sessions.get(token);
        if (!session) return null;
        const now = Date.now();
        if (!session.expiresAt || now >= session.expiresAt || now >= session.createdAt + SESSION_MAX_MS ||
            (session.method === 'discord' && !isDashUser(session.userId, session.accessToken, { fromSession: true }))) {
            sessions.delete(token);
            return null;
        }
        return session;
    }

    app.use((req, res, next) => {
        req.sessionToken = sessionTokenFrom(req);
        const session = resolveSession(req.sessionToken);
        req.authenticated = !!session;
        req.dashboardSession = session;
        if (session) {
            session.expiresAt = Date.now() + SESSION_TTL_MS;
            req.discordUserId = session.userId || null;
            req.sessionMethod = session.method;
        }
        next();
    });

    // ── Global API Rate Limiter (applies to all authenticated endpoints) ──
    // Two buckets from the shared, dashboard-editable config:
    //   api        — every /api/ request
    //   modActions — a tighter second bucket on the destructive
    //                /api/server/:id/mod/* routes (warn/kick/ban/timeout)
    const EXEMPT_PATHS = new Set(['/api/login', '/api/branding', '/api/logout']);
    const MOD_ACTION_PATH = /^\/api\/server\/[^/]+\/mod\//;

    // Mount-path note: inside app.use('/api/', …) Express trims the mount
    // prefix, so req.path is '/login' — not '/api/login'. Comparing against
    // req.path made the exemption list above silently dead code; always
    // resolve the full path from originalUrl.
    function fullPath(req) {
        return String(req.originalUrl || req.url || '').split('?')[0].toLowerCase();
    }

    app.use('/api/', (req, res, next) => {
        const path = fullPath(req);
        const ip = req.ip || req.connection.remoteAddress || 'unknown';

        // 'global' caps every API request, exempt paths included — the outer
        // ceiling that keeps a login/branding flood bounded even though those
        // paths skip the tighter per-route buckets below.
        const globalCheck = checkBucketRateLimit('global', ip);
        if (!globalCheck.allowed) {
            console.warn('[Dashboard] Global rate limit hit for IP:', ip);
            return res.status(429).json({ success: false, error: 'Too many requests. Please slow down.' });
        }
        if (EXEMPT_PATHS.has(path)) return next();

        const rateCheck = checkBucketRateLimit('api', ip);
        if (!rateCheck.allowed) {
            console.warn('[Dashboard] API rate limit hit for IP:', ip);
            return res.status(429).json({ success: false, error: 'Too many requests. Please slow down.' });
        }
        if (MOD_ACTION_PATH.test(path) && req.method !== 'GET') {
            const modCheck = checkBucketRateLimit('modActions', ip);
            if (!modCheck.allowed) {
                console.warn('[Dashboard] Mod-action rate limit hit for IP:', ip);
                return res.status(429).json({ success: false, error: 'Too many moderation actions. Please slow down.' });
            }
            res.setHeader('X-RateLimit-ModActions-Remaining', modCheck.remaining);
        }
        res.setHeader('X-RateLimit-Limit', rateCheck.limit);
        res.setHeader('X-RateLimit-Remaining', rateCheck.remaining);
        next();
    });

    // Throttle before reading bodies. Only the owner import route needs
    // the larger budget, and it must authenticate before consuming it.
    app.post('/api/import/all', requireAuth, requireOwner,
        express.json({ limit: '25mb' }),
        express.urlencoded({ extended: true, limit: '25mb' }));
    app.use('/api', express.json({ limit: '1mb' }),
        express.urlencoded({ extended: true, limit: '1mb' }));

    app.post('/api/login', (req, res) => {
        // Rate limiting by IP
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const rateCheck = checkRateLimit(ip);
        if (!rateCheck.allowed) {
            console.warn('[Dashboard] Rate limit hit for IP:', ip);
            return res.status(429).json({ success: false, error: 'Too many attempts. Please wait a minute.' });
        }
        const { password, discordId, accessToken } = req.body || {};
        const now = Date.now();
        const expiresAt = now + SESSION_TTL_MS;
        if (password && passwordMatches(password)) {
            const token = generateSession();
            sessions.set(token, { method: 'password', expiresAt, createdAt: now });
            res.cookie('session', token, sessionCookieOptions(req));
            return res.json({ success: true });
        }
        if (discordId && accessToken) {
            // Check if user exists but has no access token (legacy user)
            const users = getDashUsers();
            const existing = users[discordId];
            if (existing && existing.active && !existing.hasToken) {
                return res.status(401).json({ success: false, error: 'This user needs a new access token. Run /dashaccess remove ' + discordId + ' then /dashaccess add @user again.' });
            }
            // Raw token, straight from the login form — the only path allowed to
            // present one. sessions.set() digests it before it touches disk.
            if (isDashUser(discordId, accessToken)) {
                const token = generateSession();
                sessions.set(token, { method: 'discord', userId: discordId, accessToken, expiresAt, createdAt: now });
                res.cookie('session', token, sessionCookieOptions(req));
                return res.json({ success: true, method: 'discord' });
            }
        }
        res.status(401).json({ success: false, error: 'Invalid credentials' });
    });

    // One place resolves the session cookie. The middleware below is the only
    // caller on the request path; everything downstream reads req.sessionToken,
    // which the middleware sets for every request (authenticated or not).
    function sessionTokenFrom(req) {
        return req.headers.cookie?.match(/session=([^;]+)/)?.[1] || null;
    }

    app.post('/api/logout', (req, res) => {
        const token = sessionTokenFrom(req);
        if (token) sessions.delete(token);
        res.clearCookie('session', { path: '/' });
        res.json({ success: true });
    });

    // Public branding — safe subset, no auth needed (login page uses it).
    app.get('/api/branding', (req, res) => {
        const { getDashboardConfig } = require('../core');
        const c = getDashboardConfig();
        res.json({
            title: c.title || 'Vigil',
            accentColor: c.accentColor || '#5865F2',
            logoUrl: c.logoUrl || null,
            faviconUrl: c.faviconUrl || null,
        });
    });

    function requireAuth(req, res, next) {
        if (!req.authenticated) return res.status(401).json({ error: 'Not authenticated' });
        next();
    }

    function isOwnerSession(session) {
        return session?.method === 'password' ||
            (session?.method === 'discord' && session.userId === process.env.OWNER_ID);
    }

    function checkOwner(req) {
        return isOwnerSession(req.dashboardSession);
    }

    function getSessionUser(req) {
        if (!req.dashboardSession) return 'unknown';
        return req.discordUserId || process.env.OWNER_ID || 'dashboard';
    }

    function scopeForSession(session) {
        if (isOwnerSession(session)) return null;
        if (!session || session.method !== 'discord' || !session.userId) return new Set();
        const db = require('../../db').getDb();
        return new Set(db.prepare('SELECT guild_id FROM dash_user_guilds WHERE user_id = ?')
            .all(session.userId).map(r => r.guild_id));
    }

    function getScopedGuildIds(req) {
        return scopeForSession(req.dashboardSession);
    }

    // Undefined means invalid. Null is reserved for a valid installation owner.
    function getLiveGuildScope(token) {
        const session = resolveSession(token);
        return session ? scopeForSession(session) : undefined;
    }

    function canAccessGuild(req, guildId) {
        if (!guildId) return false;
        const scoped = getScopedGuildIds(req);
        if (scoped === null) return true;
        return scoped.has(String(guildId));
    }

    function filterByScope(req, rows, key) {
        const scoped = getScopedGuildIds(req);
        if (scoped === null) return rows;
        return rows.filter(r => scoped.has(String(r[key])));
    }

    function requireOwner(req, res, next) {
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can do that' });
        next();
    }

    // Match and decode guild IDs using the same router as the handlers.
    app.use('/api/server/:guildId', (req, res, next) => {
        if (!canAccessGuild(req, req.params.guildId)) {
            return res.status(403).json({ error: 'You do not have access to this server' });
        }
        const capabilities = staffCapabilities.get(req.discordUserId);
        if (capabilities && !checkOwner(req) && RECORD_PATH.test(req.path)) {
            const needed = ['GET', 'HEAD'].includes(req.method) ? 'records:read' : 'records:write';
            if (!capabilities.has(needed)) return res.status(403).json({ error: 'Staff capability required' });
        }
        next();
    });

    // Share the guards with the later parts
    ctx.requireAuth = requireAuth;
    ctx.requireOwner = requireOwner;
    ctx.checkOwner = checkOwner;
    ctx.getSessionUser = getSessionUser;
    ctx.getScopedGuildIds = getScopedGuildIds;
    ctx.getLiveGuildScope = getLiveGuildScope;
    ctx.canAccessGuild = canAccessGuild;
    ctx.filterByScope = filterByScope;
}

module.exports = { register };

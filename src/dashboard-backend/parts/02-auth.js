// ──────────────────── Part 02: Auth & middleware ────────────────────
// Session resolution, the global API rate limiter, login/logout/branding,
// and every access guard (requireAuth/requireOwner/checkOwner) plus the
// fail-closed tenant scoping that all later parts consume via ctx.

const {
    passwordMatches, checkRateLimit, checkBucketRateLimit,
    sessions, SESSION_TTL_MS, SESSION_MAX_MS, generateSession, sessionCookieOptions,
    getDashUsers, isDashUser,
} = require('../core');

// ── Auth (password OR Discord ID + Access Token) ──
function register(app, ctx) {
    // Session middleware — resolves the cookie into req.authenticated and
    // re-verifies Discord sessions against dash_users on every request.
    app.use((req, res, next) => {
        const token = sessionTokenFrom(req);
        // Kept on the request so handlers can tell "this session" from the
        // others (the session list marks it, revoking it signs the caller out)
        // without re-parsing the cookie — checkOwner/getSessionUser reuse it.
        req.sessionToken = token;
        if (token && sessions.has(token)) {
            const session = sessions.get(token);
            // Expired session (idle TTL or absolute max) — drop and treat as unauthenticated
            const pastMax = session.createdAt && Date.now() > session.createdAt + SESSION_MAX_MS;
            if (!session.expiresAt || Date.now() > session.expiresAt || pastMax) {
                sessions.delete(token);
                req.authenticated = false;
                return next();
            }
            // Re-verify Discord-logged-in users against the dash_users table.
            // The session holds the token's digest, not the token (see core.js),
            // so this comparison is digest-to-digest — and it also picks up an
            // expiry or a re-issued token, killing the session immediately.
            if (session.method === 'discord' && session.userId) {
                if (!isDashUser(session.userId, session.accessToken, { fromSession: true })) {
                    sessions.delete(token);
                    req.authenticated = false;
                    return next();
                }
            }
            // Sliding renewal — reset the expiry on every authenticated request
            session.expiresAt = Date.now() + SESSION_TTL_MS;
            req.discordUserId = session.userId || null;
            req.sessionMethod = session.method;
            req.authenticated = true;
        } else {
            req.authenticated = false;
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
        return String(req.originalUrl || req.url || '').split('?')[0];
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

    app.post('/api/login', (req, res) => {
        // Rate limiting by IP
        const ip = req.ip || req.connection.remoteAddress || 'unknown';
        const rateCheck = checkRateLimit(ip);
        if (!rateCheck.allowed) {
            console.warn('[Dashboard] Rate limit hit for IP:', ip);
            return res.status(429).json({ success: false, error: 'Too many attempts. Please wait a minute.' });
        }
        const { password, discordId, accessToken } = req.body;
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

    function checkOwner(req, _res) {
        // For password-authenticated sessions, allow mod actions
        // For Discord-authenticated sessions, check if the user is the bot owner
        const token = req.sessionToken || sessionTokenFrom(req);
        if (!token || !sessions.has(token)) return false;
        const session = sessions.get(token);
        if (session.method === 'password') return true; // password = full access
        if (session.method === 'discord' && session.userId === process.env.OWNER_ID) return true;
        return false;
    }

    function getSessionUser(req) {
        const token = req.sessionToken || sessionTokenFrom(req);
        if (!token || !sessions.has(token)) return 'unknown';
        const session = sessions.get(token);
        return session.userId || process.env.OWNER_ID || 'dashboard';
    }

    // ── Tenant scoping ──
    // Password sessions and the OWNER_ID discord session see every server.
    // Any other dash user only sees servers explicitly granted to them in
    // dash_user_guilds. Fail-closed: unknown sessions are treated as scoped
    // with zero grants.
    function getScopedGuildIds(req) {
        if (checkOwner(req)) return null;
        const session = req.sessionToken ? sessions.get(req.sessionToken) : null;
        if (!session || session.method !== 'discord' || !session.userId) return new Set();
        const db = require('../../db').getDb();
        return new Set(db.prepare('SELECT guild_id FROM dash_user_guilds WHERE user_id = ?')
            .all(session.userId).map(r => r.guild_id));
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

    // Tenant guard — covers EVERY /api/server/:id/* route in one place so a
    // new route can never accidentally skip the scope check. Must run before
    // any server route from the later parts registers.
    app.use((req, res, next) => {
        const m = req.path.match(/^\/api\/server\/([^/]+)/);
        if (m && !canAccessGuild(req, m[1])) {
            return res.status(403).json({ error: 'You do not have access to this server' });
        }
        next();
    });

    // Share the guards with the later parts
    ctx.requireAuth = requireAuth;
    ctx.requireOwner = requireOwner;
    ctx.checkOwner = checkOwner;
    ctx.getSessionUser = getSessionUser;
    ctx.getScopedGuildIds = getScopedGuildIds;
    ctx.canAccessGuild = canAccessGuild;
    ctx.filterByScope = filterByScope;
}

module.exports = { register };

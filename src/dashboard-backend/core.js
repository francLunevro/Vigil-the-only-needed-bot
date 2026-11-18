// ──────────────────── Dashboard core (shared state) ────────────────────
// Shared state for every dashboard part: the Discord client, credentials,
// the dash-user/config stores, the multer upload pipeline, and the two
// stores that outlive a process — sessions and rate-limit windows, both
// persisted in SQLite. Parts never mutate this state directly — they go
// through the exported functions.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const { MAX_IMAGE_BYTES } = require('../imageSafety');
const { getDb } = require('../db');
const { logError } = require('../logError');

// ──── Discord client + credentials ────
let client = null;
let dashboardPassword = '';

function setDashboardClient(c, password) {
    client = c;
    if (!password) {
        console.error('[Dashboard] DASHBOARD_PASSWORD is not set! Please set it in your .env file.');
    }
    dashboardPassword = password;

    // The password is an environment variable, so it only changes across a
    // restart — and persisted sessions would otherwise survive that change.
    // A fingerprint of the password gives us a durable "the secret changed"
    // signal: every existing session is dropped once when it differs. First
    // boot just records the fingerprint.
    if (!password) return;
    try {
        const fingerprint = hashToken(password);
        const db = getDb();
        const row = db.prepare('SELECT value FROM bot_config WHERE key = ?').get('dashboard_password_fingerprint');
        if (row && row.value && row.value !== fingerprint) {
            db.prepare('DELETE FROM dashboard_sessions').run();
        }
        if (!row || row.value !== fingerprint) {
            db.prepare('INSERT OR REPLACE INTO bot_config (key, value) VALUES (?, ?)')
                .run('dashboard_password_fingerprint', fingerprint);
        }
    } catch (err) {
        logError(err, 'dashboard', 'password_fingerprint');
    }
}

function getClient() {
    return client;
}

// Constant-time password check — hashes both sides so length/timing of the
// raw comparison can't leak information about DASHBOARD_PASSWORD.
function passwordMatches(candidate) {
    if (!candidate || !dashboardPassword) return false;
    const a = crypto.createHash('sha256').update(String(candidate)).digest();
    const b = crypto.createHash('sha256').update(String(dashboardPassword)).digest();
    return crypto.timingSafeEqual(a, b);
}

// ──── Rate Limit Configuration ────
// One place defines every bucket. The dashboard's Rate Limits panel writes
// overrides into bot_config.ratelimit_config; getRateLimitConfig() merges
// those over these defaults and every limiter reads it, so the panel and
// enforcement can never disagree (they used to: the panel saved values that
// nothing consumed, and the mod-actions bucket wasn't enforced at all).
const DEFAULT_RATE_LIMITS = {
    global: { windowMs: 60 * 1000, max: 120 },
    login: { windowMs: 60 * 1000, max: 10 },
    api: { windowMs: 60 * 1000, max: 120 },
    modActions: { windowMs: 60 * 1000, max: 30 },
};

// Cached briefly — this runs on every request, and a DB read per request
// would be wasteful. Saving from the dashboard invalidates it immediately.
const RATE_LIMIT_CACHE_MS = 5000;
let rateLimitConfigCache = null;
let rateLimitConfigCachedAt = 0;

function getRateLimitConfig() {
    const now = Date.now();
    if (rateLimitConfigCache && now - rateLimitConfigCachedAt < RATE_LIMIT_CACHE_MS) {
        return rateLimitConfigCache;
    }
    const merged = {};
    for (const [bucket, def] of Object.entries(DEFAULT_RATE_LIMITS)) {
        merged[bucket] = { ...def };
    }
    try {
        const row = getDb().prepare('SELECT value FROM bot_config WHERE key = ?').get('ratelimit_config');
        const saved = row && row.value ? JSON.parse(row.value) : null;
        for (const bucket of Object.keys(DEFAULT_RATE_LIMITS)) {
            const v = saved && saved[bucket];
            if (!v) continue;
            const windowMs = Number(v.windowMs);
            const max = Number(v.max);
            if (Number.isFinite(windowMs) && windowMs >= 1000) merged[bucket].windowMs = windowMs;
            if (Number.isFinite(max) && max >= 1) merged[bucket].max = Math.floor(max);
        }
    } catch { /* fall back to the defaults above */ }
    rateLimitConfigCache = merged;
    rateLimitConfigCachedAt = now;
    return merged;
}

function invalidateRateLimitConfigCache() {
    rateLimitConfigCache = null;
    rateLimitConfigCachedAt = 0;
}

// ──── Bucket Limiters ────
// Generic per-IP fixed-window counter, one window per (bucket, ip) row in
// SQLite. This used to be a process Map: a restart (or a deploy) reset every
// window, so a client who had just been blocked got a fresh budget. Storing
// it means the window survives restarts and is shared across replicas.
//
// A failed lookup fails OPEN (allow) rather than closed: if the database is
// unreadable the dashboard is already broken, and locking every admin out of
// it is the worse failure. The log is throttled below so a persistent fault
// can't flood error_logs from the request hot path.
const RATE_LIMIT_LOG_THROTTLE_MS = 60 * 1000;
let lastRateLimitErrorAt = 0;

function checkBucketRateLimit(bucket, ip) {
    const cfg = getRateLimitConfig()[bucket] || DEFAULT_RATE_LIMITS[bucket];
    const key = ip || 'unknown';
    const now = Date.now();
    try {
        const db = getDb();
        const row = db.prepare('SELECT count, window_start FROM rate_limit_hits WHERE bucket = ? AND ip = ?').get(bucket, key);
        const stale = !row || now - row.window_start > cfg.windowMs;
        const count = stale ? 1 : row.count + 1;
        db.prepare('INSERT OR REPLACE INTO rate_limit_hits (bucket, ip, count, window_start) VALUES (?, ?, ?, ?)')
            .run(bucket, key, count, stale ? now : row.window_start);
        if (count > cfg.max) {
            return { allowed: false, remaining: 0, limit: cfg.max, windowMs: cfg.windowMs };
        }
        return { allowed: true, remaining: cfg.max - count, limit: cfg.max, windowMs: cfg.windowMs };
    } catch (err) {
        if (now - lastRateLimitErrorAt > RATE_LIMIT_LOG_THROTTLE_MS) {
            lastRateLimitErrorAt = now;
            logError(err, 'dashboard', 'rate_limit:' + bucket);
        }
        return { allowed: true, remaining: 0, limit: cfg.max, windowMs: cfg.windowMs };
    }
}

// Login attempts keep their dedicated entry point (the dashboard auth tests
// exercise this name directly).
function checkRateLimit(ip) {
    return checkBucketRateLimit('login', ip);
}

// Drop windows nobody is counting against any more, every 5 minutes.
const rateLimitReaper = setInterval(() => {
    try {
        const widest = Math.max(...Object.values(getRateLimitConfig()).map(c => c.windowMs));
        getDb().prepare('DELETE FROM rate_limit_hits WHERE window_start < ?').run(Date.now() - widest * 2);
    } catch (err) {
        logError(err, 'dashboard', 'rate_limit_reaper');
    }
}, 5 * 60 * 1000);
rateLimitReaper.unref();

// ──── Sessions ────
// Persisted in SQLite (dashboard_sessions) rather than a process Map, so a
// restart no longer logs every admin out and replicas share one session store.
// get() returns a handle with plain read-only fields plus write-through
// expiresAt/createdAt accessors, so the existing `session.expiresAt = ...`
// sliding renewal keeps working — it used to mutate a shared object, now it
// writes the row.
//
// Sliding renewal reassigns expiresAt on every authenticated request, which
// would otherwise mean a write transaction per dashboard poll. Renewals that
// move the expiry by less than RENEWAL_WRITE_MIN_MS stay in the handle only —
// immaterial against a multi-hour TTL, and the persisted value lags by at most
// that much.
const RENEWAL_WRITE_MIN_MS = 60 * 1000;

function makeSessionHandle(token, row) {
    const cached = { expiresAt: row.expires_at, createdAt: row.created_at };
    const handle = {
        method: row.method,
        userId: row.user_id || null,
        accessToken: row.access_token || null,
    };
    Object.defineProperty(handle, 'expiresAt', {
        enumerable: true,
        configurable: true,
        get: () => cached.expiresAt,
        set: (value) => {
            const negligible = typeof cached.expiresAt === 'number'
                && Math.abs(value - cached.expiresAt) < RENEWAL_WRITE_MIN_MS;
            cached.expiresAt = value;
            if (negligible) return;
            try { getDb().prepare('UPDATE dashboard_sessions SET expires_at = ? WHERE token = ?').run(value, token); }
            catch (err) { logError(err, 'dashboard', 'session_renew'); }
        },
    });
    Object.defineProperty(handle, 'createdAt', {
        enumerable: true,
        configurable: true,
        get: () => cached.createdAt,
        set: (value) => {
            cached.createdAt = value;
            try { getDb().prepare('UPDATE dashboard_sessions SET created_at = ? WHERE token = ?').run(value, token); }
            catch (err) { logError(err, 'dashboard', 'session_touch'); }
        },
    });
    return handle;
}

// Same shape as the Map it replaces: has/get/set/delete/entries are all the
// callers ever used. Auth reads fail CLOSED — an unverifiable token is never
// treated as authenticated.
// The session table holds only a digest of the cookie token. A stolen
// bot.db therefore yields no usable session cookie — the raw token exists
// only in the browser. Rows written by older releases still hold the raw
// value; `findSessionRow` upgrades one in place the first time it is used, so
// a deploy does not sign everyone out.
function sessionLookupKey(token) {
    return hashToken(token);
}

function findSessionRow(token) {
    if (!token) return null;
    const offered = String(token);
    const db = getDb();

    // Generated tokens are base64url, never 64 hex characters, so a 64-hex
    // value is already a stored digest (entries/revoke pass one back in).
    if (TOKEN_HASH_RE.test(offered)) {
        return db.prepare('SELECT * FROM dashboard_sessions WHERE token = ?').get(offered) || null;
    }

    const legacy = db.prepare('SELECT * FROM dashboard_sessions WHERE token = ?').get(offered);
    if (legacy) {
        const digest = sessionLookupKey(offered);
        try {
            db.prepare('UPDATE dashboard_sessions SET token = ? WHERE token = ?').run(digest, offered);
        } catch (err) {
            // A concurrent upgrade already replaced the row; the digest lookup
            // below still finds it.
            logError(err, 'dashboard', 'session_upgrade');
        }
        return db.prepare('SELECT * FROM dashboard_sessions WHERE token = ?').get(digest) || null;
    }

    return db.prepare('SELECT * FROM dashboard_sessions WHERE token = ?').get(sessionLookupKey(offered)) || null;
}

const sessions = {
    has(token) {
        if (!token) return false;
        try {
            return !!findSessionRow(token);
        } catch (err) {
            logError(err, 'dashboard', 'session_has');
            return false;
        }
    },
    get(token) {
        if (!token) return undefined;
        try {
            const row = findSessionRow(token);
            return row ? makeSessionHandle(row.token, row) : undefined;
        } catch (err) {
            logError(err, 'dashboard', 'session_get');
            return undefined;
        }
    },
    set(token, session) {
        try {
            // Both credentials are digested before they touch disk: the cookie
            // token (the column key) and a discord session's copy of the dash
            // access token. Otherwise a backup leak would hand over exactly the
            // long-lived credentials that hashing exists to deny. Already-digest
            // values pass through untouched.
            // (hashToken/TOKEN_HASH_RE are defined below, with the other token helpers.)
            const storedToken = sessionLookupKey(token);
            const accessToken = !session.accessToken ? null
                : (TOKEN_HASH_RE.test(String(session.accessToken)) ? String(session.accessToken) : hashToken(session.accessToken));
            const db = getDb();
            // Drop a pre-upgrade raw row so the same session cannot exist twice.
            db.prepare('DELETE FROM dashboard_sessions WHERE token = ? AND token <> ?').run(String(token), storedToken);
            db.prepare(`INSERT OR REPLACE INTO dashboard_sessions
                (token, method, user_id, access_token, created_at, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)`).run(
                storedToken,
                session.method || 'password',
                session.userId || null,
                accessToken,
                session.createdAt || Date.now(),
                session.expiresAt || Date.now(),
            );
        } catch (err) {
            logError(err, 'dashboard', 'session_set');
        }
    },
    delete(token) {
        try {
            const db = getDb();
            const offered = String(token || '');
            if (!offered) return;
            // entries() hands back stored digests; callers elsewhere still hold
            // the raw cookie value. Try both, without ever accepting a digest
            // from a request (auth always resolves through findSessionRow).
            const direct = db.prepare('DELETE FROM dashboard_sessions WHERE token = ?').run(offered);
            if (direct.changes === 0 && !TOKEN_HASH_RE.test(offered)) {
                db.prepare('DELETE FROM dashboard_sessions WHERE token = ?').run(sessionLookupKey(offered));
            }
        }
        catch (err) { logError(err, 'dashboard', 'session_delete'); }
    },
    // Materialised up front so callers can delete while iterating (removeDashUser does).
    // Keys are the stored digests; delete() accepts them directly.
    *entries() {
        let rows;
        try {
            rows = getDb().prepare('SELECT * FROM dashboard_sessions').all();
        } catch (err) {
            logError(err, 'dashboard', 'session_entries');
            return;
        }
        for (const row of rows) yield [row.token, makeSessionHandle(row.token, row)];
    },
    // Exposed so routes can derive a public id from a raw cookie without
    // learning (or storing) the digest themselves.
    key: sessionLookupKey,
};

// A handle the dashboard can name a session by without ever being handed the
// bearer token itself. One-way, so possessing it grants nothing except the
// ability to ask for that session to be ended.
function sessionPublicId(token) {
    return crypto.createHash('sha256').update('session-id:' + String(token)).digest('hex').slice(0, 16);
}

// Session lifetime — default 24h of inactivity (sliding renewal on each request).
// Override with DASHBOARD_SESSION_HOURS env var.
const SESSION_TTL_MS = (parseFloat(process.env.DASHBOARD_SESSION_HOURS) || 24) * 60 * 60 * 1000;

// Absolute cap — a session can never live longer than this, even with constant
// activity, so a stolen token can't be kept alive indefinitely by any traffic.
// Default 7 days. Override with DASHBOARD_SESSION_MAX_DAYS env var.
const SESSION_MAX_MS = Math.max(1, parseFloat(process.env.DASHBOARD_SESSION_MAX_DAYS) || 7) * 24 * 60 * 60 * 1000;

function generateSession() {
    return crypto.randomBytes(32).toString('base64url');
}

// Session cookies are HttpOnly (invisible to JS — kills XSS token theft),
// Secure when served over TLS, Strict SameSite (kills CSRF from other origins).
function sessionCookieOptions(req) {
    return {
        httpOnly: true,
        secure: req.secure,
        sameSite: 'strict',
        path: '/',
        maxAge: SESSION_TTL_MS,
    };
}

// Reap expired sessions every 10 minutes so the table doesn't grow unbounded.
// Both limits are enforced here in SQL: the sliding idle TTL and the absolute
// cap (which a constantly-renewed session would otherwise outlive).
const sessionReaper = setInterval(() => {
    try {
        const now = Date.now();
        getDb().prepare('DELETE FROM dashboard_sessions WHERE expires_at <= ? OR created_at <= ?')
            .run(now, now - SESSION_MAX_MS);
    } catch (err) {
        logError(err, 'dashboard', 'session_reaper');
    }
}, 10 * 60 * 1000);
sessionReaper.unref();

// ──── Dashboard access-token hashing ────
// Tokens are never stored in plaintext: only their SHA-256 hex digest goes
// into dash_users.access_token, and sessions hold that same digest rather than
// the token. A leaked database backup therefore can't be used to log in as
// anyone (the raw token is shown exactly once, at creation).
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

// Access tokens expire by default, so a leaked one has a shelf life instead of
// being a permanent credential. Override with DASHBOARD_TOKEN_DAYS; set 0 to
// never expire (the old behaviour, and what pre-upgrade rows keep).
const TOKEN_TTL_DAYS_ENV = parseFloat(process.env.DASHBOARD_TOKEN_DAYS);
const TOKEN_TTL_MS = (Number.isFinite(TOKEN_TTL_DAYS_ENV) ? Math.max(0, TOKEN_TTL_DAYS_ENV) : 90) * 24 * 60 * 60 * 1000;

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// "Never expires" is NULL rather than a timestamp, so a 0 TTL can't produce an
// expiry in the past.
function tokenExpiryFromNow() {
    return TOKEN_TTL_MS > 0 ? Date.now() + TOKEN_TTL_MS : null;
}

function safeEqualHex(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
    try { return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')); }
    catch { return false; }
}

// Verify a candidate token against the stored value.
//
// `fromSession` means the candidate came out of a session row, where only the
// digest is kept — so that path compares digests directly. Every other caller
// (the login route) must present the *raw* token, and a digest offered there is
// hashed first and therefore never matches. That asymmetry is deliberate: it
// stops a digest lifted from a backup from being usable as a credential.
//
// Expiry is checked here rather than at the call sites so it applies to both
// paths — an expired token must also kill the sessions it created, not merely
// refuse future logins.
//
// Rows written before the hashing change hold plaintext; those upgrade in place
// on the first successful login, so the migration needs no user action.
function verifyDashToken(row, candidate, fromSession = false) {
    if (!row || !row.access_token || !candidate) return false;
    if (row.expires_at && Date.now() > row.expires_at) return false;

    const stored = String(row.access_token);
    const offered = String(candidate);

    if (fromSession && TOKEN_HASH_RE.test(offered)) {
        return TOKEN_HASH_RE.test(stored) && safeEqualHex(stored, offered);
    }

    if (TOKEN_HASH_RE.test(stored)) {
        return safeEqualHex(stored, hashToken(offered));
    }

    // Legacy plaintext row — constant-length guard before timingSafeEqual.
    if (!safeEqualHex(stored, offered)) return false;
    try {
        getDb().prepare('UPDATE dash_users SET access_token = ? WHERE user_id = ?').run(hashToken(offered), row.user_id);
    } catch { /* upgrade is best-effort; verification already succeeded */ }
    return true;
}

// ──── Dashboard Config (SQLite) ────
const DEFAULT_DASHBOARD_CONFIG = {
    accentColor: '#5865F2',
    title: 'Vigil',
    backgroundImage: null,
    backgroundType: 'none',
    backgroundBlur: 'md',
    showWidgets: {
        status: true, servers: true, reminders: true, quickActions: true,
        analytics: true, activity: true, system: true,
    },
    refreshInterval: 5,
    cardStyle: 'glass',
    backgroundStyle: 'none',
    layoutDensity: 'normal',
    animationPreset: 'smooth',
    animationSpeed: 1,
    cardGlow: true,
    ambientLight: true,
    headerStyle: 'minimal',
    borderRadius: 'rounded',
    borderStrength: 'normal',
    themePreset: 'discord',
    fontFamily: 'system',
    showDockLabels: true,
    botAvatarUrl: null,
    logoUrl: null,
    faviconUrl: null,
};

function getDashboardConfig() {
    const db = getDb();
    const row = db.prepare('SELECT config FROM dash_config WHERE id = 1').get();
    if (!row) {
        // First load — use defaults
        db.prepare('INSERT OR REPLACE INTO dash_config (id, config) VALUES (1, ?)').run(JSON.stringify(DEFAULT_DASHBOARD_CONFIG));
        return { ...DEFAULT_DASHBOARD_CONFIG };
    }
    try {
        const saved = JSON.parse(row.config);
        return { ...DEFAULT_DASHBOARD_CONFIG, ...saved };
    } catch {
        return { ...DEFAULT_DASHBOARD_CONFIG };
    }
}

function updateDashboardConfig(partial) {
    const current = getDashboardConfig();
    const updated = { ...current, ...partial };
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO dash_config (id, config) VALUES (1, ?)').run(JSON.stringify(updated));
    return updated;
}

// ──── Dashboard Users (SQLite) ────
function getDashUsers() {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM dash_users WHERE active = 1').all();
    const now = Date.now();
    const result = {};
    for (const row of rows) {
        result[row.user_id] = {
            addedAt: row.added_at,
            addedBy: row.added_by,
            active: !!row.active,
            hasToken: !!row.access_token,
            // NULL means the token never expires (pre-upgrade rows).
            expiresAt: row.expires_at || null,
            lastUsedAt: row.last_used_at || null,
            expired: !!(row.expires_at && now > row.expires_at),
        };
    }
    return result;
}

function generateAccessToken() {
    return 'dash_' + crypto.randomBytes(24).toString('base64url');
}

function addDashUser(userId, addedBy) {
    const db = getDb();
    const token = generateAccessToken();
    // Store only the hash — the raw token is returned once to be shown in Discord/UI.
    // Re-issuing resets last_used_at: a brand-new token has never been used.
    const expiresAt = tokenExpiryFromNow();
    db.prepare(`INSERT OR REPLACE INTO dash_users
        (user_id, added_at, added_by, active, access_token, expires_at, last_used_at)
        VALUES (?, ?, ?, 1, ?, ?, NULL)`)
        .run(userId, Date.now(), addedBy || 'unknown', hashToken(token), expiresAt);
    return { users: getDashUsers(), accessToken: token, expiresAt };
}

function removeDashUser(userId) {
    if (!userId) return false;
    const db = getDb();
    const result = db.prepare('DELETE FROM dash_users WHERE user_id = ?').run(userId);
    const removed = result.changes > 0;
    if (!removed) return false;
    // Drop their guild scopes too
    db.prepare('DELETE FROM dash_user_guilds WHERE user_id = ?').run(userId);
    // Invalidate all active sessions for this user — clear every session type
    for (const [token, session] of sessions.entries()) {
        if (session.userId === userId) {
            sessions.delete(token);
        }
    }
    return true;
}

function touchTokenUsage(userId) {
    try {
        getDb().prepare('UPDATE dash_users SET last_used_at = ? WHERE user_id = ?').run(Date.now(), userId);
    } catch (err) {
        logError(err, 'dashboard', 'token_last_used');
    }
}

// `opts.fromSession` marks a candidate that came out of a session row — the
// digest, not the raw token. Only the login route passes a raw token.
function isDashUser(userId, accessToken, opts = {}) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM dash_users WHERE user_id = ? AND active = 1').get(userId);
    if (!row) return false;
    if (!accessToken) return true;
    if (!verifyDashToken(row, accessToken, opts.fromSession === true)) return false;
    // Record real usage so a leaked token shows up as "last used ..." instead of
    // sitting there invisible. Session re-verification runs on every request,
    // so it must never write.
    if (!opts.fromSession) touchTokenUsage(row.user_id);
    return true;
}

// ──── File Upload Setup ────
const uploadsDir = process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 0, parts: 2 },
});

module.exports = {
    // client + credentials
    setDashboardClient, getClient, passwordMatches,
    // rate limiting (login / api / mod actions, all config-driven)
    checkRateLimit, checkBucketRateLimit, getRateLimitConfig,
    invalidateRateLimitConfigCache, DEFAULT_RATE_LIMITS,
    // sessions
    sessions, sessionPublicId, SESSION_TTL_MS, SESSION_MAX_MS, generateSession, sessionCookieOptions,
    // dash users + access tokens
    hashToken, verifyDashToken, getDashUsers, generateAccessToken, addDashUser, removeDashUser, isDashUser,
    TOKEN_TTL_MS, TOKEN_HASH_RE,
    // dashboard config store
    getDashboardConfig, updateDashboardConfig, DEFAULT_DASHBOARD_CONFIG,
    // uploads
    upload, uploadsDir,
};

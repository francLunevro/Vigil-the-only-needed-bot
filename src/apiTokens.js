// ──────────────────── API tokens ────────────────────
// Long-lived bearer tokens for external integrations (monitoring, CI, a status
// page). The dashboard could already mint them — scopes, expiry, "shown exactly
// once" — but nothing ever verified one, so every token was decorative: the
// table was a promise the bot never kept.
//
// This module is the other half. Tokens are stored as a SHA-256 digest and
// looked up by that digest, so the database never holds anything usable and a
// leak of bot.db doesn't hand out access. The raw token exists only in the
// mint response and in whatever the operator stored it in.
//
// Scope model (mirrors the dashboard's picker):
//   read:servers     list servers the bot is in
//   read:stats       counters and aggregates for one server
//   read:logs        recent message-log entries for one server
//   admin:all        implies every scope above
//   write:webhooks   reserved — accepted and stored, but nothing consumes it
//                    yet, and it grants no access on its own

const crypto = require('crypto');
const { getDb } = require('./db');

const SCOPES = ['read:servers', 'read:stats', 'read:logs', 'write:webhooks', 'admin:all'];
// Scopes that are stored but not yet honoured by any endpoint. Kept explicit so
// a token holding only these is refused with a real reason instead of a
// confusing 403 on every route.
const RESERVED_SCOPES = ['write:webhooks'];
const TOKEN_PREFIX = 'nlux_';
const MAX_NAME_LENGTH = 100;
const MAX_EXPIRY_DAYS = 3650;

function hashToken(raw) {
    return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// The digest lookup already implies equality, so this is belt-and-braces: it
// keeps the comparison constant-time if the query is ever loosened (e.g. a
// lookup by id or prefix).
function digestMatches(storedHex, computedHex) {
    if (typeof storedHex !== 'string' || typeof computedHex !== 'string') return false;
    const a = Buffer.from(storedHex, 'hex');
    const b = Buffer.from(computedHex, 'hex');
    if (a.length !== b.length || a.length === 0) return false;
    return crypto.timingSafeEqual(a, b);
}

function mapToken(row) {
    let scopes = [];
    try { scopes = JSON.parse(row.scopes || '[]'); } catch { scopes = []; }
    if (!Array.isArray(scopes)) scopes = [];
    return {
        id: row.id,
        name: row.name,
        scopes,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at || null,
        expiresAt: row.expires_at || null,
    };
}

// Create a token. Returns { token } with the raw value — the only time it is
// ever available — or { error } for anything the caller should show the user.
function createApiToken({ name, scopes, expiresInDays } = {}) {
    const cleanName = String(name || '').trim();
    if (!cleanName) return { error: 'A token name is required.' };
    if (cleanName.length > MAX_NAME_LENGTH) return { error: 'The name must be ' + MAX_NAME_LENGTH + ' characters or less.' };

    const requested = Array.isArray(scopes) ? scopes : [];
    const unknown = requested.filter((s) => !SCOPES.includes(s));
    if (unknown.length) return { error: 'Unknown scope: ' + unknown.join(', ') + '. Valid: ' + SCOPES.join(', ') };

    const days = Number(expiresInDays) || 0;
    if (days < 0 || days > MAX_EXPIRY_DAYS) return { error: 'Expiry must be between 0 and ' + MAX_EXPIRY_DAYS + ' days.' };
    const expiresAt = days > 0 ? Date.now() + days * 24 * 60 * 60 * 1000 : null;

    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const info = getDb()
        .prepare('INSERT INTO api_tokens (name, token_hash, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
        .run(cleanName, hashToken(token), JSON.stringify(requested), Date.now(), expiresAt);

    const row = getDb().prepare('SELECT * FROM api_tokens WHERE id = ?').get(info.lastInsertRowid);
    return { token, entry: mapToken(row) };
}

// The dashboard's /api/tokens response shape, kept deliberately in snake_case:
// both frontends (web/src/screens/ApiTokens.jsx and dashboard/parts/07-voice.mjs)
// read `token_hash`, `scopes`, `created_at`, `expires_at` and `last_used_at`
// directly, so renaming these fields is a UI change, not a refactor.
// `scopes` is served as an array here — the table stores JSON, and the array is
// what both renderers want.
// Never exposes the digest: eight characters are enough to tell two tokens
// apart, and the rest is not recoverable anyway.
function listApiTokens() {
    const rows = getDb().prepare('SELECT * FROM api_tokens ORDER BY created_at DESC').all();
    return rows.map((row) => {
        const token = mapToken(row);
        return {
            id: token.id,
            name: token.name,
            token_hash: String(row.token_hash).slice(0, 8) + '...',
            scopes: token.scopes,
            created_at: token.createdAt,
            last_used_at: token.lastUsedAt,
            expires_at: token.expiresAt,
        };
    });
}

function revokeApiToken(id) {
    const result = getDb().prepare('DELETE FROM api_tokens WHERE id = ?').run(id);
    return result.changes > 0;
}

// Resolve a raw bearer token. Returns { token } when it is usable, otherwise
// { status, error } with a reason safe to hand back to the caller.
function verifyApiToken(rawToken) {
    const raw = String(rawToken || '').trim();
    if (!raw || !raw.startsWith(TOKEN_PREFIX)) return { status: 401, error: 'Invalid API token.' };

    const digest = hashToken(raw);
    const row = getDb().prepare('SELECT * FROM api_tokens WHERE token_hash = ?').get(digest);
    if (!row || !digestMatches(row.token_hash, digest)) return { status: 401, error: 'Invalid API token.' };
    if (row.expires_at && Date.now() > row.expires_at) {
        return { status: 401, error: 'This API token has expired.', expired: true };
    }
    return { token: mapToken(row) };
}

function hasScope(token, scope) {
    if (!token || !Array.isArray(token.scopes)) return false;
    return token.scopes.includes(scope) || token.scopes.includes('admin:all');
}

// A token with no usable scope would 403 on every route — say so up front.
function usableScopes(token) {
    if (!token) return [];
    if (token.scopes.includes('admin:all')) return SCOPES.filter((s) => !RESERVED_SCOPES.includes(s));
    return token.scopes.filter((s) => !RESERVED_SCOPES.includes(s));
}

// Record the use, at most once a minute per token: this runs on every
// authenticated request, and `last_used_at` is a convenience, not a log.
const TOUCH_INTERVAL_MS = 60 * 1000;

function touchApiToken(id) {
    try {
        getDb()
            .prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)')
            .run(Date.now(), id, Date.now() - TOUCH_INTERVAL_MS);
    } catch {
        // A bookkeeping write must never fail a request.
    }
}

module.exports = {
    SCOPES,
    RESERVED_SCOPES,
    TOKEN_PREFIX,
    MAX_EXPIRY_DAYS,
    hashToken,
    createApiToken,
    listApiTokens,
    revokeApiToken,
    verifyApiToken,
    hasScope,
    usableScopes,
    touchApiToken,
};

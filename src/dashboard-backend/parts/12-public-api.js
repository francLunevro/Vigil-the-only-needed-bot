// ──────────────────── Part 12: Public API ────────────────────
// Read-only endpoints for external integrations, authenticated with an API
// token (`Authorization: Bearer nlux_…`) instead of a dashboard session. See
// src/apiTokens.js for the token model.
//
// These routes sit under /api/, so the part 02 rate limiter already applies
// (global + api buckets, per IP). They are registered *before* 11-ops, which
// owns the SPA fallback and the central error handler — both of which have to
// stay last, or a thrown error would escape as an HTML stack trace.
//
// Every response shape here is part of the contract with whatever the operator
// builds on top, so treat changes as additive-only.

const { getClient } = require('../core');
const { logError } = require('../../logError');
const {
    SCOPES, RESERVED_SCOPES, verifyApiToken,
    hasScope, usableScopes, touchApiToken,
} = require('../../apiTokens');

const MAX_LOG_LIMIT = 200;
const DEFAULT_LOG_LIMIT = 50;
// Bounded: this is a log feed, not a message-archive dump.
const MAX_CONTENT_CHARS = 500;

// Bearer-token guard. `scope` is required unless the route only needs "any
// valid token" — that is what /api/v1/me is for.
function requireApiToken(scope) {
    return (req, res, next) => {
        const header = String(req.headers.authorization || '');
        const match = /^Bearer\s+(.+)$/i.exec(header.trim());
        if (!match) {
            res.setHeader('WWW-Authenticate', 'Bearer realm="Vigil API"');
            return res.status(401).json({ error: 'Provide a token: Authorization: Bearer <token>' });
        }

        const result = verifyApiToken(match[1].trim());
        if (result.error) {
            res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
            return res.status(401).json({ error: result.error, expired: !!result.expired });
        }

        if (scope && !hasScope(result.token, scope)) {
            // A token holding only reserved scopes would 403 on every route with
            // a misleading "missing scope" — name the real reason instead.
            const usable = usableScopes(result.token);
            const reserved = result.token.scopes.filter((s) => RESERVED_SCOPES.includes(s));
            const error = (usable.length === 0 && reserved.length)
                ? 'This token only holds ' + reserved.join(', ') + ', which is reserved and not served yet. Add ' + SCOPES.slice(0, 3).join(', ') + '.'
                : 'This token is missing the ' + scope + ' scope.';
            return res.status(403).json({ error, scopes: result.token.scopes });
        }

        touchApiToken(result.token.id);
        req.apiToken = result.token;
        next();
    };
}

function serverSummary(guild) {
    return {
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount || 0,
        ownerId: guild.ownerId || null,
        icon: guild.iconURL ? guild.iconURL({ size: 128 }) : null,
        boostTier: guild.premiumTier || 0,
        boosts: guild.premiumSubscriptionCount || 0,
    };
}

// Counts are best-effort: a missing table must not turn a stats request into a
// 500 when every other number on the page is fine.
function count(db, sql, ...params) {
    try {
        const row = db.prepare(sql).get(...params);
        return row ? row.n : 0;
    } catch (err) {
        logError(err, 'dashboard', 'api_count');
        return 0;
    }
}

function register(app) {
    // ── What am I? ──
    // Needs only a valid token: this is how an integration (or a human with
    // curl) confirms the token was stored and which scopes it carries.
    app.get('/api/v1/me', requireApiToken(null), (req, res) => {
        res.json({
            name: req.apiToken.name,
            scopes: req.apiToken.scopes,
            expiresAt: req.apiToken.expiresAt,
            lastUsedAt: req.apiToken.lastUsedAt,
            reservedScopes: RESERVED_SCOPES,
        });
    });

    // ── Servers ──
    app.get('/api/v1/servers', requireApiToken('read:servers'), (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const servers = [...client.guilds.cache.values()]
            .map(serverSummary)
            .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        res.json({ servers, count: servers.length });
    });

    app.get('/api/v1/servers/:id', requireApiToken('read:servers'), (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'That server is not in the bot\'s list' });
        res.json({ server: serverSummary(guild) });
    });

    // ── Stats ──
    app.get('/api/v1/servers/:id/stats', requireApiToken('read:stats'), (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'That server is not in the bot\'s list' });

        try {
            // Live counters come from the same helper the stat channels use, so
            // these numbers cannot drift from what those channels display.
            const { computeStat } = require('../../serverStats');
            const live = {};
            for (const stat of ['members', 'humans', 'bots', 'online', 'channels', 'roles', 'emojis']) {
                live[stat] = computeStat(guild, guild.members, stat);
            }

            const db = require('../../db').getDb();
            const guildId = guild.id;
            const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
            const totals = db.prepare('SELECT total_joins, total_leaves FROM guild_stats WHERE guild_id = ?').get(guildId) || {};

            res.json({
                server: { id: guild.id, name: guild.name },
                live,
                membership: { joins: totals.total_joins || 0, leaves: totals.total_leaves || 0 },
                moderation: {
                    cases: count(db, 'SELECT COUNT(*) AS n FROM mod_cases WHERE guild_id = ?', guildId),
                    openCases: count(db, 'SELECT COUNT(*) AS n FROM mod_cases WHERE guild_id = ? AND active = 1', guildId),
                    warnings: count(db, 'SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ?', guildId),
                    warningsLast7d: count(db, 'SELECT COUNT(*) AS n FROM warnings WHERE guild_id = ? AND date >= ?', guildId, new Date(weekAgo).toISOString()),
                },
                tickets: {
                    open: count(db, 'SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ? AND status = ?', guildId, 'open'),
                    total: count(db, 'SELECT COUNT(*) AS n FROM tickets WHERE guild_id = ?', guildId),
                },
                commands: {
                    total: count(db, 'SELECT COUNT(*) AS n FROM command_usage WHERE guild_id = ?', guildId),
                    last7d: count(db, 'SELECT COUNT(*) AS n FROM command_usage WHERE guild_id = ? AND used_at >= ?', guildId, weekAgo),
                },
                generatedAt: Date.now(),
            });
        } catch (err) {
            logError(err, 'dashboard', 'api_stats');
            res.status(500).json({ error: 'Could not read stats for that server' });
        }
    });

    // ── Message log ──
    app.get('/api/v1/servers/:id/logs', requireApiToken('read:logs'), (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'That server is not in the bot\'s list' });

        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_LOG_LIMIT, 1), MAX_LOG_LIMIT);
        const action = req.query.action ? String(req.query.action).slice(0, 32) : null;

        try {
            const db = require('../../db').getDb();
            const rows = action
                ? db.prepare('SELECT * FROM message_log WHERE guild_id = ? AND action = ? ORDER BY logged_at DESC LIMIT ?').all(guild.id, action, limit)
                : db.prepare('SELECT * FROM message_log WHERE guild_id = ? ORDER BY logged_at DESC LIMIT ?').all(guild.id, limit);

            res.json({
                entries: rows.map((row) => ({
                    id: row.id,
                    channelId: row.channel_id,
                    messageId: row.message_id,
                    authorId: row.author_id,
                    authorTag: row.author_tag,
                    content: typeof row.content === 'string' ? row.content.slice(0, MAX_CONTENT_CHARS) : null,
                    action: row.action,
                    loggedAt: row.logged_at,
                })),
                limit,
                action,
            });
        } catch (err) {
            logError(err, 'dashboard', 'api_logs');
            res.status(500).json({ error: 'Could not read the message log for that server' });
        }
    });
}

module.exports = { register, requireApiToken };

// ──────────────────── Ticket SLA tracking ────────────────────
// How long a member waits before a human answers their ticket.
//
// The number that matters is the *first staff response*: the first message in a
// ticket channel that is not from the member who opened it and not from a bot.
// It is stamped once and never overwritten — the UPDATE carries
// `WHERE first_response_at IS NULL`, so two staff replying at the same moment
// still produce one timestamp, and the second one changes nothing.
//
// Where the data comes from and goes:
//   • the message hook       src/events/messages.js calls noteTicketMessage()
//                            for every human message; it is a no-op for any
//                            channel that isn't an open ticket (one indexed
//                            lookup — see idx_tickets_channel in migration 0043)
//   • the alert sweeper      startTicketSlaSweeper() runs the same restart-safe
//                            shape as the temp-role and temp-ban sweepers: the
//                            state lives in the row (sla_alerted_at), so a boot
//                            sweep catches everything that came due while the
//                            bot was down, and a ticket is alerted exactly once
//   • the surfaces           getOpenTicketWaits() / getTicketSlaStats() feed the
//                            dashboard's Tickets screen and the ticket channel
//                            embeds; the config lives in guild_config
//                            .ticket_sla_config and is written through
//                            setTicketSlaConfig() so one validator serves the
//                            route, the command and any future caller
//
// An unconfigured guild is a working guild: the defaults (60-minute target,
// alert after 120) apply, and a guild that switches the feature off gets no
// alerts and no stamps beyond the two columns already being written.

const { getDb } = require('./db');
const { getGuildConfig, updateGuildConfig } = require('./config');
const { logError, logWarn } = require('./logError');
const { getTicketConfig, logTicketAction } = require('./tickets');

const DEFAULT_CONFIG = {
    enabled: true,
    firstResponseMinutes: 60,
    alertAfterMinutes: 120,
    alertChannelId: null,
};

const MIN_MINUTES = 1;
const MAX_MINUTES = 7 * 24 * 60; // a week
const MINUTE_MS = 60000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const SWEEP_BATCH = 25;
const DEFAULT_WINDOW_DAYS = 30;

// The alert colours match the ticket embeds (src/tickets.js TICKET_COLORS).
const ALERT_COLOR = 0xE74C3C;

let sweepInterval = null;

// ──────────────────── Config ────────────────────

function minutesToMs(minutes) {
    return Number.isInteger(minutes) && minutes >= MIN_MINUTES ? minutes * MINUTE_MS : null;
}

function isChannelId(value) {
    return typeof value === 'string' && /^\d{5,20}$/.test(value);
}

// Validates a patch coming from a surface (dashboard route, command, test).
// Returns { value } with only the keys it accepted, or { error } — the caller
// turns that into a 400 or a refusal message. Out-of-range and wrong-typed
// values are refused rather than clamped: silently rewriting "alert after 0
// minutes" to 1 would hide a UI bug behind a plausible number.
function validateTicketSlaPatch(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
        return { error: 'sla must be an object' };
    }
    const value = {};

    if (patch.enabled !== undefined) {
        if (typeof patch.enabled !== 'boolean') return { error: 'sla.enabled must be a boolean' };
        value.enabled = patch.enabled;
    }

    for (const key of ['firstResponseMinutes', 'alertAfterMinutes']) {
        if (patch[key] === undefined) continue;
        if (patch[key] === null || patch[key] === '') {
            value[key] = null;
            continue;
        }
        const n = Number(patch[key]);
        if (!Number.isInteger(n) || n < MIN_MINUTES || n > MAX_MINUTES) {
            return { error: 'sla.' + key + ' must be a whole number of minutes between ' + MIN_MINUTES + ' and ' + MAX_MINUTES + ', or null' };
        }
        value[key] = n;
    }

    if (patch.alertChannelId !== undefined) {
        if (patch.alertChannelId === null || patch.alertChannelId === '') {
            value.alertChannelId = null;
        } else if (!isChannelId(patch.alertChannelId)) {
            return { error: 'sla.alertChannelId must be a channel id, or null for the ticket log channel' };
        } else {
            value.alertChannelId = patch.alertChannelId;
        }
    }

    return { value };
}

// Whatever is in the column, made safe. A hand-edited row or a column written
// by an older version must not be able to crash a sweep or produce a nonsense
// threshold — anything unreadable falls back to the default.
function normalizeTicketSlaConfig(raw) {
    const cfg = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = { ...DEFAULT_CONFIG };
    if (typeof cfg.enabled === 'boolean') out.enabled = cfg.enabled;
    for (const key of ['firstResponseMinutes', 'alertAfterMinutes']) {
        if (cfg[key] === null) out[key] = null;
        else if (Number.isInteger(cfg[key]) && cfg[key] >= MIN_MINUTES && cfg[key] <= MAX_MINUTES) out[key] = cfg[key];
    }
    if (isChannelId(cfg.alertChannelId)) out.alertChannelId = cfg.alertChannelId;
    return out;
}

function getTicketSlaConfig(guildId) {
    if (!guildId) return { ...DEFAULT_CONFIG };
    try {
        return normalizeTicketSlaConfig(getGuildConfig(guildId).ticketSlaConfig);
    } catch (err) {
        // A config read must never break a message or a sweep.
        logError(err, 'ticketSla', 'config_read:' + guildId);
        return { ...DEFAULT_CONFIG };
    }
}

function setTicketSlaConfig(guildId, patch) {
    const checked = validateTicketSlaPatch(patch);
    if (checked.error) {
        const err = new Error(checked.error);
        err.validation = true;
        throw err;
    }
    const merged = normalizeTicketSlaConfig({ ...getTicketSlaConfig(guildId), ...checked.value });
    updateGuildConfig(guildId, (cfg) => {
        cfg.ticketSlaConfig = merged;
        return cfg;
    });
    return merged;
}

// ──────────────────── State per ticket ────────────────────

// The state a staff surface shows for one ticket:
//   waiting   — no response yet, still inside the target
//   overdue   — no response yet, past the target
//   met       — answered inside the target
//   late      — answered, but past the target
// `waitedMs` is always "how long the member has waited", which for an answered
// ticket is its response time.
function slaStateFor(ticket, config, now) {
    const targetMs = minutesToMs(config.firstResponseMinutes);
    const createdAt = Number(ticket.created_at) || 0;

    if (ticket.first_response_at) {
        const responseMs = Math.max(0, Number(ticket.first_response_at) - createdAt);
        const late = targetMs !== null && responseMs > targetMs;
        return {
            state: late ? 'late' : 'met',
            responded: true,
            responseMs,
            waitedMs: responseMs,
            targetMs,
            late,
        };
    }

    const waitedMs = Math.max(0, now - createdAt);
    const overdue = targetMs !== null && waitedMs > targetMs;
    return {
        state: overdue ? 'overdue' : 'waiting',
        responded: false,
        responseMs: null,
        waitedMs,
        targetMs,
        late: overdue,
    };
}

function mapWaitRow(row, config, now) {
    const state = slaStateFor(row, config, now);
    return {
        id: row.id,
        ticketNumber: row.ticket_number,
        channelId: row.channel_id,
        creatorId: row.creator_id,
        creatorTag: row.creator_tag,
        status: row.status,
        claimerId: row.claimer_id || null,
        panelTypeName: row.panel_type_name || null,
        createdAt: Number(row.created_at) || 0,
        firstResponseAt: row.first_response_at ? Number(row.first_response_at) : null,
        firstResponseBy: row.first_response_by || null,
        alertedAt: row.sla_alerted_at ? Number(row.sla_alerted_at) : null,
        state: state.state,
        responded: state.responded,
        responseMs: state.responseMs,
        waitedMs: state.waitedMs,
        targetMs: state.targetMs,
        late: state.late,
    };
}

// Every ticket that is still open or claimed, oldest first — the queue as the
// member experiences it.
function getOpenTicketWaits(guildId, options = {}) {
    if (!guildId) return [];
    const now = Number(options.now) || Date.now();
    const limit = Math.max(1, Math.min(Number(options.limit) || 100, 500));
    try {
        const config = getTicketSlaConfig(guildId);
        const rows = getDb().prepare(
            "SELECT * FROM tickets WHERE guild_id = ? AND status IN ('open','claimed') ORDER BY created_at ASC LIMIT ?"
        ).all(guildId, limit);
        return rows.map((row) => mapWaitRow(row, config, now));
    } catch (err) {
        logError(err, 'ticketSla', 'open_waits:' + guildId);
        return [];
    }
}

function median(sortedNumbers) {
    if (!sortedNumbers.length) return null;
    const mid = Math.floor(sortedNumbers.length / 2);
    return sortedNumbers.length % 2
        ? sortedNumbers[mid]
        : Math.round((sortedNumbers[mid - 1] + sortedNumbers[mid]) / 2);
}

// Response times and breach counts over a window, plus the live state of the
// open queue. Everything is derived from the ticket rows — no counters to drift.
function getTicketSlaStats(guildId, options = {}) {
    const now = Number(options.now) || Date.now();
    const days = Math.max(1, Math.min(Number(options.days) || DEFAULT_WINDOW_DAYS, 365));
    const config = getTicketSlaConfig(guildId);
    const targetMs = minutesToMs(config.firstResponseMinutes);

    const empty = {
        config,
        enabled: config.enabled,
        windowDays: days,
        targetMs,
        alertAfterMs: minutesToMs(config.alertAfterMinutes),
        generatedAt: now,
        responded: { count: 0, averageMs: null, medianMs: null, withinTarget: 0, late: 0, slowestMs: null },
        unanswered: { open: 0, oldestWaitMs: null, overTarget: 0 },
        breaches: { total: 0, respondedLate: 0, openOverdue: 0 },
        open: { total: 0, waiting: 0, overdue: 0, claimed: 0, averageWaitMs: null, oldestWaitMs: null },
    };
    if (!guildId) return empty;

    try {
        const db = getDb();
        const since = now - days * 24 * 60 * 60 * 1000;
        const rows = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND created_at >= ?')
            .all(guildId, since);

        const responseTimes = [];
        let late = 0;
        for (const row of rows) {
            if (!row.first_response_at) continue;
            const ms = Math.max(0, Number(row.first_response_at) - (Number(row.created_at) || 0));
            responseTimes.push(ms);
            if (targetMs !== null && ms > targetMs) late++;
        }
        responseTimes.sort((a, b) => a - b);

        const waits = getOpenTicketWaits(guildId, { now, limit: 500 });
        const openWaits = waits.map((w) => w.waitedMs).sort((a, b) => a - b);
        const openOverdue = waits.filter((w) => w.state === 'overdue').length;
        const openUnanswered = waits.filter((w) => !w.responded);

        return {
            config,
            enabled: config.enabled,
            windowDays: days,
            targetMs,
            alertAfterMs: minutesToMs(config.alertAfterMinutes),
            generatedAt: now,
            responded: {
                count: responseTimes.length,
                averageMs: responseTimes.length
                    ? Math.round(responseTimes.reduce((sum, ms) => sum + ms, 0) / responseTimes.length)
                    : null,
                medianMs: median(responseTimes),
                withinTarget: targetMs === null ? responseTimes.length : responseTimes.length - late,
                late,
                slowestMs: responseTimes.length ? responseTimes[responseTimes.length - 1] : null,
            },
            unanswered: {
                open: openUnanswered.length,
                oldestWaitMs: openUnanswered.length ? Math.max(...openUnanswered.map((w) => w.waitedMs)) : null,
                overTarget: openUnanswered.filter((w) => w.state === 'overdue').length,
            },
            breaches: {
                total: late + openOverdue,
                respondedLate: late,
                openOverdue,
            },
            open: {
                total: waits.length,
                waiting: waits.filter((w) => w.state === 'waiting').length,
                overdue: openOverdue,
                claimed: waits.filter((w) => w.status === 'claimed').length,
                averageWaitMs: openWaits.length
                    ? Math.round(openWaits.reduce((sum, ms) => sum + ms, 0) / openWaits.length)
                    : null,
                oldestWaitMs: openWaits.length ? openWaits[openWaits.length - 1] : null,
            },
        };
    } catch (err) {
        logError(err, 'ticketSla', 'stats:' + guildId);
        return empty;
    }
}

// ──────────────────── Stamping ────────────────────

// Called for every human message (src/events/messages.js). Returns null when
// the message is not a first response, or a small result object when it is —
// which is what the tests assert on.
//
// Everything that is not a real reply is refused here rather than upstream:
// the requester's own messages, bots and webhooks, Discord's own system
// messages (Nitro boosts, pins), tickets that are already answered or no
// longer open, and any channel that isn't a ticket at all.
function noteTicketMessage(message) {
    try {
        if (!message || !message.guild) return null;
        const author = message.author || {};
        if (author.bot) return null;
        if (message.system) return null;

        const channelId = message.channelId || (message.channel && message.channel.id);
        if (!channelId) return null;

        const db = getDb();
        const ticket = db.prepare(
            'SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ? ORDER BY created_at DESC LIMIT 1'
        ).get(channelId, message.guild.id);
        if (!ticket) return null;
        if (ticket.status !== 'open' && ticket.status !== 'claimed') return null;
        if (author.id && author.id === ticket.creator_id) return null;
        if (ticket.first_response_at) return { ticketId: ticket.id, stamped: false, reason: 'already-stamped' };

        const at = Number(message.createdTimestamp) || Date.now();
        const result = db.prepare(
            'UPDATE tickets SET first_response_at = ?, first_response_by = ? WHERE id = ? AND first_response_at IS NULL'
        ).run(at, author.id || null, ticket.id);

        // changes === 0 means another message won the race between the SELECT
        // and this UPDATE. Either way the first response stands.
        if (!result.changes) return { ticketId: ticket.id, stamped: false, reason: 'already-stamped' };
        return { ticketId: ticket.id, stamped: true, firstResponseAt: at, firstResponseBy: author.id || null };
    } catch (err) {
        logError(err, 'ticketSla', 'noteMessage');
        return null;
    }
}

// ──────────────────── Alerts ────────────────────

// Where an SLA alert goes: the configured channel, else the ticket log channel,
// else the guild's default log channel. Resolved per sweep so a deleted channel
// falls back instead of silently dropping the alert.
function resolveAlertChannelId(guild, config) {
    try {
        const channels = guild && guild.channels && guild.channels.cache;
        const exists = (id) => !!(id && channels && typeof channels.get === 'function' && channels.get(id));
        if (exists(config.alertChannelId)) return config.alertChannelId;
        const ticketConfig = getTicketConfig(guild.id);
        if (exists(ticketConfig.log_channel_id)) return ticketConfig.log_channel_id;
        const guildConfig = getGuildConfig(guild.id);
        if (exists(guildConfig.logChannelId)) return guildConfig.logChannelId;
        return null;
    } catch (err) {
        logError(err, 'ticketSla', 'resolve_channel:' + (guild && guild.id));
        return null;
    }
}

// Returns true only when the alert actually reached a channel — the caller
// marks the ticket alerted on true, so a missing channel means the ticket is
// retried on the next sweep rather than silently written off.
async function alertUnansweredTicket(guild, ticket, config, now, sendFn) {
    const channelId = resolveAlertChannelId(guild, config);
    if (!channelId) return false;

    const state = slaStateFor(ticket, config, now);
    const waitedMinutes = Math.round(state.waitedMs / MINUTE_MS);
    const fields = {
        'Ticket #': '#' + ticket.ticket_number,
        'Creator': ticket.creator_tag || ('<' + ticket.creator_id + '>'),
        'Waiting': waitedMinutes + ' min',
        'Target': config.firstResponseMinutes ? config.firstResponseMinutes + ' min' : 'not set',
        'Channel': '<#' + ticket.channel_id + '>',
    };
    if (ticket.claimer_id) fields['Claimed By'] = '<@' + ticket.claimer_id + '>';

    const send = sendFn || logTicketAction;
    return !!(await send(guild, '⏰ Ticket unanswered — SLA breach', ALERT_COLOR, fields, channelId));
}

// One pass over every guild. Restart-safe by construction: the set of tickets
// to alert is a query, and `sla_alerted_at` is what stops a second pass from
// repeating it.
// Takes the client explicitly — the interval in startTicketSlaSweeper passes
// the one it captured, so there is no hidden module-level fallback that could
// sweep with a stale client after a restart in-process (which is exactly what
// tests exercise). A call without a client is an honest no-op.
async function sweepTicketSla(discordClient, options = {}) {
    const active = discordClient;
    if (!active || !active.guilds || !active.guilds.cache) return { guilds: 0, due: 0, alerted: 0, failed: 0 };

    const now = Number(options.now) || Date.now();
    const sendFn = options.sendFn || null;
    let guilds = 0;
    let due = 0;
    let alerted = 0;
    let failed = 0;

    for (const guild of active.guilds.cache.values()) {
        guilds++;
        try {
            const config = getTicketSlaConfig(guild.id);
            if (!config.enabled) continue;
            const alertAfterMs = minutesToMs(config.alertAfterMinutes);
            if (alertAfterMs === null) continue;

            const db = getDb();
            const rows = db.prepare(
                "SELECT * FROM tickets WHERE guild_id = ? AND status IN ('open','claimed') " +
                'AND first_response_at IS NULL AND sla_alerted_at IS NULL AND created_at <= ? ' +
                'ORDER BY created_at ASC LIMIT ?'
            ).all(guild.id, now - alertAfterMs, SWEEP_BATCH);

            for (const ticket of rows) {
                due++;
                const sent = await alertUnansweredTicket(guild, ticket, config, now, sendFn);
                if (!sent) {
                    failed++;
                    continue;
                }
                db.prepare('UPDATE tickets SET sla_alerted_at = ? WHERE id = ? AND sla_alerted_at IS NULL')
                    .run(now, ticket.id);
                alerted++;
            }
        } catch (err) {
            logError(err, 'ticketSla', 'sweep:' + (guild && guild.id));
        }
    }

    if (failed) {
        // One line per sweep rather than one per ticket: a deleted alert
        // channel is a setup problem, not a per-ticket incident.
        logWarn('some ticket SLA alerts could not be posted', 'ticketSla', 'count=' + failed);
    }
    return { guilds, due, alerted, failed };
}

// Boot sweep first (the bot may have been offline past a threshold), then the
// interval — the same shape as the temp-role and temp-ban sweepers, and the
// interval never keeps the process alive. The client is captured in the closure
// rather than held in a module variable, so starting a second sweeper (a
// restart in-process, or a test) cannot leave the old interval pointed at the
// old client.
function startTicketSlaSweeper(discordClient) {
    if (sweepInterval) clearInterval(sweepInterval);
    sweepTicketSla(discordClient).catch((err) => logError(err, 'ticketSla', 'sweep_boot'));
    sweepInterval = setInterval(() => {
        sweepTicketSla(discordClient).catch((err) => logError(err, 'ticketSla', 'sweep'));
    }, SWEEP_INTERVAL_MS);
    if (sweepInterval.unref) sweepInterval.unref();
}

function stopTicketSlaSweeper() {
    if (sweepInterval) clearInterval(sweepInterval);
    sweepInterval = null;
}

module.exports = {
    DEFAULT_CONFIG,
    MIN_MINUTES,
    MAX_MINUTES,
    SWEEP_INTERVAL_MS,
    minutesToMs,
    validateTicketSlaPatch,
    normalizeTicketSlaConfig,
    getTicketSlaConfig,
    setTicketSlaConfig,
    slaStateFor,
    getOpenTicketWaits,
    getTicketSlaStats,
    noteTicketMessage,
    resolveAlertChannelId,
    alertUnansweredTicket,
    sweepTicketSla,
    startTicketSlaSweeper,
    stopTicketSlaSweeper,
};

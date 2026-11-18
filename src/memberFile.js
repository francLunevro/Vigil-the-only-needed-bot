// ──────────────────── Member file ────────────────────
// One staff-only view of everything the bot knows about a member in a guild:
// warnings, mod cases (the punishments), staff notes, reports filed against
// them, ban appeals and ticket history.
//
// This module owns no SQL and no tables. Every fact comes from the module that
// already owns its table —
//
//   warnings      src/warnings.js    getWarnings()
//   cases         src/modCases.js    getCases() / getUserCaseCount()
//   notes         src/staffNotes.js  getNotesForUser()
//   reports       src/reports.js     getReportsForTarget()
//   appeals       src/banAppeals.js  getBanAppealsForUser()
//   tickets       src/tickets.js     getTicketsForUser()
//   temp bans     src/tempBans.js    getActiveTempBan()
//
// — so a column rename happens in one place, and every read is already scoped
// by `guild_id = ?`. That scoping is the whole isolation story: ask for a
// member id that belongs to another server, in this server, and each source
// matches nothing. There is no cross-guild fallback anywhere in here.
//
// One broken source must not blank the file the way one broken table would:
// each source is read through read(), which logs the failure (logError, so it
// reaches the dashboard error log) and substitutes an empty list. The result is
// marked in `errors` so a caller can say "this section is missing" instead of
// quietly rendering an incomplete file as if it were complete.
//
// Two numbers, deliberately: `summaries` reports true totals (COUNT-backed where
// the source has one), while `timeline`/`sections` carry at most `limit` rows
// per source. A member with 300 warnings shows "300" and the 25 newest.

const { logError } = require('./logError');
const { getWarnings } = require('./warnings');
const { getCases, getUserCaseCount } = require('./modCases');
const { getNotesForUser } = require('./staffNotes');
const { getReportsForTarget } = require('./reports');
const { getBanAppealsForUser } = require('./banAppeals');
const { getTicketsForUser } = require('./tickets');
const { getActiveTempBan } = require('./tempBans');

const DEFAULT_LIMIT = 25;
const DEFAULT_TIMELINE_LIMIT = 60;

// Emoji per case action, matching /history and /case so the same action reads
// the same way wherever staff see it.
const CASE_EMOJI = {
    warn: '⚠️',
    kick: '👢',
    ban: '🔨',
    unban: '🔓',
    tempban: '🔨',
    timeout: '⏱️',
    untimeout: '▶️',
    lock: '🔒',
    unlock: '🔓',
    purge: '🧹',
};

// Kinds, in the order the file lists them when two entries share a timestamp.
// Fixed so the timeline is stable between reads rather than at the mercy of
// map iteration.
const KIND_RANK = {
    case: 0,
    warning: 1,
    tempban: 2,
    note: 3,
    report: 4,
    appeal: 5,
    ticket: 6,
};

function toMs(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
}

// Every source read goes through here: a throw becomes an empty list plus a
// logged error and a note in `errors`, never a failed member file.
function read(errors, name, fn) {
    try {
        const value = fn();
        return value === undefined ? [] : value;
    } catch (err) {
        logError(err, 'memberFile', name);
        errors.push(name);
        return [];
    }
}

function countBy(values) {
    const out = {};
    for (const value of values) {
        const key = value || 'unknown';
        out[key] = (out[key] || 0) + 1;
    }
    return out;
}

// ──────────────────── Sections ────────────────────
// Normalized per system. The warning and case shapes are the ones the
// dashboard's member profile already sends (it renders them, and the vanilla
// frontend does too), so this is the single place that mapping lives.

function mapWarnings(rows) {
    return rows.map((w) => ({
        id: w.id,
        reason: w.reason,
        moderator: w.moderator,
        date: w.date,
        at: toMs(w.date),
    }));
}

function mapCases(rows) {
    return rows.map((c) => ({
        caseNumber: c.case_number,
        actionType: c.action_type,
        reason: c.reason,
        moderatorTag: c.moderator_tag,
        active: !!c.active,
        createdAt: c.created_at,
        at: toMs(c.created_at),
    }));
}

function mapNotes(rows) {
    return rows.map((n) => ({
        id: n.id,
        note: n.note,
        authorTag: n.author_tag,
        createdAt: n.created_at,
        updatedAt: n.updated_at || null,
        at: toMs(n.created_at),
    }));
}

function mapReports(rows) {
    return rows.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        reporterTag: r.reporter_tag,
        reviewedBy: r.reviewed_by || null,
        reviewedAt: r.reviewed_at || null,
        reviewNote: r.review_note || null,
        messageContent: r.message_content || null,
        createdAt: r.created_at,
        at: toMs(r.created_at),
    }));
}

function mapAppeals(rows) {
    return rows.map((a) => ({
        id: a.id,
        status: a.status,
        reason: a.reason,
        message: a.message,
        reviewedBy: a.reviewed_by || null,
        reviewedAt: a.reviewed_at || null,
        reviewNote: a.review_note || null,
        createdAt: a.created_at,
        at: toMs(a.created_at),
    }));
}

function mapTickets(rows) {
    return rows.map((t) => ({
        id: t.id,
        ticketNumber: t.ticket_number,
        status: t.status,
        typeName: t.panel_type_name || null,
        reason: t.reason || null,
        claimerId: t.claimer_id || null,
        closedById: t.closed_by_id || null,
        closedReason: t.closed_reason || null,
        createdAt: t.created_at,
        closedAt: t.closed_at || null,
        lastActivityAt: t.last_activity_at || null,
        at: toMs(t.created_at),
    }));
}

// ──────────────────── Timeline ────────────────────

// One row per event, newest first. `at` is epoch milliseconds (0 when a source
// stored something unparseable) and `detail` is the shortest true description —
// the caller decides how to truncate, because the embed and the dashboard have
// different budgets.
function buildTimeline(sections) {
    const entries = [];

    for (const c of sections.cases) {
        entries.push({
            kind: 'case',
            at: c.at,
            id: '#case-' + c.caseNumber,
            caseNumber: c.caseNumber,
            title: (CASE_EMOJI[c.actionType] ? CASE_EMOJI[c.actionType] + ' ' : '') + c.actionType + ' case #' + c.caseNumber,
            detail: c.reason || 'No reason provided',
            actor: c.moderatorTag || null,
            active: c.active,
        });
    }
    for (const w of sections.warnings) {
        entries.push({
            kind: 'warning',
            at: w.at,
            id: w.id,
            title: 'Warning',
            detail: w.reason || 'No reason provided',
            actor: w.moderator || null,
            active: false,
        });
    }
    for (const n of sections.notes) {
        entries.push({
            kind: 'note',
            at: n.at,
            id: n.id,
            title: 'Staff note',
            detail: n.note || '',
            actor: n.authorTag || null,
            active: false,
            edited: !!n.updatedAt,
        });
    }
    for (const r of sections.reports) {
        entries.push({
            kind: 'report',
            at: r.at,
            id: r.id,
            title: 'Report — ' + r.status,
            detail: r.reason || 'No reason provided',
            actor: r.reporterTag || null,
            active: r.status === 'pending',
        });
    }
    for (const a of sections.appeals) {
        entries.push({
            kind: 'appeal',
            at: a.at,
            id: a.id,
            title: 'Ban appeal — ' + a.status,
            detail: a.reason || a.message || '',
            actor: a.reviewedBy || null,
            active: a.status === 'pending',
        });
    }
    for (const t of sections.tickets) {
        entries.push({
            kind: 'ticket',
            at: t.at,
            id: t.id,
            title: 'Ticket #' + t.ticketNumber + (t.typeName ? ' (' + t.typeName + ')' : ''),
            detail: t.reason || t.typeName || 'Support ticket',
            actor: t.claimerId || null,
            active: t.status === 'open' || t.status === 'claimed',
        });
    }
    for (const tb of sections.tempBan ? [sections.tempBan] : []) {
        entries.push({
            kind: 'tempban',
            at: tb.at,
            id: 'tempban-' + tb.userId,
            title: 'Temporary ban',
            detail: tb.reason || 'No reason provided',
            actor: null,
            active: !tb.expired,
        });
    }

    return entries.sort((a, b) => {
        if (b.at !== a.at) return b.at - a.at;
        const rank = (KIND_RANK[a.kind] || 0) - (KIND_RANK[b.kind] || 0);
        if (rank !== 0) return rank;
        // Same kind and same timestamp: order by id so two identical reads can
        // never disagree about the order.
        return String(a.id).localeCompare(String(b.id));
    });
}

// ──────────────────── Summaries ────────────────────

// Cases still in force: an active case row (ban / tempban / timeout that hasn't
// been lifted) plus a temp ban row that the sweeper hasn't reached yet. A live
// temp ban and its case are the same punishment, so the case wins and the temp
// ban row only adds its exact expiry.
function activePunishments(sections) {
    const out = [];
    for (const c of sections.cases) {
        if (!c.active) continue;
        if (c.actionType === 'purge' || c.actionType === 'lock') continue;
        out.push({
            type: c.actionType,
            caseNumber: c.caseNumber,
            since: c.createdAt,
            reason: c.reason || null,
            until: null,
        });
    }
    const tb = sections.tempBan;
    if (tb && !tb.expired) {
        const match = out.find((p) => p.type === 'tempban' || p.type === 'ban');
        if (match) match.until = tb.until;
        else {
            out.push({
                type: 'tempban',
                caseNumber: null,
                since: tb.bannedAt,
                reason: tb.reason || null,
                until: tb.until,
            });
        }
    }
    return out;
}

function buildSummaries(sections, caseTotal) {
    const lastAt = (rows) => (rows.length ? rows[0].at : null);
    const actions = countBy(sections.cases.map((c) => c.actionType));

    return {
        warnings: { total: sections.warnings.length, latestAt: lastAt(sections.warnings) },
        // Total comes from COUNT(*), not from the capped list, so a long record
        // is honest about its length.
        cases: {
            total: caseTotal,
            loaded: sections.cases.length,
            active: sections.cases.filter((c) => c.active).length,
            byAction: actions,
        },
        notes: { total: sections.notes.length, latestAt: lastAt(sections.notes) },
        reports: {
            total: sections.reports.length,
            pending: sections.reports.filter((r) => r.status === 'pending').length,
        },
        appeals: {
            total: sections.appeals.length,
            pending: sections.appeals.filter((a) => a.status === 'pending').length,
        },
        tickets: {
            total: sections.tickets.length,
            open: sections.tickets.filter((t) => t.status === 'open' || t.status === 'claimed').length,
        },
    };
}

// ──────────────────── Entry point ────────────────────

// options:
//   limit          — most rows read per source (default 25, capped at 100 by
//                    the accessors themselves)
//   timelineLimit  — most merged timeline entries returned (default 60)
//   now            — clock override for tests
//
// Returns { guildId, userId, timeline, sections, summaries, activePunishments,
// errors, truncated }. Missing ids return the empty file rather than throwing,
// so a caller with a half-built request can render "nothing on file" instead of
// crashing.
function getMemberFile(guildId, userId, options = {}) {
    const limit = Math.max(1, Math.min(Number(options.limit) || DEFAULT_LIMIT, 100));
    const timelineLimit = Math.max(1, Math.min(Number(options.timelineLimit) || DEFAULT_TIMELINE_LIMIT, 500));
    const errors = [];

    const empty = {
        guildId: guildId || null,
        userId: userId || null,
        timeline: [],
        sections: { warnings: [], cases: [], notes: [], reports: [], appeals: [], tickets: [], tempBan: null },
        summaries: buildSummaries({ warnings: [], cases: [], notes: [], reports: [], appeals: [], tickets: [], tempBan: null }, 0),
        activePunishments: [],
        errors: [],
        truncated: false,
    };
    if (!guildId || !userId) return empty;

    const gid = String(guildId);
    const uid = String(userId);

    // Each capped source is read one row past the cap. That extra row is the
    // only honest way to answer "is anything hidden?" without a second COUNT
    // query — and it is dropped before it reaches the file, so the lists callers
    // see are exactly `limit` rows long.
    const probe = limit + 1;
    const overflow = {};
    function capped(name, fetch) {
        const rows = read(errors, name, fetch);
        if (rows.length > limit) overflow[name] = true;
        return rows.slice(0, limit);
    }

    const sections = {
        warnings: mapWarnings(read(errors, 'warnings', () => getWarnings(gid, uid))),
        cases: mapCases(capped('cases', () => getCases(gid, uid, probe))),
        notes: mapNotes(read(errors, 'notes', () => getNotesForUser(gid, uid))),
        reports: mapReports(capped('reports', () => getReportsForTarget(gid, uid, probe))),
        appeals: mapAppeals(capped('appeals', () => getBanAppealsForUser(gid, uid, probe))),
        tickets: mapTickets(capped('tickets', () => getTicketsForUser(gid, uid, probe))),
        tempBan: null,
    };

    // A temp ban is a single row, not a list, so it is read separately.
    const tempBan = read(errors, 'tempBans', () => {
        const row = getActiveTempBan(gid, uid);
        if (!row) return null;
        const expired = Number(row.unban_at) <= Number(options.now || Date.now());
        return {
            userId: row.user_id,
            reason: row.reason || null,
            bannedAt: row.banned_at,
            until: row.unban_at,
            expired,
            at: toMs(row.banned_at),
        };
    });
    // read() answers [] for a failed source; a temp ban is a row-or-nothing, so
    // an array here means "that read failed", not "a ban that is an array".
    sections.tempBan = Array.isArray(tempBan) ? null : tempBan;

    const caseCount = read(errors, 'caseCount', () => getUserCaseCount(gid, uid));
    const caseTotal = typeof caseCount === 'number' && Number.isFinite(caseCount) ? caseCount : 0;

    const timeline = buildTimeline(sections);
    const active = activePunishments(sections);

    return {
        guildId: gid,
        userId: uid,
        timeline: timeline.slice(0, timelineLimit),
        sections,
        summaries: buildSummaries(sections, caseTotal),
        activePunishments: active,
        errors,
        // True when a cap actually hid something, so a surface can say "showing
        // the newest N" instead of implying it has everything. A member with
        // exactly `limit` rows of history is complete, not truncated.
        truncated: timeline.length > timelineLimit
            || Object.keys(overflow).length > 0
            || caseTotal > sections.cases.length,
    };
}

module.exports = {
    getMemberFile,
    CASE_EMOJI,
    DEFAULT_LIMIT,
    DEFAULT_TIMELINE_LIMIT,
};

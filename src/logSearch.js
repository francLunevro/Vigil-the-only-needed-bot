// ──────────────────── Message-log search ────────────────────
// The engine behind /logs search. It lives apart from the command handler so
// the parsing, the SQL and the paging session can be tested without Discord.
//
// What the first version got wrong, and what each guard here fixes:
//   • the whole `keyword` went into ONE LIKE pattern, so "reply ping" matched
//     only where the two words sat next to each other in that exact order —
//     a second word usually turned a working search into zero results
//   • `%` and `_` in a query were live LIKE wildcards, so "%" matched every row
//   • nothing escaped the escape character, so a trailing backslash misparsed
//   • every result went into one 4096-character description, so anything past
//     the limit disappeared with the count still saying otherwise
//   • no paging: `limit` was both "how many to search" and "how many to show"

const crypto = require('crypto');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getDb } = require('./db');
const { truncate } = require('./helpers');

// ── Caps. Every one of these exists so a hostile or careless query can't make
// the bot read an unbounded amount of work into memory. ──
const MAX_QUERY_LENGTH = 200;   // characters of user input
const MAX_TERMS = 8;            // words/phrases per search
const MAX_RESULTS = 200;        // hard ceiling on rows held in a session
const DEFAULT_RESULTS = 50;     // when `limit` is omitted
const PAGE_SIZE = 5;            // log entries per embed/page
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 200;       // live pagination sessions before the oldest is dropped

const ACTIONS = ['deleted', 'edited'];
const LIKE_ESCAPE = '\\';

// Discord's own embed ceilings, minus the room `truncate` needs for its "...".
const FIELD_NAME_MAX = 256;
const FIELD_VALUE_MAX = 1024;
// The filter line is short by construction (ids, one action, one query); the
// cap is only there so a pathological query can't push the embed over.
const FILTERS_MAX = 600;

// ──────────────────── Query parsing ────────────────────

// Splits on whitespace, except inside "double quotes" — a quoted run is one
// term that has to match contiguously. An unclosed quote still searches the
// text typed after it rather than throwing the whole query away.
function tokenizeQuery(text) {
    const terms = [];
    let buf = '';
    let inQuotes = false;

    const flush = (phrase) => {
        const value = buf.trim();
        buf = '';
        if (value) terms.push({ value, phrase: !!phrase });
    };

    for (const ch of text) {
        if (ch === '"') {
            if (inQuotes) { flush(true); inQuotes = false; }
            else { flush(false); inQuotes = true; }
            continue;
        }
        if (!inQuotes && /\s/.test(ch)) { flush(false); continue; }
        buf += ch;
    }
    flush(inQuotes);
    return terms;
}

// Sentence punctuation at the end of a bare word is noise: people type
// "spamming!" meaning "spamming". Only trailing marks are trimmed, so ".env"
// and "50%" keep the characters that are part of the thing being searched for.
const TRAILING_PUNCTUATION = /[.,!?;:]+$/;

function normalizeTerm(value) {
    const trimmed = String(value).replace(TRAILING_PUNCTUATION, '');
    return trimmed.length > 0 ? trimmed : String(value);
}

// Returns { terms, text } on success, { error } when the query is too big.
// An empty (or whitespace-only) query is valid: it means "newest entries".
function parseSearchQuery(raw) {
    const text = String(raw ?? '').trim();
    if (text.length > MAX_QUERY_LENGTH) {
        return { error: 'That query is too long (' + text.length + ' characters). Keep it under ' + MAX_QUERY_LENGTH + '.' };
    }

    const terms = [];
    const seen = new Set();
    for (const term of tokenizeQuery(text)) {
        const value = term.phrase ? term.value : normalizeTerm(term.value);
        if (!value) continue;
        const key = value.toLowerCase();
        if (seen.has(key)) continue; // the same word twice is one condition
        seen.add(key);
        terms.push({ value, phrase: term.phrase });
    }

    if (terms.length > MAX_TERMS) {
        return { error: 'Too many keywords (' + terms.length + '). Use at most ' + MAX_TERMS + ' — wrap the words you want kept together in `"double quotes"`.' };
    }
    return { terms, text, empty: terms.length === 0 };
}

// ──────────────────── SQL ────────────────────

// A user's `%` or `_` is text, not a pattern. Without this, "%" matched every
// row in the table and "_" matched any single character.
function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, (ch) => LIKE_ESCAPE + ch);
}

// Builds a fully parameterized WHERE clause. Every value is bound, so a query
// containing SQL is searched for as text and can never alter the statement.
function buildWhere({ guildId, terms = [], userId = null, channelId = null, action = null }) {
    const clauses = ['guild_id = ?'];
    const params = [guildId];

    if (userId) { clauses.push('author_id = ?'); params.push(String(userId)); }
    if (channelId) { clauses.push('channel_id = ?'); params.push(String(channelId)); }
    if (action) { clauses.push('action = ?'); params.push(String(action)); }

    for (const term of terms) {
        const pattern = '%' + escapeLike(term.value) + '%';
        // Every term must appear somewhere in the row (AND of ORs), and it may
        // land in the message text, the author's tag or an attachment name.
        clauses.push("(content LIKE ? ESCAPE '\\' OR author_tag LIKE ? ESCAPE '\\' OR attachments LIKE ? ESCAPE '\\')");
        params.push(pattern, pattern, pattern);
    }

    return { where: clauses.join(' AND '), params };
}

function clampLimit(value) {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_RESULTS;
    return Math.min(n, MAX_RESULTS);
}

// Runs the count + the page of rows in one call. `total` is the real number of
// matches, so the footer can be honest about a truncated search instead of
// silently showing fewer than the user asked for.
function searchMessageLog(options) {
    const {
        guildId, terms = [], userId = null, channelId = null,
        action = null, limit = DEFAULT_RESULTS,
    } = options;
    const db = options.db || getDb();
    const cappedLimit = clampLimit(limit);
    const { where, params } = buildWhere({ guildId, terms, userId, channelId, action });

    const total = db.prepare('SELECT COUNT(*) AS n FROM message_log WHERE ' + where).get(...params).n;
    // id DESC breaks ties when a burst of events shares one millisecond, so a
    // page boundary can't repeat or skip a row.
    const rows = db.prepare('SELECT * FROM message_log WHERE ' + where + ' ORDER BY logged_at DESC, id DESC LIMIT ?')
        .all(...params, cappedLimit);

    return { rows, total, limit: cappedLimit, truncated: total > rows.length };
}

// ──────────────────── Pagination sessions ────────────────────
// Results are kept in memory between button clicks so paging never re-runs the
// query. The store is bounded twice (TTL and a hard session cap) because these
// live in a long-running process.

const sessions = new Map();

function sweepSessions(now = Date.now()) {
    for (const [id, session] of sessions) {
        if (session.expiresAt <= now) sessions.delete(id);
    }
}

function createSession(data) {
    const now = Date.now();
    sweepSessions(now);
    while (sessions.size >= MAX_SESSIONS) {
        // Map iteration is insertion-ordered, so the first key is the oldest.
        const oldest = sessions.keys().next().value;
        if (oldest === undefined) break;
        sessions.delete(oldest);
    }
    const session = {
        // Hex, not base64url: the button custom id is parsed by splitting on
        // '_', and '_' is part of the base64url alphabet.
        id: crypto.randomBytes(6).toString('hex'),
        pageSize: PAGE_SIZE,
        createdAt: now,
        expiresAt: now + SESSION_TTL_MS,
        ...data,
    };
    sessions.set(session.id, session);
    return session;
}

// A session belongs to exactly one user in one guild. Both are checked here as
// well as in the button router: the id is unguessable, but a leaked id alone
// must not be enough to read someone else's search.
function getSession(id, { userId, guildId } = {}) {
    const session = sessions.get(String(id || ''));
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
        sessions.delete(session.id);
        return null;
    }
    if (userId !== undefined && session.userId !== userId) return null;
    if (guildId !== undefined && session.guildId !== guildId) return null;
    return session;
}

function destroySession(id) {
    return sessions.delete(String(id || ''));
}

function sessionCount() {
    return sessions.size;
}

// Test seam: module state would otherwise leak between tests in one process.
function clearSessions() {
    sessions.clear();
}

// ──────────────────── Rendering ────────────────────

function pageCount(session) {
    const perPage = session.pageSize || PAGE_SIZE;
    return Math.max(1, Math.ceil(session.rows.length / perPage));
}

function clampPage(session, page) {
    const n = Number.parseInt(page, 10);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, pageCount(session) - 1);
}

// One embed field per log entry: it keeps every entry self-contained and stays
// inside the embed ceilings (a single description silently dropped the tail).
function entryField(row) {
    const action = String(row.action || 'logged');
    const emoji = action === 'deleted' ? '🗑️' : (action === 'edited' ? '✏️' : '📝');
    const label = action.charAt(0).toUpperCase() + action.slice(1);
    const when = row.logged_at ? '<t:' + Math.floor(row.logged_at / 1000) + ':R>' : 'unknown time';

    const actor = row.author_id
        ? '<@' + row.author_id + '>' + (row.author_tag ? ' (@' + row.author_tag + ')' : '')
        : (row.author_tag || 'unknown author');

    const meta = [actor];
    if (row.channel_id) meta.push('<#' + row.channel_id + '>');
    if (row.message_id) meta.push('msg `' + row.message_id + '`');

    const attachments = attachmentNames(row);
    const lines = ['> ' + (collapseWhitespace(row.content) || '*[no text]*'), meta.join(' · ')];
    if (attachments.length > 0) lines.push('📎 ' + truncate(attachments.join(', '), 200));

    return {
        name: truncate(emoji + ' ' + label + ' · ' + when, FIELD_NAME_MAX),
        value: truncate(lines.join('\n'), FIELD_VALUE_MAX),
    };
}

// Log content is raw multi-line text. A blockquote in an embed field only
// quotes its first line, so the snippet is flattened to one readable line.
function collapseWhitespace(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\s+/g, ' ').trim();
}

// Attachments are stored as JSON; a malformed row must not break the page.
function attachmentNames(row) {
    if (!row.attachments) return [];
    try {
        const parsed = JSON.parse(row.attachments);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((a) => (a && typeof a === 'object' ? (a.name || a.url) : a))
            .filter((name) => typeof name === 'string' && name.length > 0);
    } catch {
        return [];
    }
}

// "Nothing matched" has to be as informative as a match — it's where people
// find out their filter was the problem. Ids are whatever was actually applied.
function describeFilters({ userId = null, channelId = null, action = null, query = null } = {}) {
    const parts = [];
    if (userId) parts.push('user <@' + userId + '>');
    if (channelId) parts.push('channel <#' + channelId + '>');
    if (action) parts.push('action `' + action + '`');
    if (query) {
        const text = String(query).replace(/`/g, '\u2019').slice(0, MAX_QUERY_LENGTH);
        parts.push('query `' + text + '`');
    }
    if (parts.length === 0) return 'No filters — newest entries first.';
    return 'Filters: ' + parts.join(' · ');
}

function pageButtonId(session, page) {
    return 'ls_' + session.userId + '_' + session.id + '_' + clampPage(session, page);
}

function closeButtonId(session) {
    return 'ls_' + session.userId + '_' + session.id + '_close';
}

function buildPageComponents(session, page) {
    const pages = pageCount(session);
    const atStart = page <= 0;
    const atEnd = page >= pages - 1;

    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(pageButtonId(session, page - 1))
            .setLabel('Previous')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(atStart),
        new ButtonBuilder()
            .setCustomId(pageButtonId(session, page))
            .setLabel('Page ' + (page + 1) + '/' + pages)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true),
        new ButtonBuilder()
            .setCustomId(pageButtonId(session, page + 1))
            .setLabel('Next')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(atEnd),
        new ButtonBuilder()
            .setCustomId(closeButtonId(session))
            .setLabel('Close')
            .setStyle(ButtonStyle.Danger),
    )];
}

// The payload for one page, shared by the first reply and every button click,
// so paging renders the same thing as the search that started it.
function renderSearchPage(session, requestedPage) {
    const page = clampPage(session, requestedPage);
    const pages = pageCount(session);
    const start = page * (session.pageSize || PAGE_SIZE);
    const slice = session.rows.slice(start, start + (session.pageSize || PAGE_SIZE));

    const matches = session.total === 1 ? '1 match' : session.total + ' matches';
    // When `limit` cut the search short the footer says so, instead of letting
    // the page count imply that the extra matches don't exist.
    const count = session.truncated
        ? 'newest ' + session.rows.length + ' of ' + matches
        : matches;

    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📋 Log Search Results')
        .setFields(slice.map(entryField))
        .setFooter({ text: 'Page ' + (page + 1) + '/' + pages + ' · ' + count });

    if (session.guildName) {
        embed.setAuthor({
            name: session.guildName,
            ...(session.guildIcon ? { iconURL: session.guildIcon } : {}),
        });
    }
    if (session.filtersLabel) {
        embed.setDescription(truncate(session.filtersLabel, FILTERS_MAX));
    }

    return { embeds: [embed], components: buildPageComponents(session, page) };
}

module.exports = {
    // caps
    MAX_QUERY_LENGTH,
    MAX_TERMS,
    MAX_RESULTS,
    DEFAULT_RESULTS,
    PAGE_SIZE,
    SESSION_TTL_MS,
    MAX_SESSIONS,
    ACTIONS,
    // query + SQL
    tokenizeQuery,
    parseSearchQuery,
    escapeLike,
    buildWhere,
    clampLimit,
    searchMessageLog,
    // sessions
    createSession,
    getSession,
    destroySession,
    sessionCount,
    clearSessions,
    // render
    pageCount,
    clampPage,
    buildPageComponents,
    pageButtonId,
    closeButtonId,
    describeFilters,
    renderSearchPage,
};

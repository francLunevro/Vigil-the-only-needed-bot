// Tests for /logs search — the parsing, the SQL and the pagination session in
// src/logSearch, the command in src/commands/logs, and the button handler that
// pages through results.
//
// The behaviours pinned here are the ones the first implementation got wrong:
// a multi-word query only matched words that were adjacent and in order, `%`
// and `_` typed into the box were live wildcards, every result was crammed into
// one description that silently dropped the tail, and there was no paging at
// all. The rest is the security surface the buttons added: a search belongs to
// one user in one server, and a session id is not a key to someone else's rows.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-search-test-'));
process.env.DATA_DIR = tmp;

const { getDb, closeDb } = require('../src/db');
const logSearch = require('../src/logSearch');
const { executeLogs } = require('../src/commands/logs');
const { handleInteraction } = require('../src/interactions');
const { handleLogSearchButton } = require('../src/interactions/logSearch');
const { publicCommands } = require('../src/commands/registry');
const { permissionFor } = require('../src/commandPolicy');
const { buildPrefixInteraction } = require('../src/prefixAdapter');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
    logSearch.clearSessions();
    getDb().prepare('DELETE FROM message_log').run();
});

// ──────────────────── Seeding ────────────────────

let seq = 0;
function seed({
    guildId = 'g1', content = '', authorId = 'author1', authorTag = 'Author#0001',
    channelId = 'chan1', action = 'deleted', attachments = null, at = Date.now(),
} = {}) {
    seq += 1;
    getDb().prepare('INSERT INTO message_log (guild_id, channel_id, message_id, author_id, author_tag, content, action, attachments, logged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(guildId, channelId, 'msg-' + seq, authorId, authorTag, content, action, attachments, at);
}

function contentsOf({ guildId = 'g1', query, ...rest }) {
    const parsed = logSearch.parseSearchQuery(query);
    assert.strictEqual(parsed.error, undefined, 'query should parse');
    return logSearch.searchMessageLog({ guildId, terms: parsed.terms, ...rest }).rows.map(r => r.content);
}

// ──────────────────── Fakes ────────────────────

const GUILD = { id: 'g1', name: 'Test Guild', iconURL: () => null };
const OTHER_GUILD = { id: 'g2', name: 'Other Guild', iconURL: () => null };

function makeCommandInteraction({ query = null, user = null, channel = null, action = null, limit = null, guild = GUILD, userId = 'owner1' } = {}) {
    const calls = { reply: [], editReply: [] };
    return {
        commandName: 'logs',
        guild,
        user: { id: userId, tag: 'Owner#0001' },
        options: {
            getSubcommand: () => 'search',
            getString: (n) => (n === 'query' ? query : (n === 'action' ? action : null)),
            getUser: (n) => (n === 'user' ? user : null),
            getChannel: (n) => (n === 'channel' ? channel : null),
            getInteger: (n) => (n === 'limit' ? limit : null),
        },
        reply: async (o) => { calls.reply.push(o); },
        editReply: async (o) => { calls.editReply.push(o); },
        __calls: calls,
    };
}

function makeButtonInteraction({ customId, userId = 'owner1', guild = GUILD }) {
    const calls = { update: [], reply: [], followUp: [] };
    return {
        customId,
        user: { id: userId, tag: 'Clicker#0001' },
        guild,
        message: { id: 'panel-1', embeds: [], components: [] },
        isButton: () => true,
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        isUserSelect: () => false,
        update: async (o) => { calls.update.push(o); },
        reply: async (o) => { calls.reply.push(o); },
        followUp: async (o) => { calls.followUp.push(o); },
        __calls: calls,
    };
}

function fieldsOf(payload) {
    return payload.embeds[0].data.fields || [];
}

function buttonsOf(payload) {
    return (payload.components && payload.components[0] ? payload.components[0].components : []).map(c => c.data);
}

// ──────────────────── Query parsing ────────────────────

test('tokenize: words split on whitespace, quotes hold a phrase together', () => {
    assert.deepStrictEqual(logSearch.tokenizeQuery('a "b c" d'), [
        { value: 'a', phrase: false },
        { value: 'b c', phrase: true },
        { value: 'd', phrase: false },
    ]);
});

test('parse: multiple words are separate terms, a quoted run is one phrase', () => {
    const words = logSearch.parseSearchQuery('dying light');
    assert.deepStrictEqual(words.terms, [
        { value: 'dying', phrase: false },
        { value: 'light', phrase: false },
    ]);
    assert.strictEqual(words.empty, false);

    const phrase = logSearch.parseSearchQuery('"dying light"');
    assert.deepStrictEqual(phrase.terms, [{ value: 'dying light', phrase: true }]);
});

test('parse: an empty or whitespace-only query is valid and means "newest first"', () => {
    for (const raw of ['', '   ', null, undefined]) {
        const parsed = logSearch.parseSearchQuery(raw);
        assert.strictEqual(parsed.error, undefined);
        assert.deepStrictEqual(parsed.terms, []);
        assert.strictEqual(parsed.empty, true);
    }
});

test('parse: a query longer than the cap is rejected instead of truncated', () => {
    const parsed = logSearch.parseSearchQuery('x'.repeat(logSearch.MAX_QUERY_LENGTH + 1));
    assert.match(parsed.error, /too long/i);
    assert.strictEqual(parsed.terms, undefined);

    // Exactly at the cap is still fine.
    assert.strictEqual(logSearch.parseSearchQuery('x'.repeat(logSearch.MAX_QUERY_LENGTH)).error, undefined);
});

test('parse: too many words is rejected, duplicates are not counted twice', () => {
    assert.match(logSearch.parseSearchQuery('a b c d e f g h i').error, /Too many keywords/);
    assert.strictEqual(logSearch.parseSearchQuery('a b c d e f g h').terms.length, 8);

    const dupes = logSearch.parseSearchQuery('spam spam SPAM');
    assert.strictEqual(dupes.terms.length, 1, 'the same word is one condition, case-insensitively');
});

test('parse: trailing sentence punctuation is trimmed, meaningful punctuation survives', () => {
    assert.deepStrictEqual(logSearch.parseSearchQuery('spamming!').terms, [{ value: 'spamming', phrase: false }]);
    assert.deepStrictEqual(logSearch.parseSearchQuery('wait...').terms, [{ value: 'wait', phrase: false }]);
    // '%' is part of what the user is looking for — it must not be stripped.
    assert.deepStrictEqual(logSearch.parseSearchQuery('50%').terms, [{ value: '50%', phrase: false }]);
    assert.deepStrictEqual(logSearch.parseSearchQuery('.env').terms, [{ value: '.env', phrase: false }]);
    // A term that is nothing but punctuation is still searched for literally.
    assert.deepStrictEqual(logSearch.parseSearchQuery('?').terms, [{ value: '?', phrase: false }]);
});

test('parse: an unclosed quote searches what was typed', () => {
    assert.deepStrictEqual(logSearch.parseSearchQuery('"dying light').terms, [{ value: 'dying light', phrase: true }]);
});

// ──────────────────── SQL ────────────────────

test('escapeLike: wildcards and the escape character become literal text', () => {
    assert.strictEqual(logSearch.escapeLike('50%'), '50\\%');
    assert.strictEqual(logSearch.escapeLike('a_b'), 'a\\_b');
    assert.strictEqual(logSearch.escapeLike('back\\slash'), 'back\\\\slash');
});

test('buildWhere: no user text reaches the SQL string — every value is bound', () => {
    const injection = "'; DROP TABLE message_log; --";
    const { where, params } = logSearch.buildWhere({
        guildId: 'g1',
        terms: [{ value: injection }],
        userId: injection,
        channelId: injection,
        action: injection,
    });

    assert.ok(!where.includes('DROP'), 'the statement must not contain the query');
    assert.ok(!where.includes(injection));
    assert.ok(params.includes('%' + logSearch.escapeLike(injection) + '%'));
});

test('a SQL injection attempt is searched for as text and the table survives', () => {
    seed({ content: 'harmless' });
    const injection = "'; DROP TABLE message_log; --";
    assert.deepStrictEqual(contentsOf({ query: injection }), []);
    assert.strictEqual(getDb().prepare('SELECT COUNT(*) AS n FROM message_log').get().n, 1);
});

// ──────────────────── Search behaviour ────────────────────

test('multi-word search matches words in any order, and requires all of them', () => {
    seed({ content: 'ping everyone please', at: 3 });
    seed({ content: 'everyone should ping the mods', at: 2 });
    seed({ content: 'ping only', at: 1 });

    assert.deepStrictEqual(contentsOf({ query: 'ping everyone' }).sort(), [
        'everyone should ping the mods',
        'ping everyone please',
    ]);
    // The bug that started this: appending a word used to kill the results.
    assert.strictEqual(contentsOf({ query: 'ping' }).length, 3);
    assert.strictEqual(contentsOf({ query: 'ping everyone mods' }).length, 1, 'every word has to be there');
});

test('a quoted phrase must appear contiguously', () => {
    seed({ content: 'ping everyone please', at: 2 });
    seed({ content: 'everyone should ping', at: 1 });

    assert.deepStrictEqual(contentsOf({ query: '"ping everyone"' }), ['ping everyone please']);
    assert.strictEqual(contentsOf({ query: 'everyone ping' }).length, 2, 'unquoted words still match in any order');
});

test('matching is case-insensitive in both directions', () => {
    seed({ content: 'Dying Light' });
    assert.strictEqual(contentsOf({ query: 'dying light' }).length, 1);
    assert.strictEqual(contentsOf({ query: 'DYING LIGHT' }).length, 1);
    assert.strictEqual(contentsOf({ query: 'DyInG' }).length, 1);
});

test('punctuation is literal — % and _ are not wildcards', () => {
    seed({ content: '50% off today', at: 2 });
    seed({ content: '50 off today', at: 1 });

    assert.deepStrictEqual(contentsOf({ query: '50%' }), ['50% off today']);
    assert.strictEqual(contentsOf({ query: '_' }).length, 0, 'a bare underscore must not match every row');
    // '%' is a literal here: it matches the row that really contains one and
    // not the other. Before the escape it was a wildcard and matched both.
    assert.deepStrictEqual(contentsOf({ query: '%' }), ['50% off today']);
});

test('search covers the author tag and attachment names, not just the message text', () => {
    seed({ content: 'no match here', authorTag: 'skywalker#0001', at: 3 });
    seed({ content: 'no match here either', attachments: JSON.stringify([{ name: 'evidence.png', url: 'u' }]), at: 2 });
    seed({ content: 'nothing', authorTag: 'other#0002', at: 1 });

    assert.deepStrictEqual(contentsOf({ query: 'skywalker' }).length, 1);
    assert.strictEqual(contentsOf({ query: 'evidence.png' }).length, 1);
});

test('filters by user, channel and action, and never crosses servers', () => {
    seed({ content: 'keep', authorId: 'u1', channelId: 'c1', action: 'deleted', at: 3 });
    seed({ content: 'other user', authorId: 'u2', channelId: 'c1', action: 'deleted', at: 2 });
    seed({ content: 'other channel', authorId: 'u1', channelId: 'c2', action: 'edited', at: 1 });
    seed({ content: 'other guild', guildId: 'g2', authorId: 'u1', channelId: 'c1', action: 'deleted', at: 4 });

    assert.deepStrictEqual(contentsOf({ query: null, userId: 'u1' }).sort(), ['keep', 'other channel']);
    assert.deepStrictEqual(contentsOf({ query: null, channelId: 'c1' }), ['keep', 'other user']);
    assert.deepStrictEqual(contentsOf({ query: null, action: 'edited' }), ['other channel']);
    assert.strictEqual(contentsOf({ query: 'other guild' }).length, 0, 'another guild\'s rows are invisible');
});

test('an empty query returns the newest entries first', () => {
    seed({ content: 'oldest', at: 1 });
    seed({ content: 'middle', at: 2 });
    seed({ content: 'newest', at: 3 });

    assert.deepStrictEqual(contentsOf({ query: '' }), ['newest', 'middle', 'oldest']);
});

test('results are capped and the true match count is reported', () => {
    for (let i = 0; i < 8; i++) seed({ content: 'spam ' + i, at: i + 1 });

    const result = logSearch.searchMessageLog({
        guildId: 'g1', terms: logSearch.parseSearchQuery('spam').terms, limit: 3,
    });
    assert.strictEqual(result.rows.length, 3);
    assert.strictEqual(result.total, 8, 'the footer needs the real count, not the page size');
    assert.strictEqual(result.truncated, true);
    assert.deepStrictEqual(result.rows.map(r => r.content), ['spam 7', 'spam 6', 'spam 5']);
});

test('clampLimit: default when absent, hard ceiling when huge', () => {
    assert.strictEqual(logSearch.clampLimit(undefined), logSearch.DEFAULT_RESULTS);
    assert.strictEqual(logSearch.clampLimit(0), logSearch.DEFAULT_RESULTS);
    assert.strictEqual(logSearch.clampLimit(-5), logSearch.DEFAULT_RESULTS);
    assert.strictEqual(logSearch.clampLimit('25'), 25);
    assert.strictEqual(logSearch.clampLimit(9999), logSearch.MAX_RESULTS);
});

// ──────────────────── The command ────────────────────

test('the command replies ephemerally with fields and paging buttons', async () => {
    for (let i = 0; i < 7; i++) seed({ content: 'ping everyone ' + i, at: i + 1 });
    const interaction = makeCommandInteraction({ query: 'ping everyone' });

    await executeLogs(interaction);

    assert.strictEqual(interaction.__calls.reply.length, 1);
    const payload = interaction.__calls.reply[0];
    assert.strictEqual(payload.ephemeral, true, 'results are private to the invoker');
    assert.strictEqual(fieldsOf(payload).length, logSearch.PAGE_SIZE);

    const buttons = buttonsOf(payload);
    assert.deepStrictEqual(buttons.map(b => b.label), ['Previous', 'Page 1/2', 'Next', 'Close']);
    assert.strictEqual(buttons[0].disabled, true, 'nothing before page 1');
    assert.strictEqual(buttons[1].disabled, true, 'the page indicator is not clickable');
    assert.strictEqual(buttons[2].disabled, false);
    assert.match(payload.embeds[0].data.footer.text, /Page 1\/2/);
    assert.match(payload.embeds[0].data.footer.text, /7 matches/);
});

test('the command reports an honest count when the search is truncated by limit', async () => {
    for (let i = 0; i < 9; i++) seed({ content: 'spam ' + i, at: i + 1 });
    const interaction = makeCommandInteraction({ query: 'spam', limit: 6 });

    await executeLogs(interaction);

    const footer = interaction.__calls.reply[0].embeds[0].data.footer.text;
    assert.match(footer, /newest 6 of 9 matches/);
});

test('zero matches replies cleanly: no buttons, and the filters that were used', async () => {
    seed({ content: 'nothing relevant' });
    const interaction = makeCommandInteraction({ query: 'absent', action: 'deleted' });

    await executeLogs(interaction);

    const payload = interaction.__calls.reply[0];
    assert.strictEqual(payload.ephemeral, true);
    assert.strictEqual(payload.components, undefined, 'nothing to page through');
    assert.match(payload.embeds[0].data.description, /action `deleted`/);
    assert.match(payload.embeds[0].data.description, /query `absent`/);
    assert.strictEqual(logSearch.sessionCount(), 0, 'a search with no results stores nothing');
});

test('an over-long query is refused before it reaches SQLite', async () => {
    const interaction = makeCommandInteraction({ query: 'x'.repeat(logSearch.MAX_QUERY_LENGTH + 1) });

    await executeLogs(interaction);

    assert.match(interaction.__calls.reply[0].content, /too long/i);
    assert.strictEqual(interaction.__calls.reply[0].ephemeral, true);
    assert.strictEqual(logSearch.sessionCount(), 0);
});

test('the command refuses to run outside a guild', async () => {
    const interaction = makeCommandInteraction({ query: 'x', guild: null });

    await executeLogs(interaction);

    assert.match(interaction.__calls.reply[0].content, /only works inside a server/i);
});

test('an unrecognised action (possible via a prefix command) is dropped, not bound', async () => {
    seed({ content: 'keep me', action: 'deleted' });
    const interaction = makeCommandInteraction({ query: 'keep', action: 'nonsense' });

    await executeLogs(interaction);

    assert.strictEqual(fieldsOf(interaction.__calls.reply[0]).length, 1);
});

test('oversized log content is truncated to fit the embed field limit', async () => {
    seed({ content: 'x'.repeat(5000) });
    const interaction = makeCommandInteraction({ query: null });

    await executeLogs(interaction);

    const field = fieldsOf(interaction.__calls.reply[0])[0];
    assert.ok(field.value.length <= 1024, 'field value must respect the embed limit');
    assert.ok(field.name.length <= 256, 'field name must respect the embed limit');
});

// ──────────────────── Pagination buttons ────────────────────

async function searchWithPages(rows) {
    for (let i = 0; i < rows; i++) seed({ content: 'match ' + i, at: i + 1 });
    const interaction = makeCommandInteraction({ query: 'match' });
    await executeLogs(interaction);
    return interaction.__calls.reply[0];
}

test('Next and Previous move one page, and the edges disable the right button', async () => {
    const buttons = buttonsOf(await searchWithPages(12));
    const nextId = buttons[2].custom_id;
    const lastPageId = nextId.replace(/_\d+$/, '_2');

    // Page 2 of 3.
    const second = makeButtonInteraction({ customId: nextId });
    await handleInteraction(second);
    let page = second.__calls.update[0];
    assert.strictEqual(fieldsOf(page).length, 5);
    assert.match(page.embeds[0].data.footer.text, /Page 2\/3/);
    let pageButtons = buttonsOf(page);
    assert.strictEqual(pageButtons[0].disabled, false, 'Previous is live in the middle');
    assert.strictEqual(pageButtons[2].disabled, false, 'Next is live in the middle');

    // Page 3 of 3 — the last page boundary.
    const third = makeButtonInteraction({ customId: lastPageId });
    await handleInteraction(third);
    page = third.__calls.update[0];
    assert.match(page.embeds[0].data.footer.text, /Page 3\/3/);
    assert.strictEqual(fieldsOf(page).length, 2, 'the remainder, not a full page');
    pageButtons = buttonsOf(page);
    assert.strictEqual(pageButtons[2].disabled, true, 'Next is dead on the last page');
    assert.strictEqual(pageButtons[0].disabled, false);

    // Walking back: each Previous lands on the previous page, and the first
    // page is where Previous finally goes dead.
    const back = makeButtonInteraction({ customId: pageButtons[0].custom_id });
    await handleInteraction(back);
    page = back.__calls.update[0];
    assert.match(page.embeds[0].data.footer.text, /Page 2\/3/);

    const first = makeButtonInteraction({ customId: buttonsOf(page)[0].custom_id });
    await handleInteraction(first);
    page = first.__calls.update[0];
    assert.match(page.embeds[0].data.footer.text, /Page 1\/3/);
    assert.strictEqual(buttonsOf(page)[0].disabled, true, 'Previous is dead on the first page');
    assert.strictEqual(buttonsOf(page)[2].disabled, false);
});

test('a single page needs no navigation but still reports the page', async () => {
    const payload = await searchWithPages(3);

    const buttons = buttonsOf(payload);
    assert.strictEqual(buttons[0].disabled, true);
    assert.strictEqual(buttons[2].disabled, true);
    assert.strictEqual(buttons[1].label, 'Page 1/1');
    assert.match(payload.embeds[0].data.footer.text, /Page 1\/1 · 3 matches/);
});

test('paging renders from the stored rows without re-running the search', async () => {
    const nextId = buttonsOf(await searchWithPages(6))[2].custom_id;

    // A row deleted after the search must not change page 2 — proof the click
    // re-renders the stored result set instead of querying again.
    getDb().prepare('DELETE FROM message_log').run();

    const click = makeButtonInteraction({ customId: nextId });
    await handleInteraction(click);

    assert.strictEqual(fieldsOf(click.__calls.update[0]).length, 1, 'the sixth match is still there');
    assert.match(click.__calls.update[0].embeds[0].data.footer.text, /Page 2\/2/);
});

test('another user cannot page someone else\'s search', async () => {
    const nextId = buttonsOf(await searchWithPages(6))[2].custom_id;

    const intruder = makeButtonInteraction({ customId: nextId, userId: 'intruder' });
    await handleInteraction(intruder);

    assert.strictEqual(intruder.__calls.update.length, 0, 'the message must not be touched');
    assert.match(intruder.__calls.reply[0].content, /Only the person who ran this command can interact/);
    assert.strictEqual(intruder.__calls.reply[0].ephemeral, true);

    // And the session is untouched: the owner still starts at page 1.
    const owner = makeButtonInteraction({ customId: nextId });
    await handleInteraction(owner);
    assert.match(owner.__calls.update[0].embeds[0].data.footer.text, /Page 2\/2/);
});

test('a leaked session id is not a key to someone else\'s results', async () => {
    const nextId = buttonsOf(await searchWithPages(6))[2].custom_id;
    const [, ownerId, sessionId, page] = nextId.split('_');

    // An id that was never issued is not a session.
    assert.strictEqual(logSearch.getSession('f'.repeat(12), {}), null);
    // The store refuses a different user outright, even with the real id.
    assert.strictEqual(logSearch.getSession(sessionId, { userId: 'intruder' }), null);
    assert.ok(logSearch.getSession(sessionId, { userId: ownerId }));

    // And the handler refuses too: the router is the first lock on this door,
    // not the only one. Here the clicker is smuggled in past the router with
    // the owner's id still encoded in the custom id.
    const forged = makeButtonInteraction({ customId: nextId, userId: 'intruder' });
    await handleLogSearchButton(forged, ['ls', ownerId, sessionId, page]);
    assert.strictEqual(forged.__calls.update.length, 0, 'no page is rendered');
    assert.match(forged.__calls.reply[0].content, /Only the person who ran/);
});

test('an expired or unknown session explains itself instead of dead buttons', async () => {
    for (let i = 0; i < 6; i++) seed({ content: 'match ' + i, at: i + 1 });
    const interaction = makeCommandInteraction({ query: 'match' });
    await executeLogs(interaction);

    const nextId = buttonsOf(interaction.__calls.reply[0])[2].custom_id;
    const [, userId, sessionId] = nextId.split('_');
    const session = logSearch.getSession(sessionId, { userId });
    assert.ok(session, 'the session the buttons point at exists');

    // Age it out.
    session.expiresAt = Date.now() - 1;

    const click = makeButtonInteraction({ customId: nextId, userId });
    await handleInteraction(click);

    assert.strictEqual(click.__calls.update.length, 1);
    assert.match(click.__calls.update[0].content, /expired/i);
    assert.deepStrictEqual(click.__calls.update[0].components, []);
    assert.strictEqual(logSearch.getSession(sessionId, { userId }), null, 'the stale session is dropped');

    // An id that never existed behaves the same way.
    const ghost = makeButtonInteraction({ customId: 'ls_' + userId + '_' + 'f'.repeat(12) + '_1', userId });
    await handleInteraction(ghost);
    assert.match(ghost.__calls.update[0].content, /expired/i);
});

test('a session belongs to one guild', async () => {
    for (let i = 0; i < 6; i++) seed({ content: 'match ' + i, at: i + 1 });
    const interaction = makeCommandInteraction({ query: 'match' });
    await executeLogs(interaction);

    const nextId = buttonsOf(interaction.__calls.reply[0])[2].custom_id;
    const [, userId, sessionId] = nextId.split('_');
    assert.strictEqual(logSearch.getSession(sessionId, { userId, guildId: 'g2' }), null);

    const elsewhere = makeButtonInteraction({ customId: nextId, userId, guild: OTHER_GUILD });
    await handleInteraction(elsewhere);
    assert.match(elsewhere.__calls.update[0].content, /expired/i);
});

test('Close ends the search and forgets the session', async () => {
    for (let i = 0; i < 6; i++) seed({ content: 'match ' + i, at: i + 1 });
    const interaction = makeCommandInteraction({ query: 'match' });
    await executeLogs(interaction);

    const buttons = buttonsOf(interaction.__calls.reply[0]);
    const closeId = buttons[3].custom_id;
    const [, userId, sessionId] = closeId.split('_');
    assert.strictEqual(logSearch.sessionCount(), 1);

    const click = makeButtonInteraction({ customId: closeId, userId });
    await handleInteraction(click);

    assert.match(click.__calls.update[0].content, /closed/i);
    assert.strictEqual(logSearch.sessionCount(), 0);
    assert.strictEqual(logSearch.getSession(sessionId, { userId }), null);
});

test('the session store is bounded and expires idle searches', () => {
    for (let i = 0; i < logSearch.MAX_SESSIONS + 25; i++) {
        logSearch.createSession({ userId: 'u' + i, guildId: 'g1', rows: [], total: 0 });
    }
    assert.strictEqual(logSearch.sessionCount(), logSearch.MAX_SESSIONS, 'oldest sessions are dropped, not accumulated');

    const fresh = logSearch.createSession({ userId: 'u', guildId: 'g1', rows: [], total: 0 });
    fresh.expiresAt = Date.now() - 1;
    logSearch.createSession({ userId: 'u2', guildId: 'g1', rows: [], total: 0 }); // sweep runs on create
    assert.ok(logSearch.sessionCount() <= logSearch.MAX_SESSIONS);
    assert.strictEqual(logSearch.getSession(fresh.id, {}), null);
});

// ──────────────────── Permissions ────────────────────

test('/logs keeps its permission boundaries', () => {
    assert.strictEqual(permissionFor('logs'), PermissionFlagsBits.ManageGuild);
    assert.strictEqual(publicCommands.includes('logs'), false, 'the owner guard still applies');
});

test('the live pipeline routes /logs search and still refuses the ungranted', async () => {
    const { runCommand } = require('../src/commandPipeline');
    const { grantPermission } = require('../src/permissions');
    for (let i = 0; i < 6; i++) seed({ content: 'match ' + i, at: i + 1 });

    const previousOwner = process.env.OWNER_ID;
    process.env.OWNER_ID = 'owner1';
    try {
        // Owner: registry lookup, guard, handler and reply all in one path.
        const owner = makeCommandInteraction({ query: 'match' });
        assert.strictEqual(await runCommand(owner), true, 'the registry still knows the command');
        assert.strictEqual(owner.__calls.reply[0].ephemeral, true);
        assert.match(owner.__calls.reply[0].embeds[0].data.footer.text, /Page 1\/2/);

        // No grant: refused before the handler ever runs.
        const stranger = makeCommandInteraction({ query: 'match', userId: 'stranger' });
        await runCommand(stranger);
        assert.strictEqual(stranger.__calls.reply[0].ephemeral, true);
        assert.match(stranger.__calls.reply[0].content, /don't have permission/);
        assert.strictEqual(stranger.__calls.reply[0].embeds, undefined, 'no results leak to the refused user');

        // A /perm grant is still the way in — the refactor didn't narrow access.
        grantPermission('g1', 'logs', 'staff1');
        const staff = makeCommandInteraction({ query: 'match', userId: 'staff1' });
        await runCommand(staff);
        assert.match(staff.__calls.reply[0].embeds[0].data.footer.text, /6 matches/);
    } finally {
        if (previousOwner === undefined) delete process.env.OWNER_ID;
        else process.env.OWNER_ID = previousOwner;
    }
});

// ──────────────────── Prefix surface ────────────────────

function prefixMessage() {
    const member = { user: { id: '111111111111111111', username: 'Target', tag: 'Target#0001', displayAvatarURL: () => 'x', toString: () => '<@t>' } };
    const guild = {
        id: 'g1',
        members: { cache: new Map([['111111111111111111', member]]) },
        channels: { cache: new Map([['222222222222222222', { id: '222222222222222222', toString: () => '<#c>' }]]) },
    };
    return {
        author: { id: '333333333333333333', username: 'Mod', tag: 'Mod#0001', displayAvatarURL: () => 'x', toString: () => '<@m>' },
        member: null,
        guild,
        channel: { id: 'chan1' },
        channelId: 'chan1',
        client: { channels: { cache: new Map() } },
        createdTimestamp: Date.now(),
        reply: async () => ({ edit: async () => ({}) }),
    };
}

test('prefix parsing keeps the same words as the slash surface', () => {
    const message = prefixMessage();

    const words = buildPrefixInteraction(message, 'logs', ['search', '111111111111111111', 'dying', 'light'], ';');
    assert.ok(words.shim, 'the arguments must parse');
    assert.strictEqual(words.shim.options.getString('query'), 'dying light');
    assert.strictEqual(words.shim.options.getUser('user').id, '111111111111111111');

    const filters = buildPrefixInteraction(message, 'logs', ['search', 'channel:222222222222222222', 'action:deleted', 'limit:7', '50%'], ';');
    assert.ok(filters.shim);
    assert.strictEqual(filters.shim.options.getChannel('channel').id, '222222222222222222');
    assert.strictEqual(filters.shim.options.getString('action'), 'deleted');
    assert.strictEqual(filters.shim.options.getInteger('limit'), 7);
    assert.strictEqual(filters.shim.options.getString('query'), '50%');

    const explicit = buildPrefixInteraction(message, 'logs', ['search', 'query:ping everyone'], ';');
    assert.strictEqual(explicit.shim.options.getString('query'), 'ping everyone');
});

// Regression tests for three ticket defects found in the audit:
//
//   1. saveTranscript() fetched ONE page of 100 messages, so a ticket longer
//      than that lost its beginning — while the README promises the whole
//      conversation. The transcript must be paged back to the channel start.
//   2. claimTicket()/closeTicket() read the row, then updated it
//      unconditionally. Two clicks in the same second both "won": two claim
//      announcements, two close embeds, two DMs, two transcript snapshots.
//      The row's own state now decides the winner.
//
// Both race tests start the two operations without awaiting the first, which
// is exactly the interleaving a double click produces: both read `open` before
// either writes.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-race-test-'));
process.env.DATA_DIR = tmp;

const { getDb, closeDb } = require('../src/db');
const tickets = require('../src/tickets');

tickets.setTicketClient({
    user: { id: 'bot-1', tag: 'Vigil#0001' },
    users: { fetch: async () => null },
});

after(() => {
    try { closeDb(); } catch { /* already closed */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

let seq = 0;

function insertTicket(channelId, status = 'open') {
    const n = ++seq;
    const id = 'ticket-' + n;
    getDb().prepare(`INSERT INTO tickets (id, guild_id, ticket_number, channel_id, creator_id, creator_tag, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, 'guild-1', n, channelId, 'creator-1', 'Creator#0001', status, Date.now() - 60000);
    return getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

function makeGuild() {
    return {
        id: 'guild-1',
        name: 'Test Guild',
        ownerId: 'owner-1',
        iconURL: () => null,
        channels: { cache: { get: () => null } },
        roles: { cache: new Map() },
        members: { cache: new Map(), fetch: async () => null },
    };
}

function makeChannel(id) {
    const sent = [];
    return {
        id,
        sent,
        send: async (payload) => { sent.push(payload); return payload; },
        delete: async () => true,
        messages: {
            // An empty channel: the close path still records its own system rows.
            fetch: async () => ({ size: 0, values: () => [] }),
        },
    };
}

// isTicketStaff() treats a member-shaped actor as its own cache entry, then
// compares it to guild.ownerId — so the server owner is the simplest staff.
const claimer = {
    id: 'owner-1',
    tag: 'Owner#0001',
    roles: { cache: new Map() },
    permissions: { has: () => false },
};

test('two simultaneous claims produce exactly one claim', async () => {
    insertTicket('ch-claim');
    const channel = makeChannel('ch-claim');

    const results = await Promise.all([
        tickets.claimTicket(makeGuild(), channel, claimer),
        tickets.claimTicket(makeGuild(), channel, claimer),
    ]);

    const winners = results.filter((r) => r && r.success);
    const losers = results.filter((r) => r && r.error);
    assert.strictEqual(winners.length, 1, 'only one claim may win');
    assert.strictEqual(losers.length, 1, 'the other click is told why it lost');
    assert.match(losers[0].error, /already claimed|already closed/i);
    // claimTicket posts three payloads: the claim embed, the close button row
    // and the add-user/transfer/close row. A second claim would double them.
    assert.strictEqual(channel.sent.length, 3, 'one claim announcement, not two of each');

    const row = getDb().prepare("SELECT status, claimer_id FROM tickets WHERE channel_id = 'ch-claim'").get();
    assert.strictEqual(row.status, 'claimed');
    assert.strictEqual(row.claimer_id, claimer.id);
});

test('a claim after the ticket closed is refused, not overwritten', async () => {
    insertTicket('ch-claim-closed', 'closed');
    const channel = makeChannel('ch-claim-closed');
    const result = await tickets.claimTicket(makeGuild(), channel, claimer);
    assert.match(result.error || '', /No open ticket/i);
});

test('two simultaneous closes produce exactly one close', async () => {
    insertTicket('ch-close');
    const channel = makeChannel('ch-close');

    const results = await Promise.all([
        tickets.closeTicket(makeGuild(), channel, claimer, 'duplicate press'),
        tickets.closeTicket(makeGuild(), channel, claimer, 'duplicate press'),
    ]);

    const winners = results.filter((r) => r && r.success);
    const losers = results.filter((r) => r && r.error);
    assert.strictEqual(winners.length, 1, 'only one close may win');
    assert.strictEqual(losers.length, 1);
    assert.match(losers[0].error, /already closed/i);

    const closeEmbeds = channel.sent.filter((p) => p && Array.isArray(p.embeds) && p.embeds.length);
    assert.strictEqual(closeEmbeds.length, 1, 'the channel is told the ticket closed once');

    const systemRows = getDb()
        .prepare("SELECT COUNT(*) AS n FROM ticket_messages WHERE ticket_id = (SELECT id FROM tickets WHERE channel_id = 'ch-close') AND content LIKE '%Ticket closed by%'")
        .get();
    assert.strictEqual(systemRows.n, 1, 'one close system message, not two');

    const row = getDb().prepare("SELECT status, closed_reason FROM tickets WHERE channel_id = 'ch-close'").get();
    assert.strictEqual(row.status, 'closed');
    assert.strictEqual(row.closed_reason, 'duplicate press');
});

test('the transcript pages back to the first message, not just the last 100', async () => {
    const ticket = insertTicket('ch-long');
    const total = 150;
    const all = [];
    for (let i = 0; i < total; i++) {
        all.push({
            id: 'm-' + i,
            content: 'message number ' + i,
            createdTimestamp: 1700000000000 + i,
            system: false,
            author: {
                id: 'author-' + i,
                tag: 'Author' + i + '#0001',
                bot: false,
                displayAvatarURL: () => null,
            },
        });
    }

    // Discord returns newest-first pages. Page 1 is the newest 100, page 2 the
    // remaining 50, page 3 empty — the shape a real channel fetch has.
    const fetches = [];
    const page = (start, end) => {
        const slice = all.slice(start, end).reverse();
        return { size: slice.length, values: () => slice };
    };
    const channel = {
        id: 'ch-long',
        messages: {
            fetch: async (opts = {}) => {
                fetches.push(opts);
                if (!opts.before) return page(50, total);       // newest 100
                if (opts.before === 'm-50') return page(0, 50);  // the rest
                return { size: 0, values: () => [] };
            },
        },
    };

    await tickets.saveTranscript(makeGuild(), ticket, channel);

    const stored = getDb().prepare('SELECT transcript FROM tickets WHERE id = ?').get(ticket.id).transcript;
    assert.ok(stored, 'a transcript is stored');
    assert.match(stored, /message number 0\b/, 'the first message must survive the snapshot');
    assert.match(stored, /message number 149\b/, 'and the last one too');
    assert.match(stored, /End of transcript — 150 messages/);
    assert.ok(!/truncated/i.test(stored), 'nothing was truncated at this size');
    assert.ok(fetches.length >= 2, 'the fetch paged instead of taking one 100-message slice');
    assert.ok(fetches.some((f) => f.before === 'm-50'), 'the second page continued from the oldest seen id');
});

test('a short ticket still snapshots in one page without a truncation notice', async () => {
    const ticket = insertTicket('ch-short');
    const msgs = [1, 2, 3].map((n) => ({
        id: 's-' + n,
        content: 'short message ' + n,
        createdTimestamp: 1700000000000 + n,
        system: false,
        author: { id: 'u-' + n, tag: 'U' + n + '#0001', bot: false, displayAvatarURL: () => null },
    })).reverse();
    const channel = {
        id: 'ch-short',
        messages: { fetch: async () => ({ size: msgs.length, values: () => msgs }) },
    };

    await tickets.saveTranscript(makeGuild(), ticket, channel);

    const stored = getDb().prepare('SELECT transcript FROM tickets WHERE id = ?').get(ticket.id).transcript;
    assert.match(stored, /short message 1/);
    assert.match(stored, /short message 3/);
    assert.match(stored, /End of transcript — 3 messages/);
    assert.ok(!/truncated/i.test(stored));
});

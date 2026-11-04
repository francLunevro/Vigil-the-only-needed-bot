// Ticket SLA tracking (src/ticketSla.js).
//
// The two properties that make this feature trustworthy are the ones most of
// this file is about: the first response is recorded exactly once and can never
// be rewritten by a later message, and a ticket is alerted about exactly once —
// including across a restart, which is where a timer that lived only in memory
// would lose its place. The surfaces (the dashboard route and the ticket
// embeds) are checked through their real edges: the route's JSON, and the embed
// fields the alert posts.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-sla-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { getDb, closeDb } = require('../src/db');
const sla = require('../src/ticketSla');
const { updateTicketConfig } = require('../src/tickets');
const { createDashboard, setDashboardClient } = require('../src/dashboard');

const GUILD = 'g-sla';
// A realistic channel snowflake: the alert channel is validated as one, so a
// fixture like 'log-ch' would (correctly) be refused.
const LOG_CH = '222222222222222222';
const MIN = 60000;
const HOUR = 60 * MIN;

after(() => {
    try { sla.stopTicketSlaSweeper(); } catch { /* never started */ }
    try { closeDb(); } catch { /* already closed */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
    const db = getDb();
    db.prepare('DELETE FROM tickets').run();
    db.prepare('DELETE FROM guild_config').run();
    db.prepare('DELETE FROM ticket_config').run();
});

// ──────────────────── Fixtures ────────────────────

let ticketSeq = 0;

// A ticket row with the columns the SLA reads. Direct inserts (the shape
// test/tickets.test.js uses) keep the timestamps under the test's control
// instead of racing a clock.
function seedTicket({ guildId = GUILD, channelId = 'ch-1', creatorId = 'member-1', status = 'open', createdAt = Date.now(), firstResponseAt = null, firstResponseBy = null, alertedAt = null } = {}) {
    ticketSeq++;
    const id = 'ticket-' + ticketSeq;
    getDb().prepare(`INSERT INTO tickets (id, guild_id, ticket_number, channel_id, creator_id, creator_tag,
        status, panel_type_name, created_at, first_response_at, first_response_by, sla_alerted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, guildId, ticketSeq, channelId, creatorId, 'Member#0001', status, 'Support',
        createdAt, firstResponseAt, firstResponseBy, alertedAt
    );
    return id;
}

function ticketRow(id) {
    return getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

// A client whose guilds each have a channel cache holding the channels the
// alert needs, plus the ticket log channel the fallback resolves through.
function makeChannel(id) {
    const sent = [];
    return { id, sent, name: id, send: async (payload) => { sent.push(payload); return { id: 'msg' }; } };
}

function makeClient(guildId = GUILD, channels = [LOG_CH]) {
    const cache = new Map();
    for (const id of channels) cache.set(id, makeChannel(id));
    // A guild that runs tickets has its ticket log channel set, and that is
    // where SLA alerts go by default — the same plumbing ticket events already
    // use, not a second one. The test that needs "nowhere to post" clears it.
    updateTicketConfig(guildId, { log_channel_id: cache.has(LOG_CH) ? LOG_CH : null });
    const guild = {
        id: guildId,
        name: 'Test Guild',
        iconURL: () => null,
        channels: { cache },
    };
    return { guilds: { cache: new Map([[guildId, guild]]) }, __guild: guild, __channels: cache };
}

function message(overrides = {}) {
    return {
        guild: { id: GUILD },
        channelId: 'ch-1',
        system: false,
        author: { id: 'staff-1', bot: false, tag: 'Staff#0001' },
        createdTimestamp: Date.now(),
        content: 'on it',
        ...overrides,
    };
}

async function tick(ms = 30) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

// ──────────────────── Stamping ────────────────────

test('the first staff message stamps the ticket; later ones never rewrite it', () => {
    const createdAt = Date.now() - 5 * MIN;
    const id = seedTicket({ createdAt });

    const first = sla.noteTicketMessage(message({ createdTimestamp: createdAt + 2 * MIN }));
    assert.deepStrictEqual(first, {
        ticketId: id, stamped: true, firstResponseAt: createdAt + 2 * MIN, firstResponseBy: 'staff-1',
    });
    assert.strictEqual(ticketRow(id).first_response_at, createdAt + 2 * MIN);
    assert.strictEqual(ticketRow(id).first_response_by, 'staff-1');

    // A second staff member replying later changes nothing.
    const second = sla.noteTicketMessage(message({
        author: { id: 'staff-2', bot: false },
        createdTimestamp: createdAt + 9 * MIN,
    }));
    assert.strictEqual(second.stamped, false);
    assert.strictEqual(second.reason, 'already-stamped');
    assert.strictEqual(ticketRow(id).first_response_at, createdAt + 2 * MIN, 'the first response stands');
    assert.strictEqual(ticketRow(id).first_response_by, 'staff-1');
});

test('the requester, bots, system messages and closed tickets do not count', () => {
    const createdAt = Date.now() - HOUR;
    const open = seedTicket({ createdAt, channelId: 'ch-open' });
    const closed = seedTicket({ createdAt, channelId: 'ch-closed', status: 'closed', firstResponseAt: null, firstResponseBy: null });

    // The member answering their own ticket is the opposite of a staff response.
    assert.strictEqual(sla.noteTicketMessage(message({ channelId: 'ch-open', author: { id: 'member-1', bot: false } })), null);
    // Bots and webhooks.
    assert.strictEqual(sla.noteTicketMessage(message({ channelId: 'ch-open', author: { id: 'bot-1', bot: true } })), null);
    // Discord's own system messages (boosts, pins) have an author but no author.
    assert.strictEqual(sla.noteTicketMessage(message({ channelId: 'ch-open', system: true })), null);
    // A ticket that is over: the response would be to nobody.
    assert.strictEqual(sla.noteTicketMessage(message({ channelId: 'ch-closed' })), null);
    // An ordinary channel is not a ticket at all.
    assert.strictEqual(sla.noteTicketMessage(message({ channelId: 'general' })), null);
    // No guild (a DM) has no ticket.
    assert.strictEqual(sla.noteTicketMessage(message({ guild: null })), null);

    assert.strictEqual(ticketRow(open).first_response_at, null, 'nothing stamped any of that');
    assert.strictEqual(ticketRow(closed).first_response_at, null);

    // A real staff message still lands.
    assert.strictEqual(sla.noteTicketMessage(message({ channelId: 'ch-open' })).stamped, true);
    assert.ok(ticketRow(open).first_response_at);
    // And an answered ticket is left alone by a later message.
    assert.strictEqual(sla.noteTicketMessage(message({ channelId: 'ch-open', author: { id: 'staff-9', bot: false } })).stamped, false);
});

test('a claimed ticket still expects a first response', () => {
    const createdAt = Date.now() - 30 * MIN;
    const id = seedTicket({ createdAt, status: 'claimed' });
    assert.strictEqual(sla.noteTicketMessage(message()).stamped, true);
    assert.ok(ticketRow(id).first_response_at);
});

// ──────────────────── Waiting times and state ────────────────────

test('waiting time and SLA state follow the configured target', () => {
    const now = Date.now();
    const config = { enabled: true, firstResponseMinutes: 60, alertAfterMinutes: 120, alertChannelId: null };

    const fresh = { created_at: now - 10 * MIN, first_response_at: null };
    assert.strictEqual(sla.slaStateFor(fresh, config, now).state, 'waiting');

    const overdue = { created_at: now - 90 * MIN, first_response_at: null };
    const overdueState = sla.slaStateFor(overdue, config, now);
    assert.strictEqual(overdueState.state, 'overdue');
    assert.strictEqual(overdueState.waitedMs, 90 * MIN);

    const met = { created_at: now - 300 * MIN, first_response_at: now - 300 * MIN + 20 * MIN };
    assert.strictEqual(sla.slaStateFor(met, config, now).state, 'met');

    const late = { created_at: now - 300 * MIN, first_response_at: now - 300 * MIN + 90 * MIN };
    const lateState = sla.slaStateFor(late, config, now);
    assert.strictEqual(lateState.state, 'late');
    assert.strictEqual(lateState.responseMs, 90 * MIN);

    // No target configured: times are still measured, nothing is a breach.
    const noTarget = sla.slaStateFor(overdue, { ...config, firstResponseMinutes: null }, now);
    assert.strictEqual(noTarget.state, 'waiting');
    assert.strictEqual(noTarget.targetMs, null);
    assert.strictEqual(noTarget.waitedMs, 90 * MIN);
});

test('the open queue is oldest first and carries each wait', () => {
    const now = Date.now();
    seedTicket({ channelId: 'ch-new', createdAt: now - 5 * MIN });
    seedTicket({ channelId: 'ch-old', createdAt: now - 4 * HOUR });
    seedTicket({ channelId: 'ch-closed', createdAt: now - 9 * HOUR, status: 'closed' });

    const waits = sla.getOpenTicketWaits(GUILD, { now });

    assert.strictEqual(waits.length, 2, 'closed tickets are not waiting');
    assert.strictEqual(waits[0].channelId, 'ch-old');
    assert.strictEqual(waits[0].state, 'overdue');
    assert.strictEqual(waits[0].waitedMs, 4 * HOUR);
    assert.strictEqual(waits[1].state, 'waiting');
});

// ──────────────────── Statistics ────────────────────

test('statistics cover response times, breaches and the age of the open queue', () => {
    const now = Date.now();
    const responded = [10 * MIN, 40 * MIN, 200 * MIN];
    responded.forEach((responseMs, i) => seedTicket({
        channelId: 'ch-done-' + i,
        status: 'closed',
        createdAt: now - (2 + i) * HOUR,
        firstResponseAt: now - (2 + i) * HOUR + responseMs,
    }));
    seedTicket({ channelId: 'ch-waiting', createdAt: now - 3 * HOUR });
    // Outside the window: still open, so it shows in the queue, but its
    // response time must not drag the average around.
    seedTicket({ channelId: 'ch-ancient', status: 'closed', createdAt: now - 90 * 24 * HOUR, firstResponseAt: now - 90 * 24 * HOUR + 5 * MIN });

    const stats = sla.getTicketSlaStats(GUILD, { now, days: 30 });

    assert.strictEqual(stats.responded.count, 3, 'only the window counts');
    assert.strictEqual(stats.responded.averageMs, Math.round((10 + 40 + 200) / 3 * MIN));
    assert.strictEqual(stats.responded.medianMs, 40 * MIN);
    assert.strictEqual(stats.responded.withinTarget, 2);
    assert.strictEqual(stats.responded.late, 1);
    assert.strictEqual(stats.responded.slowestMs, 200 * MIN);

    assert.strictEqual(stats.unanswered.open, 1);
    assert.strictEqual(stats.unanswered.overTarget, 1);
    assert.strictEqual(stats.open.total, 1);
    assert.strictEqual(stats.open.overdue, 1);
    assert.ok(stats.open.oldestWaitMs >= 3 * HOUR);

    assert.strictEqual(stats.breaches.respondedLate, 1);
    assert.strictEqual(stats.breaches.openOverdue, 1);
    assert.strictEqual(stats.breaches.total, 2);
    assert.strictEqual(stats.targetMs, 60 * MIN);
});

// ──────────────────── Alerts ────────────────────

test('an unanswered ticket is alerted once, with the wait in the alert', async () => {
    const now = Date.now();
    const id = seedTicket({ channelId: 'ch-1', createdAt: now - 5 * HOUR });
    const client = makeClient();

    const first = await sla.sweepTicketSla(client, { now });
    assert.deepStrictEqual(first, { guilds: 1, due: 1, alerted: 1, failed: 0 });
    assert.ok(ticketRow(id).sla_alerted_at, 'the ticket is marked as alerted');

    const log = client.__channels.get(LOG_CH);
    assert.strictEqual(log.sent.length, 1);
    const embed = log.sent[0].embeds[0].data;
    assert.match(embed.title, /unanswered/i);
    const fields = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]));
    assert.strictEqual(fields['Ticket #'], '#' + ticketRow(id).ticket_number);
    assert.strictEqual(fields['Waiting'], '300 min');
    assert.strictEqual(fields['Target'], '60 min');
    assert.match(fields['Channel'], /<#ch-1>/);

    // Every later sweep leaves it alone — this is the "no re-alert" guarantee.
    const second = await sla.sweepTicketSla(client, { now: now + HOUR });
    assert.strictEqual(second.due, 0);
    assert.strictEqual(log.sent.length, 1, 'no second alert for the same ticket');
});

test('a restart re-sweeps from the database without repeating an alert', async () => {
    const now = Date.now();
    const alreadyAlerted = seedTicket({ channelId: 'ch-old', createdAt: now - 8 * HOUR, alertedAt: now - 7 * HOUR });
    const client = makeClient();

    // The bot was offline when this one came due: nothing has marked it.
    const cameDueWhileOffline = seedTicket({ channelId: 'ch-1', createdAt: now - 6 * HOUR });

    sla.startTicketSlaSweeper(client);
    await tick(60);
    sla.stopTicketSlaSweeper();

    const log = client.__channels.get(LOG_CH);
    assert.strictEqual(log.sent.length, 1, 'the boot sweep alerted exactly the ticket that came due');
    assert.ok(ticketRow(cameDueWhileOffline).sla_alerted_at);
    assert.strictEqual(ticketRow(alreadyAlerted).sla_alerted_at, now - 7 * HOUR, 'the earlier alert is untouched');

    // A second restart (same rows, new client) adds nothing.
    const restarted = makeClient();
    sla.startTicketSlaSweeper(restarted);
    await tick(60);
    sla.stopTicketSlaSweeper();
    assert.strictEqual(restarted.__channels.get(LOG_CH).sent.length, 0, 'a restart is not a reason to re-alert');
});

test('a ticket that is already answered is never alerted about', async () => {
    const now = Date.now();
    seedTicket({ channelId: 'ch-1', createdAt: now - 9 * HOUR, firstResponseAt: now - 8 * HOUR, firstResponseBy: 'staff-1' });
    const client = makeClient();

    const result = await sla.sweepTicketSla(client, { now });

    assert.strictEqual(result.due, 0);
    assert.strictEqual(client.__channels.get(LOG_CH).sent.length, 0);
});

test('an unconfigured guild is inert, and its statistics are zeros not errors', async () => {
    const now = Date.now();
    seedTicket({ channelId: 'ch-1', createdAt: now - 10 * HOUR });
    const client = makeClient();

    // Defaults are on, so this one alerts; the point is that no config row is
    // needed for that to work.
    assert.deepStrictEqual(sla.getTicketSlaConfig(GUILD), sla.DEFAULT_CONFIG);
    assert.strictEqual((await sla.sweepTicketSla(client, { now })).alerted, 1);

    // Switched off: the same ticket would not be alerted again even if it had
    // never been.
    seedTicket({ channelId: 'ch-2', createdAt: now - 10 * HOUR });
    sla.setTicketSlaConfig(GUILD, { enabled: false });
    assert.strictEqual((await sla.sweepTicketSla(client, { now })).due, 0);
    assert.strictEqual(client.__channels.get(LOG_CH).sent.length, 1);

    // No alert threshold at all: nothing to alert about, ever.
    sla.setTicketSlaConfig(GUILD, { enabled: true, alertAfterMinutes: null });
    assert.strictEqual((await sla.sweepTicketSla(client, { now })).due, 0);

    // A guild with no tickets at all.
    const emptyGuild = sla.getTicketSlaStats('g-never-used', { now });
    assert.strictEqual(emptyGuild.responded.count, 0);
    assert.strictEqual(emptyGuild.responded.averageMs, null);
    assert.strictEqual(emptyGuild.responded.medianMs, null);
    assert.strictEqual(emptyGuild.open.total, 0);
    assert.strictEqual(emptyGuild.open.oldestWaitMs, null);
    assert.strictEqual(emptyGuild.breaches.total, 0);
    assert.deepStrictEqual(emptyGuild.config, sla.DEFAULT_CONFIG);
    assert.deepStrictEqual(sla.getOpenTicketWaits('g-never-used'), []);
    assert.strictEqual(sla.getTicketSlaStats(null).responded.count, 0);

    // A sweep with no client, or a client with no guilds, is a no-op.
    assert.deepStrictEqual(await sla.sweepTicketSla(null), { guilds: 0, due: 0, alerted: 0, failed: 0 });
    assert.strictEqual((await sla.sweepTicketSla({ guilds: { cache: new Map() } })).guilds, 0);
});

test('an alert that cannot be posted is not marked as sent', async () => {
    const now = Date.now();
    const id = seedTicket({ channelId: 'ch-1', createdAt: now - 10 * HOUR });
    // No ticket log channel configured and an alert channel that does not exist.
    sla.setTicketSlaConfig(GUILD, { alertChannelId: '999999999999999999' });
    const client = makeClient(GUILD, [LOG_CH]);
    updateTicketConfig(GUILD, { log_channel_id: null });

    const result = await sla.sweepTicketSla(client, { now });

    assert.strictEqual(result.due, 1);
    assert.strictEqual(result.alerted, 0);
    assert.strictEqual(result.failed, 1);
    assert.strictEqual(ticketRow(id).sla_alerted_at, null, 'so the next sweep tries again');

    // Once a log channel exists, the retry succeeds.
    updateTicketConfig(GUILD, { log_channel_id: LOG_CH });
    sla.setTicketSlaConfig(GUILD, { alertChannelId: null });
    const retry = await sla.sweepTicketSla(client, { now });
    assert.strictEqual(retry.alerted, 1);
    assert.ok(ticketRow(id).sla_alerted_at);
});

// ──────────────────── Config ────────────────────

test('thresholds are validated rather than clamped', () => {
    const good = sla.validateTicketSlaPatch({ enabled: false, firstResponseMinutes: 15, alertAfterMinutes: null, alertChannelId: '123456789012345678' });
    assert.deepStrictEqual(good, { value: { enabled: false, firstResponseMinutes: 15, alertAfterMinutes: null, alertChannelId: '123456789012345678' } });

    for (const bad of [
        { enabled: 'yes' },
        { firstResponseMinutes: 0 },
        { firstResponseMinutes: 1.5 },
        { firstResponseMinutes: 8 * 24 * 60 },
        { firstResponseMinutes: 'sixty' },
        { alertAfterMinutes: -5 },
        { alertChannelId: 'not-a-channel' },
        { alertChannelId: 42 },
    ]) {
        const result = sla.validateTicketSlaPatch(bad);
        assert.ok(result.error, JSON.stringify(bad) + ' must be refused');
        assert.strictEqual(result.value, undefined);
    }
    assert.ok(sla.validateTicketSlaPatch(null).error);
    assert.ok(sla.validateTicketSlaPatch('60').error);

    // An empty patch is valid and changes nothing.
    assert.deepStrictEqual(sla.validateTicketSlaPatch({}), { value: {} });

    // A refused value never reaches the database.
    assert.throws(() => sla.setTicketSlaConfig(GUILD, { firstResponseMinutes: 0 }), /between/);
    assert.deepStrictEqual(sla.getTicketSlaConfig(GUILD), sla.DEFAULT_CONFIG);
});

test('the stored config is per guild, round-trips, and survives garbage', () => {
    const saved = sla.setTicketSlaConfig(GUILD, { firstResponseMinutes: 30, alertAfterMinutes: 45, alertChannelId: '111111111111111111' });
    assert.deepStrictEqual(saved, { enabled: true, firstResponseMinutes: 30, alertAfterMinutes: 45, alertChannelId: '111111111111111111' });
    assert.deepStrictEqual(sla.getTicketSlaConfig(GUILD), saved);

    // Another guild is untouched by that write.
    assert.deepStrictEqual(sla.getTicketSlaConfig('g-other'), sla.DEFAULT_CONFIG);

    // A partial patch keeps the rest, and switching off keeps the numbers.
    sla.setTicketSlaConfig(GUILD, { enabled: false });
    const off = sla.getTicketSlaConfig(GUILD);
    assert.strictEqual(off.enabled, false);
    assert.strictEqual(off.firstResponseMinutes, 30);
    assert.strictEqual(off.alertChannelId, '111111111111111111');

    // Whatever is in the column, the reader makes something sane of it.
    assert.deepStrictEqual(sla.normalizeTicketSlaConfig('nonsense'), sla.DEFAULT_CONFIG);
    assert.deepStrictEqual(sla.normalizeTicketSlaConfig(null), sla.DEFAULT_CONFIG);
    assert.deepStrictEqual(sla.normalizeTicketSlaConfig({ firstResponseMinutes: -1, alertChannelId: 'x' }), sla.DEFAULT_CONFIG);
    assert.strictEqual(sla.normalizeTicketSlaConfig({ firstResponseMinutes: null }).firstResponseMinutes, null, 'no target is a real setting');

    getDb().prepare("UPDATE guild_config SET ticket_sla_config = 'not json' WHERE guild_id = ?").run(GUILD);
    assert.deepStrictEqual(sla.getTicketSlaConfig(GUILD), sla.DEFAULT_CONFIG, 'a corrupt row falls back to the defaults');
});

// ──────────────────── The dashboard surface ────────────────────

function collection(items) {
    return {
        get size() { return items.length; },
        filter(fn) { return collection(items.filter(fn)); },
        sort(fn) { return collection(items.slice().sort(fn)); },
        map(fn) { return items.map(fn); },
        get(id) { return items.find((r) => r.id === id) || null; },
        has(id) { return items.some((r) => r.id === id); },
    };
}

async function withDashboard(run) {
    const guild = {
        id: GUILD,
        name: 'Test Guild',
        iconURL: () => null,
        channels: { cache: collection([{ id: LOG_CH, name: 'ticket-logs', type: 0, position: 1 }]) },
        roles: { cache: collection([]) },
    };
    setDashboardClient({ guilds: { cache: new Map([[GUILD, guild]]) }, user: null, ws: { ping: 1 } }, 'test-password');

    const server = http.createServer(createDashboard());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    const call = (method, urlPath, body, cookie) => new Promise((resolve, reject) => {
        const payload = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port, path: urlPath, method,
            headers: Object.assign(
                { 'Content-Type': 'application/json' },
                payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
                cookie ? { Cookie: cookie } : {},
            ),
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch { /* non-JSON */ }
                resolve({ status: res.statusCode, headers: res.headers, body: json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });

    try {
        return await run({ call });
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
}

async function login(call) {
    const res = await call('POST', '/api/login', { password: 'test-password' });
    assert.strictEqual(res.status, 200);
    return String(res.headers['set-cookie'][0]).split(';')[0];
}

test('the tickets route keeps its shape and adds the SLA payload', async () => {
    const now = Date.now();
    seedTicket({ channelId: 'ch-open', createdAt: now - 3 * HOUR });
    seedTicket({
        channelId: 'ch-closed', status: 'closed', createdAt: now - 20 * HOUR,
        firstResponseAt: now - 20 * HOUR + 12 * MIN, firstResponseBy: 'staff-1',
    });

    await withDashboard(async ({ call }) => {
        const anon = await call('GET', '/api/server/' + GUILD + '/tickets');
        assert.strictEqual(anon.status, 403, 'the tenant guard still runs first');

        const cookie = await login(call);
        const res = await call('GET', '/api/server/' + GUILD + '/tickets', undefined, cookie);

        assert.strictEqual(res.status, 200);
        for (const key of ['config', 'panels', 'tickets', 'channels', 'roles']) {
            assert.ok(key in res.body, 'legacy key ' + key + ' is still there');
        }
        assert.deepStrictEqual(res.body.panels, []);
        assert.strictEqual(res.body.tickets.length, 2);

        // The legacy ticket fields survive untouched.
        const open = res.body.tickets.find((t) => t.channelId === 'ch-open');
        for (const key of ['id', 'ticketNumber', 'channelId', 'creatorId', 'creatorTag', 'panelTypeName', 'status', 'createdAt', 'closedById', 'closedByTag', 'closedAt', 'claimerId', 'closedReason']) {
            assert.ok(key in open, 'legacy ticket field ' + key);
        }

        // And the SLA view arrives alongside them.
        assert.strictEqual(open.slaState, 'overdue');
        assert.ok(open.waitedMs >= 3 * HOUR);
        assert.strictEqual(open.firstResponseAt, null);
        assert.strictEqual(open.slaBreached, true);

        const closed = res.body.tickets.find((t) => t.channelId === 'ch-closed');
        assert.strictEqual(closed.slaState, 'met');
        assert.strictEqual(closed.firstResponseMs, 12 * MIN);
        assert.strictEqual(closed.firstResponseBy, 'staff-1');
        assert.strictEqual(closed.slaBreached, false);

        assert.strictEqual(res.body.sla.config.firstResponseMinutes, 60);
        assert.strictEqual(res.body.sla.stats.responded.count, 1);
        assert.strictEqual(res.body.sla.stats.open.overdue, 1);
        assert.strictEqual(res.body.sla.waits.length, 1);
        assert.strictEqual(res.body.sla.waits[0].channelId, 'ch-open');
    });
});

test('the config route validates SLA thresholds and stores the good ones', async () => {
    await withDashboard(async ({ call }) => {
        const cookie = await login(call);
        const url = '/api/server/' + GUILD + '/tickets/config';

        for (const bad of [{ sla: { firstResponseMinutes: 0 } }, { sla: { enabled: 'yes' } }, { sla: { alertAfterMinutes: 99.5 } }, { sla: { alertChannelId: 'nope' } }, { sla: 'on' }]) {
            const res = await call('POST', url, bad, cookie);
            assert.strictEqual(res.status, 400, JSON.stringify(bad) + ' is refused');
            assert.ok(res.body.error);
        }
        assert.deepStrictEqual(sla.getTicketSlaConfig(GUILD), sla.DEFAULT_CONFIG, 'nothing bad was stored');

        const ok = await call('POST', url, { sla: { enabled: true, firstResponseMinutes: 20, alertAfterMinutes: 40, alertChannelId: LOG_CH } }, cookie);
        assert.strictEqual(ok.status, 200);
        assert.strictEqual(ok.body.success, true);
        assert.strictEqual(ok.body.sla.firstResponseMinutes, 20, 'the saved config comes back');
        assert.deepStrictEqual(sla.getTicketSlaConfig(GUILD), { enabled: true, firstResponseMinutes: 20, alertAfterMinutes: 40, alertChannelId: LOG_CH });

        // The existing ticket config keys still work in the same request shape.
        const both = await call('POST', url, { enabled: true, closeOnLeave: true }, cookie);
        assert.strictEqual(both.status, 200);
        assert.ok(both.body.sla, 'the SLA config is echoed even when this request only touched the ticket config');

        // And the read route reflects it.
        const read = await call('GET', '/api/server/' + GUILD + '/tickets', undefined, cookie);
        assert.strictEqual(read.body.sla.config.firstResponseMinutes, 20);
        assert.strictEqual(read.body.config.closeOnLeave, true);
    });
});

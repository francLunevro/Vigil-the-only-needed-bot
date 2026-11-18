// Member file (src/memberFile.js) — the composed staff view of a member.
//
// What is being pinned here is the composition itself and the two properties
// that make it safe to hand to staff: every read is scoped to one guild, and a
// surface that fails is named instead of silently rendering an incomplete file
// as if it were complete. The surrounding surfaces are covered through their
// real edges too — the /memberfile command (reply, refusal) and the dashboard's
// member profile route (legacy fields intact, `memberFile` added, tenant guard
// still refusing an ungranted server).
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'member-file-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner-user';

const { getDb, closeDb, getErrorLogs } = require('../src/db');
const { getMemberFile } = require('../src/memberFile');
const { addWarning } = require('../src/warnings');
const { createCase } = require('../src/modCases');
const { addNote } = require('../src/staffNotes');
const { createReport } = require('../src/reports');
const { createBanAppeal } = require('../src/banAppeals');
const { executeMemberFile } = require('../src/commands/memberFile');
const { ownerGuard } = require('../src/commands/_guard');
const { grantPermission } = require('../src/permissions');
const { commandRegistry } = require('../src/commands/registry');
const { MODERATION_COMMANDS, permissionFor } = require('../src/commandPolicy');
const { createDashboard, setDashboardClient, addDashUser } = require('../src/dashboard');
const { PermissionFlagsBits } = require('discord.js');

const GUILD = 'g1';
const USER = 'u-target';
const T0 = Date.UTC(2026, 0, 1);
const DAY = 86400000;

after(() => {
    try { closeDb(); } catch { /* already closed */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
    const db = getDb();
    for (const table of ['warnings', 'mod_cases', 'mod_case_counters', 'staff_notes', 'reports', 'ban_appeals', 'tickets', 'temp_bans']) {
        db.prepare('DELETE FROM ' + table).run();
    }
});

// ──────────────────── Seeding ────────────────────

// One row per system, each with a timestamp we control so the merged order is
// a fact rather than a race with the clock. The accessors that stamp `now`
// themselves are corrected with an UPDATE, which keeps this test honest about
// what each module actually writes.
function seedEverySystem(guildId = GUILD, userId = USER, offset = 0) {
    const db = getDb();
    const base = T0 + offset;

    addWarning(guildId, userId, 'Mod#0001', 'spamming in #general');
    db.prepare('UPDATE warnings SET date = ? WHERE guild_id = ? AND user_id = ?')
        .run(new Date(base + DAY).toISOString(), guildId, userId);

    createCase(guildId, userId, 'mod1', 'Mod#0001', 'ban', 'raiding');
    db.prepare('UPDATE mod_cases SET created_at = ? WHERE guild_id = ? AND user_id = ?')
        .run(base + 2 * DAY, guildId, userId);

    addNote(guildId, userId, 'mod1', 'Mod#0001', 'watch this one');
    db.prepare('UPDATE staff_notes SET created_at = ? WHERE guild_id = ? AND target_user_id = ?')
        .run(base + 3 * DAY, guildId, userId);

    createReport(guildId, 'reporter1', 'Reporter#1', userId, 'Target#1', 'harassment');
    db.prepare('UPDATE reports SET created_at = ? WHERE guild_id = ? AND target_id = ?')
        .run(base + 4 * DAY, guildId, userId);

    createBanAppeal(guildId, userId, 'Target#1', 'unfair', 'I was not raiding');
    db.prepare('UPDATE ban_appeals SET created_at = ? WHERE guild_id = ? AND user_id = ?')
        .run(base + 5 * DAY, guildId, userId);

    db.prepare(`INSERT INTO tickets (id, guild_id, ticket_number, channel_id, creator_id, creator_tag,
        panel_type_name, status, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run('t-' + guildId, guildId, 7, 'ch-' + guildId, userId, 'Target#1', 'Support', 'closed', 'Cannot verify email', base + 6 * DAY);

    db.prepare('INSERT INTO temp_bans (user_id, guild_id, reason, banned_at, unban_at) VALUES (?, ?, ?, ?, ?)')
        .run(userId, guildId, 'ban evasion', base + 2 * DAY, base + 30 * DAY);
}

function kinds(file) {
    return file.timeline.map((e) => e.kind);
}

// ──────────────────── Composition ────────────────────

test('the file composes every system into one timeline, newest first', () => {
    seedEverySystem();

    // The injected clock keeps the fixture's temp ban in force, so "is this ban
    // still running" is a real answer rather than an artefact of when the suite
    // runs.
    const file = getMemberFile(GUILD, USER, { now: T0 + 7 * DAY });

    assert.deepStrictEqual(file.errors, [], 'a healthy read names no failures');
    // A temp ban and its case are written in the same instant, so the case wins
    // that tie (KIND_RANK) and the temp ban row sits next to it.
    assert.deepStrictEqual(
        kinds(file),
        ['ticket', 'appeal', 'report', 'note', 'case', 'tempban', 'warning'],
        'newest first, with the temp ban ordered by its ban date'
    );

    // Every entry carries the four things a surface needs to render it.
    for (const entry of file.timeline) {
        assert.ok(entry.kind && typeof entry.kind === 'string', 'kind');
        assert.ok(Number.isFinite(entry.at) && entry.at > 0, 'timestamp for ' + entry.kind);
        assert.ok(entry.title, 'title for ' + entry.kind);
        assert.ok('detail' in entry, 'detail for ' + entry.kind);
    }

    const ticket = file.timeline[0];
    assert.strictEqual(ticket.title, 'Ticket #7 (Support)');
    assert.strictEqual(file.timeline[1].title, 'Ban appeal — pending');
    assert.strictEqual(file.timeline[4].caseNumber, 1, 'cases keep their case number');
    assert.strictEqual(file.timeline[4].actor, 'Mod#0001');

    // The per-system sections are the same rows, so the screens that already
    // render lists do not need a second code path.
    assert.strictEqual(file.sections.warnings.length, 1);
    assert.strictEqual(file.sections.cases[0].actionType, 'ban');
    assert.strictEqual(file.sections.notes[0].note, 'watch this one');
    assert.strictEqual(file.sections.reports[0].status, 'pending');
    assert.strictEqual(file.sections.appeals[0].status, 'pending');
    assert.strictEqual(file.sections.tickets[0].ticketNumber, 7);
    assert.strictEqual(file.sections.tempBan.expired, false);
});

test('the order is stable when two entries share a timestamp', () => {
    seedEverySystem();
    const db = getDb();
    // Force everything onto one millisecond.
    db.prepare('UPDATE mod_cases SET created_at = ?').run(T0);
    db.prepare('UPDATE staff_notes SET created_at = ?').run(T0);
    db.prepare('UPDATE reports SET created_at = ?').run(T0);
    db.prepare('UPDATE ban_appeals SET created_at = ?').run(T0);
    db.prepare('UPDATE tickets SET created_at = ?').run(T0);
    db.prepare('UPDATE warnings SET date = ?').run(new Date(T0).toISOString());
    db.prepare('UPDATE temp_bans SET banned_at = ?').run(T0);

    const first = kinds(getMemberFile(GUILD, USER));
    const second = kinds(getMemberFile(GUILD, USER));
    assert.deepStrictEqual(first, second, 'two reads of the same rows agree');
    assert.deepStrictEqual(first, ['case', 'warning', 'tempban', 'note', 'report', 'appeal', 'ticket']);
});

test('summaries carry true totals while the timeline is capped', () => {
    for (let i = 0; i < 4; i++) {
        createCase(GUILD, USER, 'mod1', 'Mod#0001', 'warn', 'reason ' + i);
    }

    const file = getMemberFile(GUILD, USER, { limit: 2 });

    assert.strictEqual(file.summaries.cases.total, 4, 'the count is what is on record');
    assert.strictEqual(file.summaries.cases.loaded, 2, 'the list is what was read');
    assert.strictEqual(file.timeline.filter((e) => e.kind === 'case').length, 2);
    assert.strictEqual(file.truncated, true, 'and the caller is told rows were hidden');

    // Exactly `limit` rows is a complete list, not a truncated one — the flag
    // must not cry wolf on a member whose history happens to end on the cap.
    const exact = getMemberFile(GUILD, USER, { limit: 4 });
    assert.strictEqual(exact.summaries.cases.loaded, 4);
    assert.strictEqual(exact.truncated, false);
});

test('an empty history is an empty file, not an error', () => {
    const file = getMemberFile(GUILD, 'never-seen-this-one');

    assert.deepStrictEqual(file.errors, []);
    assert.deepStrictEqual(file.timeline, []);
    assert.deepStrictEqual(file.activePunishments, []);
    assert.strictEqual(file.summaries.cases.total, 0);
    for (const key of ['warnings', 'cases', 'notes', 'reports', 'appeals', 'tickets']) {
        assert.strictEqual(file.summaries[key].total, 0, key + ' is reported as zero, not as missing');
    }
    assert.strictEqual(file.truncated, false);
});

test('a missing guild or member id yields an empty file instead of throwing', () => {
    for (const [guild, user] of [[null, USER], [GUILD, null], [null, null], ['', '']]) {
        const file = getMemberFile(guild, user);
        assert.deepStrictEqual(file.timeline, []);
        assert.deepStrictEqual(file.errors, []);
        assert.strictEqual(file.guildId, guild || null);
    }
});

// ──────────────────── Isolation ────────────────────

test('every read is scoped to one guild', () => {
    // The same member id exists in both guilds with different records. The only
    // thing separating them is the guild the file was asked for.
    seedEverySystem('g1', USER, 0);
    seedEverySystem('g2', USER, 100 * DAY);

    const one = getMemberFile('g1', USER);
    const two = getMemberFile('g2', USER);

    assert.strictEqual(one.sections.cases.length, 1);
    assert.strictEqual(one.sections.cases[0].reason, 'raiding');
    assert.strictEqual(one.sections.notes[0].note, 'watch this one');
    assert.strictEqual(one.sections.tickets[0].id, 't-g1');
    assert.strictEqual(two.sections.tickets[0].id, 't-g2');

    assert.deepStrictEqual(
        one.timeline.map((e) => e.at).filter((at) => at > T0 + 50 * DAY),
        [],
        "guild 2's newer rows never leak into guild 1"
    );

    // A member id that only exists in the other guild is simply not on file.
    const stranger = getMemberFile('g1', 'u-only-in-g2');
    assert.deepStrictEqual(stranger.timeline, []);
});

// ──────────────────── A failing source ────────────────────

test('a failing source is named, logged, and the rest of the file still renders', () => {
    seedEverySystem();
    const db = getDb();
    db.exec('ALTER TABLE reports RENAME TO reports_hidden');
    try {
        const file = getMemberFile(GUILD, USER);

        assert.deepStrictEqual(file.errors, ['reports'], 'the caller can say which section is missing');
        assert.deepStrictEqual(file.summaries.reports, { total: 0, pending: 0 });
        assert.ok(file.timeline.some((e) => e.kind === 'case'), 'the other systems still render');
        assert.ok(file.timeline.some((e) => e.kind === 'note'));
        assert.ok(
            getErrorLogs(50, 'memberFile').some((r) => /no such table/i.test(String(r.message || ''))),
            'the failure reaches the error log rather than being swallowed'
        );
    } finally {
        db.exec('ALTER TABLE reports_hidden RENAME TO reports');
    }

    // And once the table is back, the file is whole again.
    assert.deepStrictEqual(getMemberFile(GUILD, USER).errors, []);
});

// ──────────────────── Active punishments ────────────────────

test('active punishments combine open cases with a pending temp ban', () => {
    const db = getDb();
    createCase(GUILD, USER, 'mod1', 'Mod#0001', 'timeout', 'cooling off');
    const ban = createCase(GUILD, USER, 'mod1', 'Mod#0001', 'ban', 'raiding');
    const closed = createCase(GUILD, USER, 'mod1', 'Mod#0001', 'warn', 'settled');
    db.prepare('UPDATE mod_cases SET active = 0 WHERE case_number = ?').run(closed.case_number);
    db.prepare('UPDATE mod_cases SET active = 1 WHERE case_number IN (?, ?)').run(ban.case_number, ban.case_number - 1);
    const until = T0 + 10 * DAY;
    db.prepare('INSERT INTO temp_bans (user_id, guild_id, reason, banned_at, unban_at) VALUES (?, ?, ?, ?, ?)')
        .run(USER, GUILD, 'ban evasion', T0, until);

    // The clock is injected so a temp ban that is genuinely still running is
    // not read as expired just because the fixture lives in the past.
    const file = getMemberFile(GUILD, USER, { now: T0 + 5 * DAY });

    const types = file.activePunishments.map((p) => p.type).sort();
    assert.deepStrictEqual(types, ['ban', 'timeout'], 'the warn that was lifted is not an active punishment');
    const tempBan = file.activePunishments.find((p) => p.type === 'ban');
    assert.strictEqual(tempBan.until, until, 'the temp ban adds its exact expiry to the case');
    assert.strictEqual(file.activePunishments.length, 2, 'one ban, not a ban and a duplicate temp ban');
});

// ──────────────────── The /memberfile command ────────────────────

function commandInteraction(user) {
    const calls = { reply: [] };
    return {
        commandName: 'memberfile',
        guild: { id: GUILD, name: 'Test Guild', iconURL: () => null },
        user: { id: 'owner-user', tag: 'Owner#0001' },
        options: { getUser: () => user },
        reply: async (opts) => { calls.reply.push(opts); },
        __calls: calls,
    };
}

const TARGET = { id: USER, tag: 'Target#0001', username: 'Target', displayAvatarURL: () => null };

function fieldValue(embed, needle) {
    const field = (embed.fields || []).find((f) => f.name.indexOf(needle) !== -1);
    return field ? field.value : null;
}

test('/memberfile replies privately with the whole file', async () => {
    seedEverySystem();
    const interaction = commandInteraction(TARGET);

    await executeMemberFile(interaction);

    assert.strictEqual(interaction.__calls.reply.length, 1);
    const reply = interaction.__calls.reply[0];
    assert.strictEqual(reply.ephemeral, true, 'staff notes cannot be posted into the channel');

    const embed = reply.embeds[0].data;
    assert.match(embed.title, /Target#0001/);
    assert.match(embed.description, /\*\*1\*\* warning/);
    assert.match(embed.description, /\*\*1\*\* case/);
    assert.match(embed.description, /\*\*1\*\* ticket/);
    assert.match(embed.footer.text, /Staff only/);

    const activity = fieldValue(embed, 'Recent activity');
    assert.ok(activity, 'the timeline is rendered');
    assert.match(activity, /watch this one/, 'a staff note reaches the staff view');
    assert.match(activity, /ban case #1/);
    assert.match(activity, /Ticket #7/);
    assert.ok(!activity.includes('👢 kick'), 'nothing that did not happen is shown');

    // The pending appeal and report are called out rather than left to be found
    // in the timeline.
    assert.match(fieldValue(embed, 'Open items'), /\*\*1\*\* ban appeal\(s\) pending/);
    assert.match(fieldValue(embed, 'Open items'), /\*\*1\*\* report\(s\) pending/);
});

test('/memberfile says so when there is nothing on file', async () => {
    const interaction = commandInteraction({ id: 'u-clean', tag: 'Clean#0001', displayAvatarURL: () => null });

    await executeMemberFile(interaction);

    const embed = interaction.__calls.reply[0].embeds[0].data;
    assert.ok(fieldValue(embed, 'Nothing on file'));
    assert.strictEqual(fieldValue(embed, 'Recent activity'), null);
    assert.match(embed.description, /\*\*0\*\* warning/);
});

test('/memberfile is refused for a staff member with no grant', async () => {
    const replies = [];
    const interaction = {
        commandName: 'memberfile',
        guild: { id: GUILD },
        user: { id: 'random-staff' },
        reply: async (opts) => { replies.push(opts); },
    };

    assert.strictEqual(ownerGuard(interaction), false, 'no owner, no grant, no file');
    assert.strictEqual(replies.length, 1, 'the refusal is the only thing they get');
    assert.match(replies[0].content, /don't have permission/i);
    assert.strictEqual(replies[0].ephemeral, true);
    assert.strictEqual(replies[0].embeds, undefined, 'a refusal carries no member data');

    // A /perm grant is what opens it, exactly as for every other staff command.
    grantPermission(GUILD, 'memberfile', 'random-staff');
    assert.strictEqual(ownerGuard({ ...interaction, reply: async () => {} }), true);

    // And the registry/policy pairing that keeps it out of a member's picker.
    assert.strictEqual(typeof commandRegistry.memberfile, 'function');
    assert.ok(MODERATION_COMMANDS.has('memberfile'), 'classified as moderation');
    assert.strictEqual(permissionFor('memberfile'), PermissionFlagsBits.ModerateMembers);
});

// ──────────────────── The dashboard profile route ────────────────────

// The member profile route predates the member file: the vanilla pane reads
// member / warnings / notes / cases / invites. Those fields must survive
// untouched, and memberFile has to arrive alongside them.
async function withDashboard(guilds, run) {
    setDashboardClient({
        guilds: { cache: new Map(guilds.map((g) => [g.id, g])) },
        user: null,
        ws: { ping: 1 },
    }, 'test-password');

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
                try { json = JSON.parse(data); } catch { /* non-JSON responses */ }
                resolve({ status: res.statusCode, headers: res.headers, body: json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });

    try {
        return await run({ call, port });
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
}

function dashGuild(id) {
    const member = {
        id: USER,
        displayName: 'Target',
        joinedTimestamp: T0,
        user: { id: USER, tag: 'Target#0001', username: 'Target', bot: false, displayAvatarURL: () => null },
    };
    return {
        id,
        name: 'Test Guild',
        iconURL: () => null,
        memberCount: 3,
        members: { cache: new Map([[USER, member]]) },
    };
}

async function login(call) {
    const res = await call('POST', '/api/login', { password: 'test-password' });
    assert.strictEqual(res.status, 200);
    return String(res.headers['set-cookie'][0]).split(';')[0];
}

test('the profile route keeps its legacy fields and adds the member file', async () => {
    seedEverySystem();

    await withDashboard([dashGuild(GUILD)], async ({ call }) => {
        const anon = await call('GET', '/api/server/' + GUILD + '/member/' + USER + '/profile');
        assert.strictEqual(anon.status, 403, 'the fail-closed tenant guard runs first');

        const cookie = await login(call);
        const res = await call('GET', '/api/server/' + GUILD + '/member/' + USER + '/profile', undefined, cookie);

        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(
            Object.keys(res.body).sort(),
            ['cases', 'invites', 'member', 'memberFile', 'notes', 'warnings'],
            'the legacy fields are all still there, plus memberFile'
        );

        // Legacy shapes, field for field.
        assert.strictEqual(res.body.member.tag, 'Target#0001');
        assert.strictEqual(res.body.warnings[0].reason, 'spamming in #general');
        assert.strictEqual(res.body.warnings[0].moderator, 'Mod#0001');
        assert.ok(res.body.warnings[0].date);
        assert.strictEqual(res.body.notes[0].authorTag, 'Mod#0001');
        assert.strictEqual(res.body.notes[0].note, 'watch this one');
        assert.ok(res.body.notes[0].createdAt);
        assert.strictEqual(res.body.cases[0].caseNumber, 1);
        assert.strictEqual(res.body.cases[0].actionType, 'ban');
        assert.strictEqual(res.body.cases[0].moderatorTag, 'Mod#0001');
        assert.strictEqual(res.body.cases[0].active, true);
        assert.ok(res.body.cases[0].createdAt);
        assert.ok(res.body.invites);

        // The new field is the composed file the React screen renders.
        assert.strictEqual(res.body.memberFile.timeline.length, 7);
        assert.strictEqual(res.body.memberFile.summaries.tickets.total, 1);
        assert.strictEqual(res.body.memberFile.summaries.appeals.pending, 1);
        assert.deepStrictEqual(res.body.memberFile.errors, []);
    });
});

test('an unknown guild is answered as unknown, not as an empty member', async () => {
    await withDashboard([dashGuild(GUILD)], async ({ call }) => {
        const cookie = await login(call);
        const res = await call('GET', '/api/server/no-such-guild/member/' + USER + '/profile', undefined, cookie);
        assert.strictEqual(res.status, 404);
        assert.match(String(res.body && res.body.error), /not found/i);
    });
});

test('a scoped dashboard user cannot read another server member file', async () => {
    seedEverySystem();
    const other = dashGuild('g-other');

    await withDashboard([dashGuild(GUILD), other], async ({ call }) => {
        const { accessToken } = addDashUser('scoped-member-file', 'test');
        getDb().prepare("INSERT OR REPLACE INTO dash_user_guilds (user_id, guild_id, granted_at) VALUES ('scoped-member-file', ?, 1)")
            .run(GUILD);

        const loginRes = await call('POST', '/api/login', { discordId: 'scoped-member-file', accessToken });
        assert.strictEqual(loginRes.status, 200);
        const cookie = String(loginRes.headers['set-cookie'][0]).split(';')[0];

        const granted = await call('GET', '/api/server/' + GUILD + '/member/' + USER + '/profile', undefined, cookie);
        assert.strictEqual(granted.status, 200, 'the granted server opens');
        assert.strictEqual(granted.body.memberFile.timeline.length, 7);

        const blocked = await call('GET', '/api/server/g-other/member/' + USER + '/profile', undefined, cookie);
        assert.strictEqual(blocked.status, 403, 'an ungranted server stays closed');
        assert.strictEqual(blocked.body.error, 'You do not have access to this server');
        assert.strictEqual(blocked.body.memberFile, undefined, 'and leaks no file');
    });
});

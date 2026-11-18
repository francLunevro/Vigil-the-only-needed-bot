// Moderation DM receipts (src/modDm.js).
//
// Two things are being pinned here. First, what the member is told: the action,
// the reason, the case number and how to appeal. Second — and this is the part
// that matters more — that telling them is incapable of breaking the punishment:
// a closed DM, a blocked bot or a Discord outage must leave the kick, ban,
// timeout or warning exactly as it would have been, and must be recorded
// somewhere a human can find it rather than swallowed.
//
// The call sites are covered through their real surfaces (/warn, the warn modal,
// the kick/ban/temp-ban confirm buttons, the automatic threshold punishment and
// the dashboard's mod route), because "the helper works" is not the same claim
// as "every punishment path sends a receipt".
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-dm-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');
process.env.OWNER_ID = 'owner1';

const { getDb, closeDb, getErrorLogs, clearErrorLogs } = require('../src/db');
const { setErrorListener } = require('../src/logError');
const modDm = require('../src/modDm');
const { executeWarn, executeTimeout } = require('../src/commands/moderation');
const { handleConfirmKick, handleConfirmBan, handleConfirmTempBan, handleWarnSubmit } = require('../src/interactions/moderation');
const { addThreshold, checkThresholds } = require('../src/warningThresholds');
const { addWarning } = require('../src/warnings');
const { getCases } = require('../src/modCases');
const { updateGuildConfig } = require('../src/config');

after(() => {
    try { closeDb(); } catch { /* already closed */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

beforeEach(() => {
    clearErrorLogs();
    getDb().prepare('DELETE FROM warnings').run();
    getDb().prepare('DELETE FROM mod_cases').run();
    getDb().prepare('DELETE FROM mod_case_counters').run();
    getDb().prepare('DELETE FROM temp_bans').run();
    getDb().prepare('DELETE FROM warning_thresholds').run();
    // Receipts are stored per guild, so a test that switches them off for g1
    // would silently disarm every later test on that guild. Reset to defaults.
    updateGuildConfig('g1', (cfg) => { cfg.modDmConfig = {}; return cfg; });
});

// ──────────────────── Fakes ────────────────────

function makeTargetUser(id = 'target1') {
    const sent = [];
    return {
        id,
        tag: 'Target#' + id,
        username: 'Target',
        bot: false,
        sent,
        toString: () => '<@' + id + '>',
        displayAvatarURL: () => 'https://cdn.example/a.png',
        send: async (payload) => { sent.push(payload); },
    };
}

function makeMember(user, extra = {}) {
    const kicks = [];
    const timeouts = [];
    const member = Object.assign({
        id: user.id,
        user,
        kickable: true,
        bannable: true,
        moderatable: true,
        permissions: { has: () => false },
        joinedTimestamp: Date.now() - 86400000,
        roles: { cache: { has: () => false, keys: () => [].values() }, highest: { position: 10 } },
        kick: async (reason) => { kicks.push(reason); },
        timeout: async (ms, reason) => { timeouts.push({ ms, reason }); },
        __kicks: kicks,
        __timeouts: timeouts,
    }, extra);
    return member;
}

// The server-detail endpoint counts channels per type through
// `channels.cache.filter(...)`, a Collection method a bare Map doesn't have.
// These tests only need the detail route to answer, not to count anything.
function fakeChannelCache() {
    const map = new Map();
    map.filter = () => ({ size: 0, map: () => [] });
    map.map = () => [];
    return map;
}

function makeGuild({ id = 'g1', name = 'Test Guild', target = null } = {}) {
    const members = new Map();
    if (target) members.set(target.id, makeMember(target));

    const bans = [];
    const fetches = { users: 0, members: 0 };
    const guild = {
        id,
        name,
        ownerId: 'owner1',
        iconURL: () => null,
        members: {
            me: { id: 'BOTID', permissions: { has: () => true }, roles: { highest: { position: 100 } } },
            fetch: async (uid) => { fetches.members++; return members.get(uid) || null; },
            cache: { get: (uid) => members.get(uid) || null },
        },
        bans: { create: async (uid, opts) => { bans.push({ userId: uid, opts }); } },
        channels: { cache: fakeChannelCache() },
        roles: { cache: new Map(), everyone: { id: 'everyone' } },
        __members: members,
        __bans: bans,
        __fetches: fetches,
    };
    guild.client = {
        users: {
            fetch: async (uid) => {
                fetches.users++;
                if (target && target.id === uid) return target;
                const err = new Error('Unknown User');
                err.code = 10013;
                throw err;
            },
        },
        guilds: { cache: new Map([[id, guild]]) },
        channels: { cache: fakeChannelCache() },
    };
    return guild;
}

function makeInteraction({ guild, userId = 'owner1', target = null, reason = null, duration = null } = {}) {
    const calls = { reply: [], update: [], followUp: [] };
    return {
        commandName: 'moderation',
        guild,
        client: guild.client,
        user: { id: userId, tag: 'Mod#0001', toString: () => '<@' + userId + '>' },
        member: { id: userId, roles: { highest: { position: 90 } } },
        channel: { id: 'chan1', isTextBased: () => true },
        message: { id: 'panel-1', embeds: [{ title: 'Confirm', color: 0xE74C3C, fields: [{ name: 'Reason', value: reason || 'No reason provided' }] }], components: [] },
        options: {
            getSubcommand: () => null,
            getUser: () => target,
            getString: (n) => (n === 'reason' ? reason : (n === 'duration' ? duration : null)),
            getInteger: () => null,
            getChannel: () => null,
            getRole: () => null,
        },
        fields: { getTextInputValue: () => reason },
        reply: async (o) => { calls.reply.push(o); },
        update: async (o) => { calls.update.push(o); },
        followUp: async (o) => { calls.followUp.push(o); },
        __calls: calls,
    };
}

// Every DM that left the bot in a test, flattened to what we assert on.
function dmTitles(target) {
    return target.sent.map((payload) => {
        const embed = payload.embeds && payload.embeds[0];
        return embed ? embed.data.title : null;
    });
}

function dmField(target, index, fieldName) {
    const embed = target.sent[index].embeds[0].data;
    const field = (embed.fields || []).find((f) => f.name === fieldName);
    return field ? field.value : null;
}

function errorLogMessages(tag) {
    return getErrorLogs(50, tag).map((r) => r.message);
}

// ──────────────────── The receipt itself ────────────────────

test('the receipt carries the action, reason, case number and appeal route', () => {
    const guild = { id: 'g1', name: 'EU | Dying Light' };
    const embed = modDm.buildPunishmentDm({
        guild,
        action: 'kick',
        reason: 'spamming in #general',
        caseNumber: 12,
    }).data;

    assert.strictEqual(embed.title, '👢 You were kicked');
    assert.strictEqual(embed.color, 0xE74C3C);
    assert.match(embed.description, /EU \| Dying Light/);
    assert.strictEqual(embed.fields.find((f) => f.name === 'Reason').value, 'spamming in #general');
    assert.strictEqual(embed.fields.find((f) => f.name === 'Case').value, '#12');
    assert.strictEqual(embed.fields.find((f) => f.name === 'Appeal').value, modDm.DEFAULT_APPEAL_TEXT);
    assert.match(embed.footer.text, /Case #12/);
});

test('each action gets its own title and wording', () => {
    const titles = {};
    for (const action of ['warn', 'timeout', 'kick', 'ban', 'tempban']) {
        const embed = modDm.buildPunishmentDm({ guild: { name: 'G' }, action, reason: 'r' }).data;
        titles[action] = embed.title;
    }
    assert.strictEqual(titles.warn, '⚠️ Warning received');
    assert.strictEqual(titles.timeout, '⏱️ You were timed out');
    assert.strictEqual(titles.ban, '🔨 You were banned');
    assert.strictEqual(titles.tempban, '🔨 You were temporarily banned');
    assert.strictEqual(new Set(Object.values(titles)).size, 5, 'every action reads differently');
});

test('a missing case row says so instead of pretending there is a number', () => {
    const embed = modDm.buildPunishmentDm({ guild: { name: 'G' }, action: 'ban', reason: 'r', caseNumber: null }).data;
    assert.strictEqual(embed.fields.find((f) => f.name === 'Case').value, 'Not recorded');
});

test('duration is shown with its end time, and only when there is one', () => {
    const expiresAt = Date.now() + 3600000;
    const timed = modDm.buildPunishmentDm({
        guild: { name: 'G' }, action: 'timeout', reason: 'r', durationLabel: '1 hour', expiresAt,
    }).data;
    const duration = timed.fields.find((f) => f.name === 'Duration');
    assert.ok(duration, 'a timeout must say how long');
    assert.match(duration.value, /1 hour/);
    assert.match(duration.value, /<t:\d+:R>/, 'the member should see when it lifts');

    const permanent = modDm.buildPunishmentDm({ guild: { name: 'G' }, action: 'kick', reason: 'r' }).data;
    assert.strictEqual(permanent.fields.find((f) => f.name === 'Duration'), undefined);
});

test('the reason is sanitized for a DM and clipped to the field limit', () => {
    const embed = modDm.buildPunishmentDm({
        guild: { name: 'G' },
        action: 'warn',
        reason: '<@123> @everyone ' + 'x'.repeat(2000),
    }).data;
    const reason = embed.fields.find((f) => f.name === 'Reason').value;
    assert.ok(!reason.includes('<@123>'), 'mentions are stripped before a DM');
    assert.ok(!/(^|\s)@everyone/.test(reason), '@everyone is defused');
    assert.ok(reason.length <= 1024, 'field values must fit the embed limit');
});

test('an empty reason still reads as a sentence', () => {
    const embed = modDm.buildPunishmentDm({ guild: { name: 'G' }, action: 'warn', reason: '' }).data;
    assert.strictEqual(embed.fields.find((f) => f.name === 'Reason').value, 'No reason provided');
});

test('the guild\'s own appeal instructions replace the default, clipped to 500', () => {
    const long = 'Appeal at ' + 'https://example.com/'.repeat(60);
    const embed = modDm.buildPunishmentDm({
        guild: { name: 'G' }, action: 'ban', reason: 'r', appealInfo: long,
    }).data;
    const appeal = embed.fields.find((f) => f.name === 'Appeal').value;
    assert.match(appeal, /^Appeal at https:\/\/example\.com\//);
    assert.ok(appeal.length <= 500, 'the appeal line is capped at 500 characters');
});

// ──────────────────── Config ────────────────────

test('receipts default to on, with no configured appeal text', () => {
    assert.deepStrictEqual(modDm.getModDmConfig('g-never-configured'), { enabled: true, appealInfo: null });
});

test('the toggle and the appeal text round-trip through guild_config', () => {
    const saved = modDm.setModDmConfig('g1', { enabled: false, appealInfo: '  appeal here  ' });
    assert.deepStrictEqual(saved, { enabled: false, appealInfo: 'appeal here' });
    assert.deepStrictEqual(modDm.getModDmConfig('g1'), { enabled: false, appealInfo: 'appeal here' });

    // A whitespace-only appeal is the same as none at all.
    modDm.setModDmConfig('g1', { appealInfo: '   ' });
    assert.deepStrictEqual(modDm.getModDmConfig('g1'), { enabled: false, appealInfo: null });

    // Turning it back on doesn't lose the text.
    modDm.setModDmConfig('g1', { enabled: true, appealInfo: 'appeal here' });
    assert.deepStrictEqual(modDm.getModDmConfig('g1'), { enabled: true, appealInfo: 'appeal here' });
});

test('junk in the stored config cannot produce a broken receipt', () => {
    assert.deepStrictEqual(modDm.normalizeModDmConfig(null), { enabled: true, appealInfo: null });
    assert.deepStrictEqual(modDm.normalizeModDmConfig('nonsense'), { enabled: true, appealInfo: null });
    assert.deepStrictEqual(modDm.normalizeModDmConfig({ appealInfo: 42 }), { enabled: true, appealInfo: null });
    assert.deepStrictEqual(
        modDm.normalizeModDmConfig({ appealInfo: 'x'.repeat(900) }).appealInfo.length,
        500,
    );
});

test('a corrupt stored config falls back to receipts on', () => {
    // A malformed column value makes getGuildConfig() throw on JSON.parse; the
    // read is caught and the fallback is "on", because failing open here only
    // ever sends one extra DM.
    getDb().prepare('INSERT OR REPLACE INTO guild_config (guild_id, mod_dm_config) VALUES (?, ?)').run('g-broken', 'not json');

    assert.deepStrictEqual(modDm.getModDmConfig('g-broken'), { enabled: true, appealInfo: null });
    const logged = getErrorLogs(50, 'modDm').some((r) => String(r.extra || '').includes('config_read'));
    assert.ok(logged, 'and the reason it fell back is recorded');
});

// ──────────────────── Sending, and failing to send ────────────────────

test('a successful send reports delivery', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });

    const result = await modDm.sendPunishmentDm({
        guild, user: target, action: 'warn', reason: 'spam', caseNumber: 3,
    });

    assert.deepStrictEqual(result, { delivered: true, reason: null });
    assert.deepStrictEqual(dmTitles(target), ['⚠️ Warning received']);
    assert.strictEqual(dmField(target, 0, 'Case'), '#3');
});

test('a closed DM is recorded as a warning, never as an incident', async () => {
    const notified = [];
    setErrorListener((info) => notified.push(info.tag));

    const target = makeTargetUser();
    target.send = async () => {
        const err = new Error('Cannot send messages to this user');
        err.code = 50007;
        throw err;
    };
    const guild = makeGuild({ target });

    const result = await modDm.sendPunishmentDm({ guild, user: target, action: 'kick', reason: 'r', caseNumber: 1 });

    assert.deepStrictEqual(result, { delivered: false, reason: 'blocked' });
    assert.ok(errorLogMessages('modDm').some((m) => /not delivered/.test(m)), 'the refusal is recorded');
    assert.ok(!notified.includes('modDm'), 'a closed DM must not fire the error alert channel');
});

test('an unexpected failure is an error, and does fire the alert', async () => {
    const notified = [];
    setErrorListener((info) => notified.push(info.tag));

    const target = makeTargetUser();
    target.send = async () => { throw new Error('socket hang up'); };
    const guild = makeGuild({ target });

    const result = await modDm.sendPunishmentDm({ guild, user: target, action: 'ban', reason: 'r' });

    assert.deepStrictEqual(result, { delivered: false, reason: 'error' });
    assert.ok(errorLogMessages('modDm').length >= 1, 'the failure is recorded');
    assert.ok(notified.includes('modDm'), 'a real failure still reaches the alert path');
});

test('the toggle switches receipts off without touching anything else', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });
    modDm.setModDmConfig(guild.id, { enabled: false });

    const result = await modDm.sendPunishmentDm({ guild, user: target, action: 'warn', reason: 'r' });

    assert.deepStrictEqual(result, { delivered: false, reason: 'disabled' });
    assert.strictEqual(target.sent.length, 0);
});

test('a user id is resolved when the caller only has one', async () => {
    const target = makeTargetUser('resolve-me');
    const guild = makeGuild({ target });

    const result = await modDm.sendPunishmentDm({
        guild, userId: 'resolve-me', action: 'ban', reason: 'r', caseNumber: 9,
    });

    assert.strictEqual(result.delivered, true);
    assert.strictEqual(guild.__fetches.users, 1);
    assert.strictEqual(dmField(target, 0, 'Case'), '#9');
});

test('an unresolvable user is recorded and skipped, not thrown', async () => {
    const guild = makeGuild({ target: null });

    const result = await modDm.sendPunishmentDm({ guild, userId: 'ghost', action: 'ban', reason: 'r' });

    assert.deepStrictEqual(result, { delivered: false, reason: 'no-user' });
    assert.ok(errorLogMessages('modDm').length >= 1);
});

test('the helper never throws, whatever it is handed', async () => {
    assert.deepStrictEqual(await modDm.sendPunishmentDm(), { delivered: false, reason: 'no-guild' });
    assert.deepStrictEqual(await modDm.sendPunishmentDm({}), { delivered: false, reason: 'no-guild' });

    // A guild whose fetch machinery explodes must still resolve to a result.
    const hostileGuild = {
        id: 'g-hostile',
        get client() { throw new Error('client exploded'); },
    };
    const result = await modDm.sendPunishmentDm({ guild: hostileGuild, userId: 'x', action: 'ban' });
    assert.strictEqual(result.delivered, false);
});

test('blocked-DM detection covers the error code and the message', () => {
    assert.strictEqual(modDm.isDmBlocked({ code: 50007 }), true);
    assert.strictEqual(modDm.isDmBlocked(new Error('Cannot send messages to this user')), true);
    assert.strictEqual(modDm.isDmBlocked(new Error('Missing Permissions')), false);
    assert.strictEqual(modDm.isDmBlocked(null), false);
});

// ──────────────────── The real punishment surfaces ────────────────────

test('/warn DMs the member with the case number', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });
    const interaction = makeInteraction({ guild, target, reason: 'being rude' });

    await executeWarn(interaction);

    assert.strictEqual(target.sent.length, 1, 'the warned member is told');
    assert.strictEqual(dmTitles(target)[0], '⚠️ Warning received');
    assert.strictEqual(dmField(target, 0, 'Reason'), 'being rude');
    assert.strictEqual(dmField(target, 0, 'Case'), '#1', 'the case number the staff log shows');
    assert.ok(interaction.__calls.reply.length >= 1, 'the moderator still gets their confirmation');

    const cases = getCases(guild.id, target.id, 10);
    assert.strictEqual(cases.length, 1);
    assert.strictEqual(cases[0].case_number, 1);
});

test('/warn still punishes when the member cannot be DMed', async () => {
    const target = makeTargetUser();
    target.send = async () => { throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }); };
    const guild = makeGuild({ target });
    const interaction = makeInteraction({ guild, target, reason: 'spam' });

    await executeWarn(interaction);

    assert.strictEqual(getCases(guild.id, target.id, 10).length, 1, 'the warning is recorded regardless');
    assert.ok(interaction.__calls.reply.length >= 1, 'and the moderator is told the warning landed');
    assert.strictEqual(target.sent.length, 0);
});

test('the warn modal path DMs too, with the sanitized reason', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });
    const interaction = makeInteraction({ guild, target, reason: 'no u <@123>' });

    await handleWarnSubmit(interaction, ['wr', 'owner1', target.id]);

    assert.strictEqual(target.sent.length, 1);
    assert.match(dmField(target, 0, 'Reason'), /no u/);
    assert.ok(!dmField(target, 0, 'Reason').includes('<@123>'));
    assert.strictEqual(dmField(target, 0, 'Case'), '#1');
});

test('/timeout DMs the duration and when it lifts', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });
    const interaction = makeInteraction({ guild, target, reason: 'cool off', duration: '1h' });

    await executeTimeout(interaction);

    const member = guild.__members.get(target.id);
    assert.strictEqual(member.__timeouts.length, 1, 'the timeout still happened');
    assert.strictEqual(target.sent.length, 1);
    assert.strictEqual(dmTitles(target)[0], '⏱️ You were timed out');
    // formatDuration() is the same compact form the staff log embeds use ('1h'),
    // and the relative timestamp below it humanizes it anyway.
    assert.match(dmField(target, 0, 'Duration'), /^1h — ends <t:\d+:R>$/);
    assert.strictEqual(dmField(target, 0, 'Case'), '#1');
});

test('the kick confirm button DMs after the action, not before', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });
    const interaction = makeInteraction({ guild, target, reason: 'spamming' });

    await handleConfirmKick(interaction, ['ck', 'owner1', target.id]);

    const member = guild.__members.get(target.id);
    assert.deepStrictEqual(member.__kicks, ['spamming'], 'the kick ran');
    assert.strictEqual(interaction.__calls.update.length, 1, 'the moderator saw it complete');
    assert.strictEqual(target.sent.length, 1);
    assert.strictEqual(dmTitles(target)[0], '👢 You were kicked');
    assert.strictEqual(dmField(target, 0, 'Case'), '#1');
});

test('a blocked DM cannot undo a kick', async () => {
    const target = makeTargetUser();
    target.send = async () => { throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 }); };
    const guild = makeGuild({ target });
    const interaction = makeInteraction({ guild, target, reason: 'spamming' });

    await handleConfirmKick(interaction, ['ck', 'owner1', target.id]);

    const member = guild.__members.get(target.id);
    assert.deepStrictEqual(member.__kicks, ['spamming'], 'the kick is not rolled back');
    assert.strictEqual(interaction.__calls.update.length, 1);
    assert.strictEqual(interaction.__calls.update[0].content, undefined, 'and the moderator is not shown an error');
});

test('the ban confirm button DMs the banned member', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });
    const interaction = makeInteraction({ guild, target, reason: 'raiding' });

    await handleConfirmBan(interaction, ['cb', 'owner1', target.id]);

    assert.strictEqual(guild.__bans.length, 1, 'the ban ran');
    assert.strictEqual(target.sent.length, 1);
    assert.strictEqual(dmTitles(target)[0], '🔨 You were banned');
    assert.strictEqual(dmField(target, 0, 'Case'), '#1');
});

test('a temp ban DMs the duration and the auto-unban time', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });
    const interaction = makeInteraction({ guild, target, reason: 'cooling off' });

    await handleConfirmTempBan(interaction, ['ctb', 'owner1', target.id, '7d', '0']);

    const row = getDb().prepare('SELECT * FROM temp_bans WHERE guild_id = ? AND user_id = ?').get(guild.id, target.id);
    assert.ok(row, 'the temp ban is still scheduled');
    assert.strictEqual(dmTitles(target)[0], '🔨 You were temporarily banned');
    assert.match(dmField(target, 0, 'Duration'), /7 days/);
    assert.match(dmField(target, 0, 'Duration'), /<t:\d+:R>/);
    assert.strictEqual(dmField(target, 0, 'Case'), '#1');
});

test('an automatic threshold punishment explains itself too', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });
    addThreshold(guild.id, 1, 'timeout', 5);
    addWarning(guild.id, target.id, 'Mod#0001', 'first strike');

    const result = await checkThresholds(guild, target.id, null);

    assert.match(String(result), /timed out/);
    assert.strictEqual(target.sent.length, 1, 'an automatic punishment must not be silent');
    assert.strictEqual(dmTitles(target)[0], '⏱️ You were timed out');
    assert.match(dmField(target, 0, 'Reason'), /Auto-punish at 1 warnings/);
    assert.match(dmField(target, 0, 'Duration'), /^5m — ends <t:\d+:R>$/);
    assert.strictEqual(dmField(target, 0, 'Case'), '#1');
});

test('a threshold that cannot run sends nothing and changes nothing', async () => {
    const target = makeTargetUser();
    const guild = makeGuild({ target });
    guild.__members.get(target.id).moderatable = false;
    addThreshold(guild.id, 1, 'timeout', 5);
    addWarning(guild.id, target.id, 'Mod#0001', 'first strike');

    const result = await checkThresholds(guild, target.id, null);

    assert.strictEqual(result, null);
    assert.strictEqual(target.sent.length, 0);
    assert.strictEqual(getCases(guild.id, target.id, 10).length, 0);
});

// ──────────────────── The dashboard surface ────────────────────

// Boots the real dashboard app over a real socket with an owner session, so the
// route tests exercise auth, validation and the JSON shapes rather than calling
// handlers directly.
async function withDashboard(guild, run) {
    const { createDashboard, setDashboardClient } = require('../src/dashboard');
    setDashboardClient({
        guilds: { cache: new Map([[guild.id, guild]]) },
        user: null,
        ws: { ping: 1 },
        channels: { cache: new Map() },
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
                try { json = JSON.parse(data); } catch { /* html */ }
                resolve({ status: res.statusCode, headers: res.headers, body: json });
            });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });

    try {
        const login = await call('POST', '/api/login', { password: 'test-password' });
        assert.strictEqual(login.status, 200, 'password login is the owner session');
        const cookie = (login.headers['set-cookie'] || [''])[0].split(';')[0];
        return await run({ call, cookie });
    } finally {
        server.closeAllConnections?.();
        await new Promise((resolve) => server.close(resolve));
    }
}

test('the dashboard mod/warn route sends the same receipt', async () => {
    const target = makeTargetUser('dash-user');
    const guild = makeGuild({ target });

    await withDashboard(guild, async ({ call, cookie }) => {
        const res = await call('POST', '/api/server/' + guild.id + '/mod/warn',
            { userId: target.id, reason: 'from the dashboard' }, cookie);

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(target.sent.length, 1, 'the dashboard warns by DM as well');
        assert.strictEqual(dmTitles(target)[0], '⚠️ Warning received');
        assert.strictEqual(dmField(target, 0, 'Reason'), 'from the dashboard');
        assert.strictEqual(dmField(target, 0, 'Case'), '#1');
    });
});

test('the dashboard settings route turns receipts off and sets the appeal text', async () => {
    const target = makeTargetUser('dash-user-2');
    const guild = makeGuild({ target });

    await withDashboard(guild, async ({ call, cookie }) => {
        const saved = await call('POST', '/api/server/' + guild.id + '/settings',
            { modDm: { enabled: false, appealInfo: 'Appeal in #appeals' } }, cookie);
        assert.strictEqual(saved.status, 200);
        assert.deepStrictEqual(modDm.getModDmConfig(guild.id), { enabled: false, appealInfo: 'Appeal in #appeals' });

        // Off means off, on every surface that shares the helper.
        await call('POST', '/api/server/' + guild.id + '/mod/warn',
            { userId: target.id, reason: 'quiet please' }, cookie);
        assert.strictEqual(target.sent.length, 0, 'a disabled guild gets no receipts');

        // Back on, and the configured appeal text is the one that goes out.
        await call('POST', '/api/server/' + guild.id + '/settings',
            { modDm: { enabled: true } }, cookie);
        await call('POST', '/api/server/' + guild.id + '/mod/warn',
            { userId: target.id, reason: 'quiet please' }, cookie);

        assert.strictEqual(target.sent.length, 1);
        assert.strictEqual(dmField(target, 0, 'Appeal'), 'Appeal in #appeals');

        // Bad input is rejected rather than stored.
        const bad = await call('POST', '/api/server/' + guild.id + '/settings',
            { modDm: { enabled: 'yes' } }, cookie);
        assert.strictEqual(bad.status, 400);
        assert.deepStrictEqual(modDm.getModDmConfig(guild.id), { enabled: true, appealInfo: 'Appeal in #appeals' });

        // The dashboard reads this back from the server detail payload when it
        // arms the settings pane (web/src/screens/ServerDetail.jsx), so the
        // control and the stored config cannot disagree about either field.
        const detail = await call('GET', '/api/server/' + guild.id, undefined, cookie);
        assert.strictEqual(detail.status, 200);
        assert.deepStrictEqual(detail.body.modDm, { enabled: true, appealInfo: 'Appeal in #appeals' });
    });
});

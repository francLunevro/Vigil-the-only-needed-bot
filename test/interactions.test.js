// Tests for the interactions router (src/interactions/) customId parsing paths: the button router
// (initiator security check, moderation confirms, poll votes, ticket buttons,
// temp-VC panel buttons), the modal router (warn submit, ticket feedback,
// transfer/adduser, temp-VC rename/limit) and the select-menu router
// (role menus, ticket type selection).
// Each scenario uses its own guild/message ids so DB rows never collide.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'interactions-test-'));
process.env.DATA_DIR = tmp;

const { closeDb, getDb } = require('../src/db');
const { handleInteraction, endPoll, recordPoll, checkPolls, setPollClient } = require('../src/interactions');
const tickets = require('../src/tickets');
const tv = require('../src/tempVoice');
const { PermissionFlagsBits } = require('discord.js');

after(() => {
    try { closeDb(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

// ──────────────────── Patch helper (manual, restores in finally) ────────────────────

function patch(obj, impls) {
    const originals = {};
    for (const [k, v] of Object.entries(impls)) {
        originals[k] = obj[k];
        obj[k] = v;
    }
    return () => {
        for (const [k, v] of Object.entries(originals)) obj[k] = v;
    };
}

// ──────────────────── Mock factories ────────────────────

const MOD_PERMS = new Set([
    PermissionFlagsBits.KickMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ManageChannels,
]);

function makeGuild(opts = {}) {
    const granted = opts.perms || MOD_PERMS;
    const members = new Map();
    const bans = [];
    let fetchCalls = 0;
    const guild = {
        id: opts.id || 'g1',
        name: 'Test Guild',
        iconURL: () => null,
        ownerId: 'owner1',
        members: {
            me: { id: 'BOTID', permissions: { has: (p) => granted.has(p) } },
            fetch: async (id) => {
                fetchCalls++;
                if (members.has(id)) return members.get(id);
                throw new Error('Unknown Member');
            },
            cache: { get: (id) => members.get(id) || null },
        },
        bans: { create: async (id, o) => { bans.push({ id, opts: o }); } },
        channels: { cache: opts.channelCache || new Map() },
        roles: { everyone: { id: 'everyone-role' } },
    };
    guild.__members = members;
    guild.__bans = bans;
    guild.__fetchCalls = () => fetchCalls;
    return guild;
}

function makeMember(id, extra = {}) {
    const kicks = [];
    return Object.assign({
        id,
        user: { id, username: 'User' + id, tag: 'User' + id + '#0001', displayAvatarURL: () => 'https://cdn.example/a.png' },
        tag: 'User' + id + '#0001',
        kickable: true,
        bannable: true,
        joinedTimestamp: Date.now() - 86400000,
        kick: async (reason) => { kicks.push(reason); },
        roles: { cache: { has: () => false, keys: () => [].values() } },
        __kicks: kicks,
    }, extra);
}

function makeInteraction({ type = 'button', customId, userId = '111', user, messageId = 'm1', embeds = [], components = [], fields, values, guild, member, channel, client }) {
    const calls = { reply: [], update: [], deferUpdate: 0, editReply: [], followUp: [], showModal: [] };
    const u = user || { id: userId, tag: 'Mod#0001', username: 'Mod', toString: () => '<@' + userId + '>', displayAvatarURL: () => 'https://cdn.example/m.png' };
    const interaction = {
        customId,
        user: u,
        member: member !== undefined ? member : { id: userId, user: u, roles: { cache: { has: () => false, keys: () => [].values() } } },
        guild,
        channel,
        client: client || { users: { fetch: async () => { throw new Error('no DM in tests'); } } },
        message: { id: messageId, embeds, components },
        fields: { getTextInputValue: (id) => (fields || {})[id] },
        values,
        isButton: () => type === 'button',
        isModalSubmit: () => type === 'modal',
        isStringSelectMenu: () => type === 'select',
        isUserSelect: () => type === 'userSelect',
        reply: async (o) => { calls.reply.push(o); },
        update: async (o) => { calls.update.push(o); },
        deferUpdate: async () => { calls.deferUpdate++; },
        deferReply: async () => {},
        editReply: async (o) => { calls.editReply.push(o); },
        followUp: async (o) => { calls.followUp.push(o); },
        showModal: async (m) => { calls.showModal.push(m); },
    };
    interaction.__calls = calls;
    return interaction;
}

function buttonOpts(customId) { return { type: 'button', customId }; }
function modalOpts(customId) { return { type: 'modal', customId }; }

// One disabled-look button row usable wherever the code maps message components.
const BTN_ROW = [{ components: [{ type: 2, custom_id: 'x1', label: 'X', style: 1 }] }];

function insertTicket({ id, guildId, channelId, creatorId = 'creator1', status = 'open', number = 1 }) {
    getDb().prepare(`INSERT INTO tickets (id, guild_id, ticket_number, channel_id, creator_id, creator_tag, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, guildId, number, channelId, creatorId, 'Creator#0001', status, Date.now());
}

function insertPollVote(messageId, userId, optionIndex) {
    getDb().prepare('INSERT INTO poll_votes (message_id, user_id, option_index, voted_at) VALUES (?, ?, ?, ?)')
        .run(messageId, userId, optionIndex, Date.now());
}

const POLL_EMBED = [{
    title: 'Poll',
    description: 'Pick one',
    fields: [
        { name: 'Option A', value: '📊 Votes: **0** (0%)', inline: true },
        { name: 'Option B', value: '📊 Votes: **0** (0%)', inline: true },
    ],
}];

// ──────────────────── Router + security ────────────────────

test('button not initiated by the clicker is rejected before any action', async () => {
    const guild = makeGuild();
    const i = makeInteraction({ ...buttonOpts('ck_999_target9'), guild });
    await handleInteraction(i);
    assert.match(i.__calls.reply[0].content, /Only the person who ran this command/);
    assert.strictEqual(guild.__fetchCalls(), 0, 'member fetch must not happen');
});

test('unknown button prefix from the initiator gets the unknown reply', async () => {
    const guild = makeGuild();
    const i = makeInteraction({ ...buttonOpts('zzz_111'), guild });
    await handleInteraction(i);
    assert.strictEqual(i.__calls.reply[0].content, 'Unknown interaction.');
});

test('unknown ticket action gets the ticket-specific error', async () => {
    const guild = makeGuild();
    const i = makeInteraction({ ...buttonOpts('tk_frobnicate_x'), guild });
    await handleInteraction(i);
    assert.match(i.__calls.reply[0].content, /Unknown ticket button/);
});

test('user selects are routed to the user-select handler', async () => {
    const i = makeInteraction({ type: 'userSelect', customId: 'us_1' });
    await handleInteraction(i);
    assert.strictEqual(i.__calls.reply[0].content, 'User selected.');
});

// ──────────────────── Confirm kick (ck_) ────────────────────

test('ck_ parses target, kicks, records case, and updates the embed', async () => {
    const guild = makeGuild();
    guild.__members.set('222', makeMember('222'));
    const i = makeInteraction({
        ...buttonOpts('ck_111_222'),
        guild,
        embeds: [{ title: 'Confirm Kick', description: 'Kick <@222>?', fields: [{ name: 'Reason', value: 'raiding' }] }],
    });
    await handleInteraction(i);
    assert.strictEqual(guild.__members.get('222').__kicks[0], 'raiding');
    assert.match(i.__calls.update[0].embeds[0].data.description, /has been kicked/);        const kase = getDb().prepare("SELECT * FROM mod_cases WHERE action_type = 'kick' AND user_id = '222'").get();
    assert.ok(kase, 'kick case recorded');
});

test('ck_ target no longer in guild gets the gone reply', async () => {
    const guild = makeGuild();
    const i = makeInteraction({ ...buttonOpts('ck_111_999'), guild, embeds: [{ description: 'x' }] });
    await handleInteraction(i);
    assert.match(i.__calls.update[0].content, /no longer in the server/);
});

// ──────────────────── Confirm ban (cb_) ────────────────────

test('cb_ without clear flag bans with deleteMessageSeconds 0', async () => {
    const guild = makeGuild({ id: 'gBan1' });
    const i = makeInteraction({
        ...buttonOpts('cb_111_222'),
        guild,
        embeds: [{ description: 'x', fields: [{ name: 'Reason', value: 'spam' }] }],
    });
    await handleInteraction(i);
    assert.strictEqual(guild.__bans.length, 1);
    assert.strictEqual(guild.__bans[0].id, '222');
    assert.strictEqual(guild.__bans[0].opts.deleteMessageSeconds, 0);
    assert.match(i.__calls.update[0].embeds[0].data.description, /has been banned/);
});

test('cb_ _clear flag strips the suffix from the target and sets 86400', async () => {
    // Regression: this used to parse the target as "222_clear".
    const guild = makeGuild({ id: 'gBan2' });
    const i = makeInteraction({
        ...buttonOpts('cb_111_222_clear'),
        guild,
        embeds: [{ description: 'x', fields: [{ name: 'Reason', value: 'spam' }] }],
    });
    await handleInteraction(i);
    assert.strictEqual(guild.__bans.length, 1);
    assert.strictEqual(guild.__bans[0].id, '222', 'clear suffix must not leak into the target id');
    assert.strictEqual(guild.__bans[0].opts.deleteMessageSeconds, 86400);
});

// ──────────────────── Confirm temp ban (ctb_) ────────────────────

test('ctb_ parses duration + delete seconds and stores the auto-unban row', async () => {
    const guild = makeGuild({ id: 'gTb1' });
    const i = makeInteraction({
        ...buttonOpts('ctb_111_222_7d_3600'),
        guild,
        embeds: [{ description: 'x', fields: [{ name: 'Reason', value: 'test' }] }],
    });
    await handleInteraction(i);
    assert.strictEqual(guild.__bans[0].id, '222');
    assert.match(guild.__bans[0].opts.reason, /^\[Temp Ban 7 days\] test$/);
    assert.strictEqual(guild.__bans[0].opts.deleteMessageSeconds, 3600);
    const row = getDb().prepare("SELECT * FROM temp_bans WHERE user_id = '222' AND guild_id = 'gTb1'").get();
    assert.ok(row, 'temp ban row stored');
    assert.ok(row.unban_at > Date.now() + 6 * 86400000, 'unban ~7 days out');
    assert.match(i.__calls.update[0].embeds[0].data.title, /Temp Banned/);
});

// ──────────────────── Confirm purge (cp_) + cancel ────────────────────

test('cp_ parses the amount and bulk-deletes with the given count', async () => {
    const guild = makeGuild();
    const bulk = [];
    const channel = {
        id: 'chPurge',
        isTextBased: () => true,
        bulkDelete: async (n, f) => { bulk.push([n, f]); return { size: n }; },
        send: async () => {},
    };
    const i = makeInteraction({ ...buttonOpts('cp_111_50'), guild, channel });
    await handleInteraction(i);
    assert.deepStrictEqual(bulk[0], [50, true]);
    assert.strictEqual(i.__calls.deferUpdate, 1);
    assert.match(i.__calls.editReply[0].embeds[0].data.title, /Messages Purged/);
});

test('cancel_ strikes through the embed description and clears components', async () => {
    const guild = makeGuild();
    const i = makeInteraction({
        ...buttonOpts('cancel_111'),
        guild,
        embeds: [{ title: 'Confirm', description: 'Ban <@222>?' }],
    });
    await handleInteraction(i);
    const upd = i.__calls.update[0];
    assert.match(upd.embeds[0].data.description, /~~Ban <@222>\?~~/);
    assert.deepStrictEqual(upd.components, []);
});

// ──────────────────── Warn modal (wm_ open, wr_ submit) ────────────────────

test('wm_ opens the warn modal keyed to initiator + target', async () => {
    const guild = makeGuild();
    const i = makeInteraction({ ...buttonOpts('wm_111_222'), guild });
    await handleInteraction(i);
    assert.strictEqual(i.__calls.showModal[0].data.custom_id, 'wr_111_222');
});

test('wr_ modal submit records the warning and replies with the embed', async () => {
    const guild = makeGuild({ id: 'gWarn1' });
    const i = makeInteraction({ ...modalOpts('wr_111_222'), guild, fields: { warn_reason: 'Test reason' } });
    await handleInteraction(i);
    assert.match(i.__calls.reply[0].embeds[0].data.title, /Warning Issued/);
    const count = getDb().prepare("SELECT COUNT(*) AS c FROM warnings WHERE guild_id = 'gWarn1' AND user_id = '222'").get().c;
    assert.ok(count >= 1, 'warning row stored');
});

test('wr_ modal submit by a different user is rejected', async () => {
    const guild = makeGuild({ id: 'gWarn2' });
    const i = makeInteraction({ ...modalOpts('wr_999_222'), guild, fields: { warn_reason: 'x' } });
    await handleInteraction(i);
    assert.match(i.__calls.reply[0].content, /isn't your warning form/);
});

// ──────────────────── Poll votes (pv_ / pm_ / pa_ / pvv) ────────────────────

test('pv_ single vote casts, then toggles off', async () => {
    const guild = makeGuild({ id: 'gPoll1' });
    const i1 = makeInteraction({ ...buttonOpts('pv_vote_0'), guild, messageId: 'mPv1', embeds: POLL_EMBED });
    await handleInteraction(i1);
    assert.match(i1.__calls.followUp[0].content, /Vote cast/);
    assert.match(i1.__calls.editReply[0].embeds[0].data.fields[0].value, /\*\*1\*\* \(100%\)/);

    const i2 = makeInteraction({ ...buttonOpts('pv_vote_0'), guild, messageId: 'mPv1', embeds: POLL_EMBED });
    await handleInteraction(i2);
    assert.match(i2.__calls.followUp[0].content, /Vote removed/);
    const left = getDb().prepare("SELECT COUNT(*) AS c FROM poll_votes WHERE message_id = 'mPv1'").get().c;
    assert.strictEqual(left, 0);
});

test('pm_ multi vote keeps votes for two options', async () => {
    const guild = makeGuild({ id: 'gPoll2' });
    const i1 = makeInteraction({ ...buttonOpts('pm_vote_0'), guild, messageId: 'mPm1', embeds: POLL_EMBED });
    const i2 = makeInteraction({ ...buttonOpts('pm_vote_1'), guild, messageId: 'mPm1', embeds: POLL_EMBED });
    await handleInteraction(i1);
    await handleInteraction(i2);
    const rows = getDb().prepare("SELECT option_index FROM poll_votes WHERE message_id = 'mPm1' AND user_id = '111' ORDER BY option_index").all();
    assert.deepStrictEqual(rows.map(r => r.option_index), [0, 1]);
    assert.match(i2.__calls.editReply[0].embeds[0].data.footer.text, /Multi/);
});

test('pa_ anonymous revote replaces the previous option', async () => {
    const guild = makeGuild({ id: 'gPoll3' });
    const i1 = makeInteraction({ ...buttonOpts('pa_vote_0'), guild, messageId: 'mPa1', embeds: POLL_EMBED });
    const i2 = makeInteraction({ ...buttonOpts('pa_vote_1'), guild, messageId: 'mPa1', embeds: POLL_EMBED });
    await handleInteraction(i1);
    await handleInteraction(i2);
    const rows = getDb().prepare("SELECT option_index FROM poll_votes WHERE message_id = 'mPa1' AND user_id = '111'").all();
    assert.strictEqual(rows.length, 1, 'anonymous revote must keep exactly one row');
    assert.strictEqual(rows[0].option_index, 1);
    assert.match(i2.__calls.followUp[0].content, /anonymously cast/);
});

test('pa_ vote confirmation says anonymously cast', async () => {
    const guild = makeGuild({ id: 'gPoll4' });
    const i = makeInteraction({ ...buttonOpts('pa_vote_0'), guild, messageId: 'mPa4', embeds: POLL_EMBED });
    await handleInteraction(i);
    assert.match(i.__calls.followUp[0].content, /anonymously cast/);
});

test('pvv_ lists voters per option', async () => {
    insertPollVote('mPvv1', '42', 0);
    const guild = makeGuild({ id: 'gPoll5' });
    const i = makeInteraction({ ...buttonOpts('pvv'), guild, messageId: 'mPvv1', embeds: POLL_EMBED });
    await handleInteraction(i);
    assert.match(i.__calls.reply[0].content, /<@42>/);
    assert.match(i.__calls.reply[0].content, /Option A/);
});

// ──────────────────── Ticket create / select ────────────────────

test('tk_create_{panel}_{type} opens the questions modal for that type', async () => {
    const guild = makeGuild({ id: 'gTk1' });
    let seen = null;
    const restore = patch(tickets, {
        getTicketConfig: () => ({ enabled: true }),
        isBlacklisted: () => null,
        getBlockingOpenTicket: () => null,
        getPanelType: (id) => ({ id, name: 'Support' }),
        showQuestionsModal: async (i, type) => { seen = type; },
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tk_create_panel1_typeX'), guild });
        await handleInteraction(i);
        assert.ok(seen, 'showQuestionsModal must be called');
        assert.strictEqual(seen.id, 'typeX');
    } finally { restore(); }
});

test('tk_create_{panel} without a type opens the panel type selector', async () => {
    const guild = makeGuild({ id: 'gTk2' });
    let seen = null;
    const restore = patch(tickets, {
        getTicketConfig: () => ({ enabled: true }),
        isBlacklisted: () => null,
        getBlockingOpenTicket: () => null,
        getPanel: (id) => ({ id, name: 'Panel' }),
        showTicketTypeModal: async (i, panel) => { seen = panel; },
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tk_create_panel1'), guild });
        await handleInteraction(i);
        assert.ok(seen, 'showTicketTypeModal must be called');
        assert.strictEqual(seen.id, 'panel1');
    } finally { restore(); }
});

test('tk_create with a missing type id gets the gone reply', async () => {
    const guild = makeGuild({ id: 'gTk3' });
    const restore = patch(tickets, {
        getTicketConfig: () => ({ enabled: true }),
        isBlacklisted: () => null,
        getBlockingOpenTicket: () => null,
        getPanelType: () => null,
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tk_create_panel1_ghost'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /no longer exists/);
    } finally { restore(); }
});

test('tk_create is blocked when tickets are disabled', async () => {
    const guild = makeGuild({ id: 'gTk4' });
    const restore = patch(tickets, { getTicketConfig: () => ({ enabled: false }) });
    try {
        const i = makeInteraction({ ...buttonOpts('tk_create_panel1'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /not enabled/);
    } finally { restore(); }
});

test('tk_create is blocked for blacklisted users with the reason shown', async () => {
    const guild = makeGuild({ id: 'gTk5' });
    const restore = patch(tickets, {
        getTicketConfig: () => ({ enabled: true }),
        isBlacklisted: () => ({ reason: 'asked for it' }),
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tk_create_panel1'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /blacklisted/);
        assert.match(i.__calls.reply[0].content, /asked for it/);
    } finally { restore(); }
});

test('tk_create is blocked when the user already has an open ticket', async () => {
    const guild = makeGuild({ id: 'gTk6' });
    const restore = patch(tickets, {
        getTicketConfig: () => ({ enabled: true }),
        isBlacklisted: () => null,
        getBlockingOpenTicket: () => ({ channel_id: 'c77' }),
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tk_create_panel1'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /already have an open ticket/);
        assert.match(i.__calls.reply[0].content, /<#c77>/);
    } finally { restore(); }
});

test('tk_select_{panel} routes to the questions modal for the chosen type', async () => {
    const guild = makeGuild({ id: 'gTk7' });
    let seen = null;
    const restore = patch(tickets, {
        getTicketConfig: () => ({ enabled: true }),
        isBlacklisted: () => null,
        getBlockingOpenTicket: () => null,
        getPanelType: (id) => ({ id, name: 'Support' }),
        showQuestionsModal: async (i, type) => { seen = type; },
    });
    try {
        const i = makeInteraction({ type: 'select', customId: 'tk_select_panel1', guild, values: ['typeZ'] });
        await handleInteraction(i);
        assert.ok(seen);
        assert.strictEqual(seen.id, 'typeZ');
    } finally { restore(); }
});

// ──────────────────── Ticket close / claim ────────────────────

test('tk_close_ reports success with the ticket number', async () => {
    const guild = makeGuild({ id: 'gTk8' });
    let calledWith = null;
    const restore = patch(tickets, {
        closeTicket: async (g, c, u) => { calledWith = { channel: c.id, user: u.id }; return { ticketNumber: 5 }; },
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tk_close_whatever'), guild, channel: { id: 'chClose8' } });
        await handleInteraction(i);
        assert.deepStrictEqual(calledWith, { channel: 'chClose8', user: '111' });
        assert.match(i.__calls.editReply[0].content, /Closing ticket \*\*#5\*\*/);
    } finally { restore(); }
});

test('tk_close_ surfaces the error returned by closeTicket', async () => {
    const guild = makeGuild({ id: 'gTk9' });
    const restore = patch(tickets, { closeTicket: async () => ({ error: 'No open ticket found for this channel.' }) });
    try {
        const i = makeInteraction({ ...buttonOpts('tk_close_x'), guild, channel: { id: 'chClose9' } });
        await handleInteraction(i);
        assert.match(i.__calls.editReply[0].content, /No open ticket found/);
    } finally { restore(); }
});

test('tk_claim_ reports the claimed ticket number', async () => {
    const guild = makeGuild({ id: 'gTk10' });
    const restore = patch(tickets, { claimTicket: async () => ({ ticketNumber: 9 }) });
    try {
        const i = makeInteraction({ ...buttonOpts('tk_claim_x'), guild, channel: { id: 'chClaim10' } });
        await handleInteraction(i);
        assert.match(i.__calls.editReply[0].content, /claimed ticket \*\*#9\*\*/);
    } finally { restore(); }
});

// ──────────────────── Ticket rating (tk_rate_ / tk_rateskip_ / tk_feedback_) ────────────────────

test('tk_rate_{id}_{n} with a real ticket opens the feedback modal', async () => {
    insertTicket({ id: 'tktRate1', guildId: 'gTk11', channelId: 'chTk11' });
    const guild = makeGuild({ id: 'gTk11' });
    const i = makeInteraction({ ...buttonOpts('tk_rate_tktRate1_4'), guild });
    await handleInteraction(i);
    assert.strictEqual(i.__calls.showModal[0].data.custom_id, 'tk_feedback_tktRate1_4');
});

test('tk_rate_ with an unknown ticket id gets ticket-not-found', async () => {
    const guild = makeGuild({ id: 'gTk12' });
    const i = makeInteraction({ ...buttonOpts('tk_rate_ghost_5'), guild });
    await handleInteraction(i);
    assert.match(i.__calls.reply[0].content, /Ticket not found/);
});

test('tk_rate_ with an out-of-range rating is rejected', async () => {
    const guild = makeGuild({ id: 'gTk13' });
    const i = makeInteraction({ ...buttonOpts('tk_rate_x_9'), guild });
    await handleInteraction(i);
    assert.match(i.__calls.reply[0].content, /Invalid rating/);
});

test('tk_rateskip_ disables all buttons on the message', async () => {
    const guild = makeGuild({ id: 'gTk14' });
    const i = makeInteraction({ ...buttonOpts('tk_rateskip_x'), guild, components: BTN_ROW });
    await handleInteraction(i);
    const row = i.__calls.update[0].components[0];
    assert.strictEqual(row.components[0].data.disabled, true);
});

test('tk_feedback_ modal saves the rating + comment and disables the buttons', async () => {
    insertTicket({ id: 'tktFb1', guildId: 'gTk15', channelId: 'chTk15' });
    const guild = makeGuild({ id: 'gTk15' });
    const i = makeInteraction({
        ...modalOpts('tk_feedback_tktFb1_5'),
        guild,
        fields: { tk_feedback_text: 'great help' },
        components: BTN_ROW,
    });
    await handleInteraction(i);
    const row = getDb().prepare("SELECT * FROM ticket_ratings WHERE ticket_id = 'tktFb1'").get();
    assert.ok(row, 'rating row stored');
    assert.strictEqual(row.rating, 5);
    assert.strictEqual(row.feedback, 'great help');
    assert.match(i.__calls.followUp[0].content, /Thanks for your feedback/);
    assert.strictEqual(i.__calls.update[0].components[0].components[0].data.disabled, true);
});

// ──────────────────── Ticket keep-alive / transfer / adduser ────────────────────

test('tk_keep_ resets activity and disables the keep-alive button', async () => {
    insertTicket({ id: 'tktKeep1', guildId: 'gTk16', channelId: 'chTk16' });
    getDb().prepare('UPDATE tickets SET last_activity_at = ? WHERE id = ?').run(Date.now() - 86400000, 'tktKeep1');
    const guild = makeGuild({ id: 'gTk16' });
    const i = makeInteraction({
        ...buttonOpts('tk_keep_tktKeep1'),
        guild,
        embeds: [{ title: 'Inactivity warning', description: 'Close soon?' }],
        components: BTN_ROW,
    });
    await handleInteraction(i);
    assert.strictEqual(i.__calls.update[0].embeds[0].data.title, '✅ Still Active');
    assert.strictEqual(i.__calls.update[0].components[0].components[0].data.disabled, true);
    assert.match(i.__calls.followUp[0].content, /inactivity timer has been reset/);
    const rowAge = getDb().prepare('SELECT last_activity_at FROM tickets WHERE id = ?').get('tktKeep1').last_activity_at;
    assert.ok(rowAge > Date.now() - 60000, 'last_activity_at refreshed');
});

test('tk_transfer_ button opens the transfer modal keyed to the ticket', async () => {
    const guild = makeGuild({ id: 'gTk17' });
    const i = makeInteraction({ ...buttonOpts('tk_transfer_tkt17'), guild });
    await handleInteraction(i);
    assert.strictEqual(i.__calls.showModal[0].data.custom_id, 'tk_transfer_modal_tkt17');
});

test('tk_transfer_modal_ transfers to the entered member', async () => {
    const guild = makeGuild({ id: 'gTk18' });
    guild.__members.set('222', makeMember('222'));
    let seen = null;
    const restore = patch(tickets, {
        transferTicket: async (g, c, u, t) => { seen = t.id; return {}; },
    });
    try {
        const i = makeInteraction({
            ...modalOpts('tk_transfer_modal_tkt18'),
            guild,
            channel: { id: 'chTk18' },
            fields: { tk_transfer_user: '222' },
        });
        await handleInteraction(i);
        assert.strictEqual(seen, '222');
        assert.match(i.__calls.reply[0].content, /transferred to \*\*User222#0001\*\*/);
    } finally { restore(); }
});

test('tk_transfer_modal_ surfaces transfer errors', async () => {
    const guild = makeGuild({ id: 'gTk19' });
    guild.__members.set('222', makeMember('222'));
    const restore = patch(tickets, { transferTicket: async () => ({ error: 'Only staff can transfer.' }) });
    try {
        const i = makeInteraction({
            ...modalOpts('tk_transfer_modal_tkt19'),
            guild,
            channel: { id: 'chTk19' },
            fields: { tk_transfer_user: '222' },
        });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /Only staff can transfer/);
    } finally { restore(); }
});

test('tk_transfer_modal_ with an unknown member id gets not-found', async () => {
    const guild = makeGuild({ id: 'gTk20' });
    const restore = patch(tickets, { transferTicket: async () => { throw new Error('must not be called'); } });
    try {
        const i = makeInteraction({
            ...modalOpts('tk_transfer_modal_tkt20'),
            guild,
            channel: { id: 'chTk20' },
            fields: { tk_transfer_user: '888888' },
        });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /Could not find a member/);
    } finally { restore(); }
});

test('tk_adduser_ button opens the add-user modal keyed to the ticket', async () => {
    const guild = makeGuild({ id: 'gTk21' });
    const i = makeInteraction({ ...buttonOpts('tk_adduser_tkt21'), guild });
    await handleInteraction(i);
    assert.strictEqual(i.__calls.showModal[0].data.custom_id, 'tk_adduser_modal_tkt21');
});

test('tk_adduser_modal_ adds the entered member', async () => {
    const guild = makeGuild({ id: 'gTk22' });
    guild.__members.set('333', makeMember('333'));
    let seen = null;
    const restore = patch(tickets, {
        addUserToTicket: async (g, c, u, t) => { seen = t.id; return {}; },
    });
    try {
        const i = makeInteraction({
            ...modalOpts('tk_adduser_modal_tkt22'),
            guild,
            channel: { id: 'chTk22' },
            fields: { tk_adduser_id: '333' },
        });
        await handleInteraction(i);
        assert.strictEqual(seen, '333');
        assert.match(i.__calls.reply[0].content, /Added \*\*User333#0001\*\*/);
    } finally { restore(); }
});

test('tk_questions_ modal submit routes to handleQuestionsSubmit', async () => {
    const guild = makeGuild({ id: 'gTk23' });
    let called = false;
    const restore = patch(tickets, { handleQuestionsSubmit: async () => { called = true; } });
    try {
        const i = makeInteraction({ ...modalOpts('tk_questions_tkt23'), guild, fields: { q1: 'answer' } });
        await handleInteraction(i);
        assert.ok(called, 'handleQuestionsSubmit must be called');
    } finally { restore(); }
});

// ──────────────────── Temp VC buttons ────────────────────

test('tvc_create spawns a fresh channel message', async () => {
    const guild = makeGuild({ id: 'gVc1' });
    const restore = patch(tv, {
        createForMember: async () => ({ reused: false, channel: { id: 'vc1', name: 'VC' } }),
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_create'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /Created \*\*VC\*\*/);
    } finally { restore(); }
});

test('tvc_create reuse path says moved back', async () => {
    const guild = makeGuild({ id: 'gVc2' });
    const restore = patch(tv, {
        createForMember: async () => ({ reused: true, channel: { id: 'vc2', name: 'VC2' } }),
        updatePanels: async () => {},
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_create'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /Moved you back to <#vc2>/);
    } finally { restore(); }
});

test('tvc_lock by a non-owner is rejected', async () => {
    const guild = makeGuild({ id: 'gVc3' });
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: 'someoneElse' }, channel: { id: 'vc3' } }),
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_lock'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /Only the channel owner can lock/);
    } finally { restore(); }
});

test('tvc_lock by the owner locks the channel; tvc_unlock unlocks', async () => {
    const guild = makeGuild({ id: 'gVc4' });
    const locked = [];
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: '111' }, channel: { id: 'vc4' } }),
        setChannelLocked: async (channel, g, m, on) => { locked.push(on); },
    });
    try {
        const i1 = makeInteraction({ ...buttonOpts('tvc_lock'), guild });
        const i2 = makeInteraction({ ...buttonOpts('tvc_unlock'), guild });
        await handleInteraction(i1);
        await handleInteraction(i2);
        assert.deepStrictEqual(locked, [true, false]);
        assert.match(i1.__calls.reply[0].content, /Channel locked/);
        assert.match(i2.__calls.reply[0].content, /Channel unlocked/);
    } finally { restore(); }
});

test('tvc_rename and tvc_limit open owner-gated modals', async () => {
    const guild = makeGuild({ id: 'gVc5' });
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: '111' }, channel: { id: 'vc5' } }),
    });
    try {
        const i1 = makeInteraction({ ...buttonOpts('tvc_rename'), guild });
        const i2 = makeInteraction({ ...buttonOpts('tvc_limit'), guild });
        await handleInteraction(i1);
        await handleInteraction(i2);
        assert.strictEqual(i1.__calls.showModal[0].data.custom_id, 'tvc_modal_rename');
        assert.strictEqual(i2.__calls.showModal[0].data.custom_id, 'tvc_modal_limit');
    } finally { restore(); }
});

test('tvc_claim with no channel at all gets the not-in-VC gate reply', async () => {
    const guild = makeGuild({ id: 'gVc6' });
    const restore = patch(tv, {
        getMemberChannelFor: () => null,
        getSpawnedChannel: () => { throw new Error('must not be reached'); },
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_claim'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /not in \(and don't own\) a temp voice channel/);
    } finally { restore(); }
});

test('tvc_claim outside a spawned channel gets the claim-specific reply', async () => {
    // Owns a VC but is not connected to any voice channel right now.
    const guild = makeGuild({ id: 'gVc6b' });
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: '111' }, channel: { id: 'vcOwn' } }),
        getSpawnedChannel: () => { throw new Error('must not be reached without a voice channel'); },
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_claim'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /inside a temp voice channel to claim/);
    } finally { restore(); }
});

test('tvc_claim refuses while the owner is still in the channel', async () => {
    const guild = makeGuild({
        id: 'gVc7',
        channelCache: new Map([['vc7', { id: 'vc7', members: new Set(['999']) }]]),
    });
    const member = makeMember('111', { voice: { channelId: 'vc7' } });
    const ownerRow = { owner_id: '999', trigger_id: 'trig7' };
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: ownerRow, channel: { id: 'vc7' } }),
        getSpawnedChannel: (_id) => ownerRow,
        addSpawned: () => { throw new Error('must not transfer ownership'); },
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_claim'), guild, member });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /owner is still here/);
    } finally { restore(); }
});

test('tvc_claim transfers ownership when the owner left', async () => {
    const guild = makeGuild({
        id: 'gVc8',
        channelCache: new Map([['vc8', { id: 'vc8', members: new Set(['111']) }]]),
    });
    const member = makeMember('111', { voice: { channelId: 'vc8' } });
    const added = [];
    const ownerRow = { owner_id: '999', trigger_id: 'trig8' };
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: ownerRow, channel: { id: 'vc8' } }),
        getSpawnedChannel: (_id) => ownerRow,
        addSpawned: (_id, _gid, _owner, _trig) => { added.push([_id, _gid, _owner, _trig]); },
        cancelDeletion: () => {},
        updatePanels: async () => {},
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_claim'), guild, member });
        await handleInteraction(i);
        assert.deepStrictEqual(added, [['vc8', 'gVc8', '111', 'trig8']]);
        assert.match(i.__calls.reply[0].content, /You now own this channel/);
    } finally { restore(); }
});

test('tvc_delete is owner-gated and calls deleteOwnedChannel', async () => {
    const guild = makeGuild({ id: 'gVc9' });
    let deleted = false;
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: 'someoneElse' }, channel: { id: 'vc9' } }),
        deleteOwnedChannel: async () => { deleted = true; },
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_delete'), guild });
        await handleInteraction(i);
        assert.strictEqual(deleted, false, 'non-owner must not delete');
        assert.match(i.__calls.reply[0].content, /Only the channel owner can delete/);
    } finally { restore(); }

    const restore2 = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: '111' }, channel: { id: 'vc9' } }),
        deleteOwnedChannel: async () => { deleted = true; },
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_delete'), guild });
        await handleInteraction(i);
        assert.strictEqual(deleted, true);
        assert.match(i.__calls.reply[0].content, /Deleted your temp voice channel/);
    } finally { restore2(); }
});

test('unknown tvc action gets the unknown-action reply', async () => {
    const guild = makeGuild({ id: 'gVc10' });
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: '111' }, channel: { id: 'vc10' } }),
    });
    try {
        const i = makeInteraction({ ...buttonOpts('tvc_explode'), guild });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /Unknown panel action/);
    } finally { restore(); }
});

// ──────────────────── Temp VC modals ────────────────────

test('tvc_modal_rename renames the owned channel', async () => {
    const guild = makeGuild({ id: 'gVc11' });
    const setNames = [];
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: '111' }, channel: { id: 'vc11', setName: async (n) => { setNames.push(n); } } }),
    });
    try {
        const i = makeInteraction({
            ...modalOpts('tvc_modal_rename'),
            guild,
            fields: { tvc_rename_name: 'Chill Zone' },
        });
        await handleInteraction(i);
        assert.deepStrictEqual(setNames, ['Chill Zone']);
        assert.match(i.__calls.reply[0].content, /Renamed to \*\*Chill Zone\*\*/);
    } finally { restore(); }
});

test('tvc_modal_rename by a non-owner is rejected', async () => {
    const guild = makeGuild({ id: 'gVc12' });
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: 'other' }, channel: { id: 'vc12' } }),
    });
    try {
        const i = makeInteraction({ ...modalOpts('tvc_modal_rename'), guild, fields: { tvc_rename_name: 'x' } });
        await handleInteraction(i);
        assert.match(i.__calls.reply[0].content, /Only the channel owner/);
    } finally { restore(); }
});

test('tvc_modal_limit accepts 0-99 and rejects out-of-range', async () => {
    const guild = makeGuild({ id: 'gVc13' });
    const limits = [];
    const restore = patch(tv, {
        getMemberChannelFor: () => ({ row: { owner_id: '111' }, channel: { id: 'vc13', setUserLimit: async (n) => { limits.push(n); } } }),
    });
    try {
        const i1 = makeInteraction({ ...modalOpts('tvc_modal_limit'), guild, fields: { tvc_limit_num: '50' } });
        const i2 = makeInteraction({ ...modalOpts('tvc_modal_limit'), guild, fields: { tvc_limit_num: '500' } });
        await handleInteraction(i1);
        await handleInteraction(i2);
        assert.deepStrictEqual(limits, [50]);
        assert.match(i1.__calls.reply[0].content, /limit set to \*\*50\*\*/);
        assert.match(i2.__calls.reply[0].content, /between \*\*0 and 99\*\*/);
    } finally { restore(); }
});

// ──────────────────── Select menu fallbacks ────────────────────

test('rm_ select with no configured menu gets the gone reply', async () => {
    const i = makeInteraction({ type: 'select', customId: 'rm_123456', values: ['r1'], guild: makeGuild() });
    await handleInteraction(i);
    assert.match(i.__calls.reply[0].content, /no longer configured/);
});

test('unknown select prefix gets the fallback reply', async () => {
    const i = makeInteraction({ type: 'select', customId: 'zz_sel', values: ['x'] });
    await handleInteraction(i);
    assert.strictEqual(i.__calls.reply[0].content, 'Select menu received.');
});

// ──────────────────── Poll end (POST /api/polls/end → endPoll) ────────────────────

function makePollClient({ channelId, messageId, message }) {
    const channel = {
        id: channelId,
        isTextBased: () => true,
        messages: {
            cache: new Map([[messageId, message]]),
            fetch: async (id) => (String(id) === String(messageId) ? message : null),
        },
    };
    return {
        channels: {
            cache: new Map([[channelId, channel]]),
            fetch: async () => channel,
        },
    };
}

test('endPoll tallies votes, declares the winner, clears buttons and marks ended', async () => {
    const messageId = 'mEndPoll1';
    recordPoll({ messageId, guildId: 'gEnd1', channelId: 'chEnd1', question: 'Lunch?', options: ['Pizza', 'Sushi'], pollType: 'single', endsAt: null });

    // The dashboard create route writes a placeholder "system" row (option -1);
    // it must not count as a vote or a voter.
    getDb().prepare('INSERT INTO poll_votes (message_id, user_id, option_index, voted_at) VALUES (?, ?, ?, ?)').run(messageId, 'system', -1, Date.now());
    insertPollVote(messageId, 'u1', 0);
    insertPollVote(messageId, 'u2', 0);
    insertPollVote(messageId, 'u3', 1);

    const edited = [];
    const message = {
        id: messageId,
        embeds: [{ title: '📊 Lunch?', description: '1. Pizza\n2. Sushi' }],
        edit: async (payload) => { edited.push(payload); },
    };
    const client = makePollClient({ channelId: 'chEnd1', messageId, message });

    const result = await endPoll(messageId, { client });

    assert.strictEqual(edited.length, 1, 'message must be edited exactly once');
    assert.deepStrictEqual(edited[0].components, [], 'buttons must be cleared');
    const embed = edited[0].embeds[0].data;
    assert.match(embed.title, /Poll Ended: Lunch\?/);
    assert.match(embed.description, /\*\*Winner:\*\* \*\*Pizza\*\*/);
    assert.strictEqual(embed.fields[0].value, '📊 Votes: **2** (67%)');
    assert.strictEqual(embed.fields[1].value, '📊 Votes: **1** (33%)');
    assert.match(embed.footer.text, /3 total votes  •  3 voters/);
    assert.deepStrictEqual(result.winners, [0]);
    assert.strictEqual(result.totalVoters, 3, 'placeholder row must not count as a voter');
    assert.strictEqual(getDb().prepare('SELECT ended FROM polls WHERE message_id = ?').get(messageId).ended, 1, 'poll marked ended');
});

test('endPoll falls back to the embed when no metadata was recorded', async () => {
    const messageId = 'mEndFb1';
    insertPollVote(messageId, 'v1', 1);

    const edited = [];
    const message = {
        id: messageId,
        embeds: [{ title: '🗳️ Legacy poll', fields: [{ name: '1️⃣  Yes', value: 'x' }, { name: '2️⃣  No', value: 'x' }] }],
        edit: async (payload) => { edited.push(payload); },
    };
    const client = makePollClient({ channelId: 'chFb1', messageId, message });

    const result = await endPoll(messageId, { client, channelId: 'chFb1' });

    assert.deepStrictEqual(result.winners, [1]);
    assert.deepStrictEqual(result.options, ['Yes', 'No'], 'options recovered from embed fields');
    assert.match(edited[0].embeds[0].data.description, /\*\*Winner:\*\* \*\*No\*\*/);
});

test('endPoll throws a clear error when the poll message cannot be found', async () => {
    recordPoll({ messageId: 'mEndMissing', guildId: 'gEnd2', channelId: 'chEnd2', question: 'Gone?', options: ['a', 'b'] });
    const client = { channels: { cache: new Map(), fetch: async () => null } };
    await assert.rejects(() => endPoll('mEndMissing', { client }), /Poll message not found/);
});

test('endPoll rejects when no client is supplied', async () => {
    await assert.rejects(() => endPoll('whatever'), /client is not available/);
});

// ──────────────────── Live poll fixes (dashboard format + placeholder) ────────────────────

test('voting on a description-style poll starts rendering per-option counts', async () => {
    const guild = makeGuild({ id: 'gDashPoll1' });
    const i = makeInteraction({
        ...buttonOpts('pv_vote_0'),
        guild,
        messageId: 'mDash1',
        embeds: [{ title: '📊 Lunch?', description: '1. Pizza\n2. Sushi' }],
    });
    await handleInteraction(i);
    const fields = i.__calls.editReply[0].embeds[0].data.fields;
    assert.strictEqual(fields.length, 2, 'fields synthesised from the description');
    assert.match(fields[0].name, /^Pizza/, 'description-derived option label');
    assert.match(fields[0].value, /\*\*1\*\* \(100%\)/);
    assert.match(fields[1].value, /\*\*0\*\* \(0%\)/);
});

test('the dashboard placeholder row is not counted as a vote or a voter', async () => {
    const guild = makeGuild({ id: 'gDashPoll2' });
    const messageId = 'mDash2';
    getDb().prepare('INSERT INTO poll_votes (message_id, user_id, option_index, voted_at) VALUES (?, ?, ?, ?)').run(messageId, 'system', -1, Date.now());
    insertPollVote(messageId, 'real1', 0);

    const i = makeInteraction({ ...buttonOpts('pv_vote_0'), guild, messageId, embeds: POLL_EMBED });
    await handleInteraction(i);

    const embed = i.__calls.editReply[0].embeds[0].data;
    assert.strictEqual(embed.fields[0].value, '📊 Votes: **2** (100%)', 'both real votes counted, placeholder ignored');
    assert.match(embed.footer.text, /2 voters/);
    assert.doesNotMatch(embed.footer.text, /3 voters/);
});

// ──────────────────── Timed-poll sweeper (restart-safe auto-end) ────────────────────
// A timed poll used to be finalized by a setTimeout in the /poll handler, which
// died with the process — a restart before the end time meant the poll never
// finalized. The sweeper finalizes anything due, whenever it became due.

function makeMultiPollClient(entries) {
    // entries: [{ channelId, messageId, message }] — like makePollClient, but
    // for several polls at once. Channels are keyed by channel id, which is
    // what resolvePollMessage fetches by.
    const channels = new Map();
    for (const { channelId, messageId, message } of entries) {
        channels.set(String(channelId), {
            id: String(channelId),
            isTextBased: () => true,
            messages: {
                cache: new Map(),
                fetch: async (mid) => (String(mid) === String(messageId) ? message : null),
            },
        });
    }
    return {
        channels: {
            cache: channels,
            fetch: async (cid) => channels.get(String(cid)) || null,
        },
    };
}

function insertPoll(messageId, { channelId, question, options, endsAt, ended = 0 }) {
    getDb().prepare(`INSERT INTO polls (message_id, guild_id, channel_id, question, options, poll_type, created_at, ends_at, ended)
        VALUES (?, 'gSweep', ?, ?, ?, 'single', ?, ?, ?)`)
        .run(messageId, channelId, question, JSON.stringify(options), Date.now(), endsAt, ended);
}

function pollRow(messageId) {
    return getDb().prepare('SELECT ended, ends_at FROM polls WHERE message_id = ?').get(messageId);
}

test('checkPolls finalizes a timed poll that came due — including after a restart', async () => {
    // No setTimeout was ever scheduled for this poll: it is exactly what the
    // table looks like after the bot restarts between creation and end time.
    insertPoll('mSweepDue', { channelId: 'chSweep1', question: 'Restart?', options: ['Yes', 'No'], endsAt: Date.now() - 5000 });
    insertPoll('mSweepFuture', { channelId: 'chSweep1', question: 'Later?', options: ['A', 'B'], endsAt: Date.now() + 600_000 });
    insertPoll('mSweepDone', { channelId: 'chSweep1', question: 'Old?', options: ['X', 'Y'], endsAt: Date.now() - 5000, ended: 1 });
    insertPollVote('mSweepDue', 'voter1', 1);

    const edited = [];
    const message = {
        id: 'mSweepDue',
        embeds: [{ title: '📊 Restart?', description: '1. Yes\n2. No' }],
        edit: async (payload) => { edited.push(payload); },
    };
    setPollClient(makeMultiPollClient([{ channelId: 'chSweep1', messageId: 'mSweepDue', message }]));

    try {
        const ended = await checkPolls();
        assert.strictEqual(ended, 1, 'only the due, unfinished poll is finalized');
        assert.strictEqual(edited.length, 1, 'the due poll message is edited');
        assert.match(edited[0].embeds[0].data.title, /Poll Ended: Restart\?/);
        assert.deepStrictEqual(edited[0].components, [], 'buttons cleared so voting stops');
        assert.strictEqual(pollRow('mSweepDue').ended, 1);
        assert.strictEqual(pollRow('mSweepFuture').ended, 0, 'a future poll is left alone');
    } finally {
        setPollClient(null);
    }
});

test('checkPolls keeps sweeping when one poll cannot be finalized', async () => {
    // The gone poll sorts first (inserted first); the good one must still end.
    insertPoll('mSweepGone', { channelId: 'chSweepGone', question: 'Deleted?', options: ['a', 'b'], endsAt: Date.now() - 9000 });
    insertPoll('mSweepGood', { channelId: 'chSweepGood', question: 'Fine?', options: ['c', 'd'], endsAt: Date.now() - 8000 });

    const edited = [];
    const goodMessage = {
        id: 'mSweepGood',
        embeds: [{ title: '📊 Fine?', description: '1. c\n2. d' }],
        edit: async (payload) => { edited.push(payload); },
    };
    setPollClient(makeMultiPollClient([{ channelId: 'chSweepGood', messageId: 'mSweepGood', message: goodMessage }]));

    try {
        const ended = await checkPolls();
        assert.strictEqual(ended, 1, 'the poll that could be finalized still was');
        assert.strictEqual(edited.length, 1);
        assert.strictEqual(pollRow('mSweepGood').ended, 1);
        // Not marked ended → retried on the next sweep instead of lost forever.
        assert.strictEqual(pollRow('mSweepGone').ended, 0, 'a failed poll must not be marked ended');
    } finally {
        setPollClient(null);
    }
});

test('checkPolls is a no-op without a client or without due polls', async () => {
    setPollClient(null);
    assert.strictEqual(await checkPolls(), 0, 'no client → nothing to do');

    insertPoll('mSweepNone', { channelId: 'chSweepNone', question: 'Pending?', options: ['a', 'b'], endsAt: Date.now() + 600_000 });
    setPollClient(makeMultiPollClient([]));
    try {
        assert.strictEqual(await checkPolls(), 0, 'no due polls → nothing to do');
    } finally {
        setPollClient(null);
    }
});

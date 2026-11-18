// Tests for the custom commands / autoresponders module: name + trigger
// validation, CRUD against SQLite, placeholder expansion, and the message-path
// behaviour that matters most — when a reply happens, and when it must not.
const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-commands-test-'));
process.env.DATA_DIR = tmp;

const { closeDb, getDb } = require('../src/db');
const cc = require('../src/customCommands');

after(() => {
    try { closeDb(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
    cc.resetAutoresponderThrottle();
    const db = getDb();
    db.prepare('DELETE FROM custom_commands').run();
    db.prepare('DELETE FROM autoresponders').run();
    // Raw SQL bypasses the module's invalidation, so the per-guild read cache
    // has to be dropped by hand here.
    cc.invalidateCustomCommandsCache();
});

const GUILD_ID = 'g1';

function makeGuild(guildId = GUILD_ID) {
    return {
        id: guildId,
        name: 'Test Guild',
        memberCount: 42,
        ownerId: 'owner1',
        premiumSubscriptionCount: 3,
        premiumTier: 2,
        iconURL: () => 'https://cdn.example/icon.png',
        members: { cache: { size: 42, filter: () => ({ size: 40 }) } },
        channels: { cache: { size: 7, filter: () => ({ size: 5 }) } },
        roles: { cache: { size: 6 } },
    };
}

function makeMessage(content, opts = {}) {
    const sent = [];
    const guild = makeGuild(opts.guildId || GUILD_ID);
    const author = {
        id: opts.authorId || 'u1',
        bot: !!opts.bot,
        username: 'Tester',
        tag: 'Tester#0001',
        discriminator: '0001',
        createdTimestamp: Date.now() - 86400000,
        displayAvatarURL: () => 'https://cdn.example/avatar.png',
    };
    const channelId = opts.channelId || 'c1';
    const channel = {
        id: channelId,
        name: 'general',
        send: opts.sendImpl || (async (payload) => { sent.push(payload); return {}; }),
    };
    return {
        content,
        guild,
        channel,
        channelId,
        author,
        member: { user: author, displayName: 'Tester', guild, joinedAt: new Date() },
        sent,
    };
}

// ──────────────────── Validation ────────────────────

test('validateName: accepts sane names, rejects bad ones and built-ins', () => {
    assert.deepStrictEqual(cc.validateName('rules'), { name: 'rules' });
    assert.deepStrictEqual(cc.validateName('  RULES-2  '), { name: 'rules-2' });
    assert.deepStrictEqual(cc.validateName('a_b'), { name: 'a_b' });
    assert.ok(cc.validateName('').error);
    assert.ok(cc.validateName('with space').error);
    assert.ok(cc.validateName('emoji😀').error);
    assert.ok(cc.validateName('x'.repeat(33)).error);
    // A built-in must not be shadowable — the dispatcher resolves it first.
    const reserved = cc.validateName('ban');
    assert.ok(reserved.error && /built-in/.test(reserved.error), 'ban must be refused');
    assert.ok(cc.validateName('help').error);
});

test('custom commands: create, overwrite, list, delete', () => {
    const created = cc.setCustomCommand(GUILD_ID, 'RULES', { response: 'Be nice.' }, 'u9');
    assert.ok(created.created, 'first write creates');
    assert.strictEqual(created.command.name, 'rules', 'names are normalized to lowercase');
    assert.strictEqual(created.command.response, 'Be nice.');
    assert.strictEqual(created.command.asEmbed, false);

    const overwritten = cc.setCustomCommand(GUILD_ID, 'rules', { response: 'Be excellent.', asEmbed: true }, 'u8');
    assert.strictEqual(overwritten.created, false, 'second write updates');
    assert.strictEqual(overwritten.command.response, 'Be excellent.');
    assert.strictEqual(overwritten.command.asEmbed, true);
    assert.strictEqual(overwritten.command.createdBy, 'u9', 'the original author is kept on update');
    assert.strictEqual(cc.listCustomCommands(GUILD_ID).length, 1, 'upsert must not duplicate');

    assert.ok(cc.setCustomCommand(GUILD_ID, 'bad name', { response: 'x' }, 'u9').error);
    assert.ok(cc.setCustomCommand(GUILD_ID, 'ok', { response: '   ' }, 'u9').error);
    assert.ok(cc.setCustomCommand(GUILD_ID, 'ok', { response: 'y'.repeat(2001) }, 'u9').error);

    assert.strictEqual(cc.deleteCustomCommand(GUILD_ID, 'RULES'), true);
    assert.strictEqual(cc.deleteCustomCommand(GUILD_ID, 'rules'), false);
    assert.strictEqual(cc.getCustomCommand(GUILD_ID, 'rules'), null);
});

test('the per-guild cap is enforced, not just documented', () => {
    for (let i = 0; i < cc.MAX_PER_GUILD; i++) {
        assert.ok(!cc.setCustomCommand(GUILD_ID, 'cmd' + i, { response: 'ok' }, 'u1').error, 'fill ' + i);
    }
    const overLimit = cc.setCustomCommand(GUILD_ID, 'one-more', { response: 'ok' }, 'u1');
    assert.ok(overLimit.error && /maximum/.test(overLimit.error), 'the 51st is refused');
    // Overwriting an existing one is still allowed at the cap.
    assert.ok(!cc.setCustomCommand(GUILD_ID, 'cmd0', { response: 'changed' }, 'u1').error);
});

// ──────────────────── Autoresponders ────────────────────

test('autoresponders: add, update, toggle, delete', () => {
    const added = cc.addAutoresponder(GUILD_ID, { trigger: 'hello', response: 'hey there' }, 'u1');
    assert.ok(added.responder, 'responder created');
    const id = added.responder.id;
    assert.strictEqual(added.responder.matchType, 'contains', 'default match type');
    assert.strictEqual(added.responder.enabled, true);
    assert.strictEqual(added.responder.channelId, null);

    const paused = cc.updateAutoresponder(GUILD_ID, id, { enabled: false });
    assert.strictEqual(paused.responder.enabled, false);
    const resumed = cc.updateAutoresponder(GUILD_ID, id, { enabled: true });
    assert.strictEqual(resumed.responder.enabled, true);

    assert.ok(cc.updateAutoresponder(GUILD_ID, id, { matchType: 'nonsense' }).error);
    assert.ok(cc.updateAutoresponder(GUILD_ID, id, { trigger: '[' , matchType: 'regex' }).error, 'invalid regex refused');
    assert.ok(cc.updateAutoresponder(GUILD_ID, 'missing-id', { enabled: false }).error);

    assert.strictEqual(cc.deleteAutoresponder(GUILD_ID, id), true);
    assert.strictEqual(cc.deleteAutoresponder(GUILD_ID, id), false);
    assert.deepStrictEqual(cc.listAutoresponders(GUILD_ID), []);
});

test('triggerMatches: exact, contains, startswith and regex', () => {
    const mk = (matchType, trigger) => ({ matchType, trigger });
    assert.ok(cc.triggerMatches(mk('exact', 'Hello There'), 'hello there'));
    assert.ok(cc.triggerMatches(mk('exact', 'hello'), '  hello  '), 'exact trims');
    assert.ok(!cc.triggerMatches(mk('exact', 'hello'), 'hello there'));
    assert.ok(cc.triggerMatches(mk('contains', 'ELLO'), 'hEllo world'));
    assert.ok(!cc.triggerMatches(mk('contains', 'nope'), 'hello world'));
    assert.ok(cc.triggerMatches(mk('startswith', 'da rules'), 'Da rules say no'));
    assert.ok(!cc.triggerMatches(mk('startswith', 'rules'), 'the rules say no'));
    assert.ok(cc.triggerMatches(mk('regex', 'h[ae]llo\\s+\\w+'), 'well hAllo friend'));
    assert.ok(!cc.triggerMatches(mk('regex', '^\\d{3}$'), 'not a number'));
    // A malformed pattern can't throw out of the matcher.
    assert.strictEqual(cc.triggerMatches(mk('regex', '([unclosed'), 'anything'), false);
});

test('expandResponse: welcome table placeholders plus channel and args', () => {
    const message = makeMessage(';rules 7');
    const out = cc.expandResponse('Hi {user} in {server} ({membercount}) at {channel}: {args}', {
        member: message.member,
        channel: message.channel,
        args: '7',
    });
    assert.ok(out.includes('<@u1>'), 'user mention: ' + out);
    assert.ok(out.includes('Test Guild'));
    assert.ok(out.includes('42'));
    assert.ok(out.includes('<#c1>'));
    assert.ok(out.endsWith(': 7'));
    // Without a member (DMs, partial fetches) the literal text is kept.
    assert.strictEqual(cc.expandResponse('{user} and {args}', {}), '{user} and ');
});

// ──────────────────── Message path ────────────────────

test('handleCustomCommand: fires on the prefix and stays quiet otherwise', async () => {
    cc.setCustomCommand(GUILD_ID, 'rules', { response: 'Rule one.' }, 'u1');

    const miss = makeMessage('no prefix here');
    assert.strictEqual(await cc.handleCustomCommand(miss, ';'), false);
    assert.strictEqual(miss.sent.length, 0);

    const unknown = makeMessage(';nope');
    assert.strictEqual(await cc.handleCustomCommand(unknown, ';'), false);

    const hit = makeMessage(';rules please');
    assert.strictEqual(await cc.handleCustomCommand(hit, ';'), true);
    assert.strictEqual(hit.sent.length, 1);
    assert.strictEqual(hit.sent[0].content, 'Rule one.');
    assert.deepStrictEqual(hit.sent[0].allowedMentions, { parse: ['users'], repliedUser: false },
        'responses must not be able to ping @everyone');
    assert.strictEqual(cc.getCustomCommand(GUILD_ID, 'rules').uses, 1, 'use counter');

    // A custom prefix works too, and a different prefix is not a command.
    assert.strictEqual(await cc.handleCustomCommand(makeMessage('!rules'), ';'), false);
    assert.strictEqual(await cc.handleCustomCommand(makeMessage('!rules'), '!'), true);
});

test('handleCustomCommand: an embed response, and a failed send still counts as handled', async () => {
    cc.setCustomCommand(GUILD_ID, 'info', { response: 'Details here', asEmbed: true }, 'u1');
    const embedMessage = makeMessage(';info');
    assert.strictEqual(await cc.handleCustomCommand(embedMessage, ';'), true);
    assert.ok(embedMessage.sent[0].embeds, 'asEmbed sends an embed');
    assert.strictEqual(embedMessage.sent[0].embeds[0].data.description, 'Details here');

    cc.setCustomCommand(GUILD_ID, 'broken', { response: 'x' }, 'u1');
    const failing = makeMessage(';broken', { sendImpl: async () => { throw new Error('Missing Permissions'); } });
    assert.strictEqual(await cc.handleCustomCommand(failing, ';'), true,
        'a send failure must not fall through to the autoresponder matcher');
});

test('handleAutoresponders: one reply per message, scope, pause and bots are respected', async () => {
    cc.addAutoresponder(GUILD_ID, { trigger: 'hello', response: 'Hi {user}!', cooldownMs: 60000 }, 'u1');
    cc.addAutoresponder(GUILD_ID, { trigger: 'hello world', response: 'Second rule' }, 'u1');

    const first = makeMessage('well hello there');
    assert.strictEqual(await cc.handleAutoresponders(first), true);
    assert.strictEqual(first.sent.length, 1, 'only one responder answers');
    assert.strictEqual(first.sent[0].content, 'Hi <@u1>!', 'the oldest rule wins');

    // Same responder + same user inside the cooldown window: silent.
    const second = makeMessage('hello again');
    assert.strictEqual(await cc.handleAutoresponders(second), false);
    assert.strictEqual(second.sent.length, 0);

    // A different member still gets an answer.
    const other = makeMessage('hello', { authorId: 'u2' });
    assert.strictEqual(await cc.handleAutoresponders(other), true);

    // Bots never trigger (this is the loop guard for a self-matching response).
    const fromBot = makeMessage('hello', { bot: true, authorId: 'bot1' });
    assert.strictEqual(await cc.handleAutoresponders(fromBot), false);

    // Empty messages are skipped outright.
    assert.strictEqual(await cc.handleAutoresponders(makeMessage('   ')), false);
});

test('handleAutoresponders: paused rules and channel scoping', async () => {
    const scoped = cc.addAutoresponder(GUILD_ID, { trigger: 'ticket', response: 'Use the panel', channelId: 'c-support' }, 'u1').responder;
    assert.strictEqual(await cc.handleAutoresponders(makeMessage('ticket please', { channelId: 'c-general' })), false,
        'a channel-scoped rule stays in its channel');
    assert.strictEqual(await cc.handleAutoresponders(makeMessage('ticket please', { channelId: 'c-support' })), true);

    cc.updateAutoresponder(GUILD_ID, scoped.id, { enabled: false });
    cc.resetAutoresponderThrottle();
    assert.strictEqual(await cc.handleAutoresponders(makeMessage('ticket', { channelId: 'c-support' })), false,
        'a paused rule never answers');
    assert.strictEqual(cc.getAutoresponder(GUILD_ID, scoped.id).uses, 1, 'only the live reply counted');
});

test('a deleted custom command stops firing immediately', async () => {
    cc.setCustomCommand(GUILD_ID, 'shrug', { response: 'meh' }, 'u1');
    assert.strictEqual(await cc.handleCustomCommand(makeMessage(';shrug'), ';'), true);

    cc.deleteCustomCommand(GUILD_ID, 'shrug');
    assert.strictEqual(await cc.handleCustomCommand(makeMessage(';shrug'), ';'), false,
        'the delete is visible at once, not after the cache TTL');
});

test('autoresponders are read from a per-guild cache, dropped by every write', async () => {
    // The list was a SQLite query for every message in every guild.
    const rule = cc.addAutoresponder(GUILD_ID, { trigger: 'ping', response: 'pong', cooldownMs: 0 }, 'u1').responder;
    assert.strictEqual(await cc.handleAutoresponders(makeMessage('ping', { authorId: 'uA' })), true);

    // A change made behind the module's back is not seen until the cache is
    // dropped — that is the price of the cache, and why the TTL exists.
    getDb().prepare('DELETE FROM autoresponders WHERE guild_id = ?').run(GUILD_ID);
    cc.resetAutoresponderThrottle();
    assert.strictEqual(await cc.handleAutoresponders(makeMessage('ping', { authorId: 'uB' })), true,
        'still served from the cache');
    cc.invalidateCustomCommandsCache(GUILD_ID);
    assert.strictEqual(await cc.handleAutoresponders(makeMessage('ping', { authorId: 'uC' })), false,
        'gone once the cache is dropped');

    // Writes through the API are always visible on the next message.
    const fresh = cc.addAutoresponder(GUILD_ID, { trigger: 'ping', response: 'pong again', cooldownMs: 0 }, 'u1').responder;
    assert.strictEqual(await cc.handleAutoresponders(makeMessage('ping', { authorId: 'uD' })), true);
    assert.strictEqual(cc.getAutoresponder(GUILD_ID, rule.id), null, 'the deleted rule is really gone');

    cc.deleteAutoresponder(GUILD_ID, fresh.id);
    assert.strictEqual(await cc.handleAutoresponders(makeMessage('ping', { authorId: 'uE' })), false,
        'and so is this one, without waiting for the TTL');
});

test('handleAutoresponders: use counters are tracked per responder', async () => {
    const a = cc.addAutoresponder(GUILD_ID, { trigger: 'ping', response: 'pong', cooldownMs: 0 }, 'u1').responder;
    await cc.handleAutoresponders(makeMessage('ping', { authorId: 'u1' }));
    await cc.handleAutoresponders(makeMessage('ping', { authorId: 'u2' }));
    assert.strictEqual(cc.getAutoresponder(GUILD_ID, a.id).uses, 2);
});

// ──────────────────── Message path integration ────────────────────
// The ordering in src/events/messages.js is the contract that keeps a server
// from getting two replies to one message: built-in command → custom command →
// autoresponder, stop at the first handler that claims the message.

function makeDispatchableMessage(content, opts = {}) {
    const message = makeMessage(content, opts);
    message.replies = [];
    message.reply = async (contentOrOptions) => {
        message.replies.push(typeof contentOrOptions === 'string' ? contentOrOptions : contentOrOptions.content);
        return { createdTimestamp: Date.now(), edit: async () => {} };
    };
    message.client = { ws: { ping: 42 } };
    message.guild.members = { fetch: async () => null, cache: { size: 42, filter: () => ({ size: 40 }) } };
    return message;
}

async function dispatch(content, opts) {
    const events = require('../src/events/messages');
    const handler = events.find((e) => e.name === 'messageCreate').execute({});
    const message = makeDispatchableMessage(content, opts);
    await handler(message);
    return message;
}

test('message path: a built-in command wins over an autoresponder', async () => {
    // A responder that would match the command text itself.
    cc.addAutoresponder('g-dispatch', { trigger: 'ping', response: 'autoresponder replied', cooldownMs: 0 }, 'u1');
    const message = await dispatch(';ping', { authorId: 'u-dispatch', guildId: 'g-dispatch' });
    // /ping replies "Pinging..." and then edits the message; the reply landing
    // at all is the point — the autoresponder must not have answered instead.
    assert.ok(message.replies.some((r) => /Ping/i.test(r)), 'the built-in ran: ' + JSON.stringify(message.replies));
    assert.strictEqual(message.sent.length, 0, 'the autoresponder must stay quiet');
});

test('message path: a custom command wins over an autoresponder', async () => {
    cc.setCustomCommand('g-dispatch', 'hello', { response: 'custom command replied' }, 'u1');
    cc.addAutoresponder('g-dispatch', { trigger: 'hello', response: 'autoresponder replied', cooldownMs: 0 }, 'u1');
    const message = await dispatch(';hello', { authorId: 'u-dispatch', guildId: 'g-dispatch' });
    assert.deepStrictEqual(message.sent.map((s) => s.content), ['custom command replied']);
    assert.deepStrictEqual(message.replies, [], 'only one surface answers');
});

test('message path: an ordinary message reaches the autoresponder', async () => {
    cc.addAutoresponder('g-dispatch', { trigger: 'how do i appeal', response: 'Use /appeal', cooldownMs: 0 }, 'u1');
    const message = await dispatch('hey, how do i appeal a ban?', { authorId: 'u-dispatch', guildId: 'g-dispatch' });
    assert.deepStrictEqual(message.sent.map((s) => s.content), ['Use /appeal']);
});

test('message path: a prefix that matches nothing falls through to autoresponders', async () => {
    cc.addAutoresponder('g-dispatch', { trigger: 'xyzzy', response: 'nothing happens', cooldownMs: 0 }, 'u1');
    const message = await dispatch(';xyzzy', { authorId: 'u-dispatch', guildId: 'g-dispatch' });
    assert.deepStrictEqual(message.sent.map((s) => s.content), ['nothing happens']);
});

test('schema: both tables exist after initDb', () => {
    const db = getDb();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    assert.ok(tables.includes('custom_commands'), 'custom_commands table');
    assert.ok(tables.includes('autoresponders'), 'autoresponders table');
});

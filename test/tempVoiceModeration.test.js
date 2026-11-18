const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits: P, PermissionsBitField, OverwriteType, RESTJSONErrorCodes } = require('discord.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tvc-moderation-'));
process.env.DATA_DIR = tmp;
const { getDb, closeDb } = require('../src/db');
const tv = require('../src/tempVoice');
const moderation = require('../src/tempVoiceModeration');

after(() => {
    tv.stopTempVoice();
    closeDb();
    fs.rmSync(tmp, { recursive: true, force: true });
});

let serial = 0;
function fixture(t, { connected = true } = {}) {
    const guildId = String(100000000000000000n + BigInt(++serial));
    const channelId = '200' + guildId.slice(3);
    const ownerId = '300' + guildId.slice(3);
    const targetId = '400' + guildId.slice(3);
    const overwrite = (allow = 0n, deny = 0n) => ({
        type: OverwriteType.Member,
        allow: new PermissionsBitField(allow),
        deny: new PermissionsBitField(deny),
    });
    const overwrites = new Map();
    const writes = [];
    const disconnects = [];
    const members = new Map();
    const guild = {
        id: guildId,
        ownerId: '500' + guildId.slice(3),
        channels: { cache: new Map(), async fetch(id) { return this.cache.get(id); } },
        roles: { everyone: { id: guildId } },
        members: {
            cache: members,
            me: { id: '600' + guildId.slice(3) },
            async fetch({ user }) { return members.get(user); },
        },
        voiceStates: { async fetch(id) { return members.get(id).voice; } },
    };
    const channel = {
        id: channelId, guildId, guild, type: 2,
        members: new Map(),
        async delete() {},
        botPermissions: new PermissionsBitField([P.MoveMembers, P.ManageRoles]),
        permissionsFor(member) { return member === guild.members.me ? this.botPermissions : member.permissions; },
        roleOverwrites: [],
        overwritesFor() { return { everyone: overwrites.get(guildId), roles: this.roleOverwrites }; },
        permissionOverwrites: {
            cache: overwrites,
            async edit(subject, { Connect }, options) {
                const id = subject.id || subject;
                writes.push({ id, Connect, options });
                const current = overwrites.get(id) || overwrite();
                current.allow.remove(P.Connect);
                current.deny.remove(P.Connect);
                if (Connect === true) current.allow.add(P.Connect);
                if (Connect === false) current.deny.add(P.Connect);
                overwrites.set(id, current);
            },
            async delete(id) { overwrites.delete(id); },
        },
    };
    const owner = { id: ownerId, guild, voice: { channelId } };
    const target = {
        id: targetId, guild,
        permissions: new PermissionsBitField([P.Connect, P.ViewChannel]),
        voice: {
            channelId: connected ? channelId : null,
            async disconnect(reason) {
                disconnects.push(reason);
                this.channelId = null;
                channel.members.delete(targetId);
            },
        },
    };
    members.set(ownerId, owner);
    members.set(targetId, target);
    channel.members.set(ownerId, owner);
    if (connected) channel.members.set(targetId, target);
    guild.channels.cache.set(channelId, channel);
    assert.equal(tv.addSpawned(channelId, guild.id, ownerId, 'trigger').success, true);
    t.after(() => tv.removeSpawned(channelId));
    const run = (action, options) => moderation.moderate(action, guild, owner, targetId, options);
    return { guild, channel, owner, target, overwrites, overwrite, writes, disconnects, run };
}

test('kick disconnects a member of the owned VC without blocking them', async (t) => {
    const f = fixture(t);
    assert.match(await f.run('kick'), /disconnected/i);
    assert.equal(f.disconnects.length, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(f.target.voice.channelId, null);
});

test('block disconnects a connected member and survives reopening the database', async (t) => {
    const f = fixture(t);
    assert.match(await f.run('block'), /blocked/i);
    assert.equal(f.disconnects.length, 1);
    assert.equal(f.overwrites.get(f.target.id).deny.has(P.Connect), true);
    closeDb();
    const page = await moderation.listBlocked(f.guild, f.owner);
    assert.deepEqual(page.entries.map(entry => entry.user_id), [f.target.id]);
    assert.match(await f.run('unblock'), /unblocked/i);
    assert.equal(f.overwrites.has(f.target.id), false);
});

test('unblock preserves unrelated administrator edits and restores explicit Connect', async (t) => {
    const f = fixture(t, { connected: false });
    f.overwrites.set(f.target.id, f.overwrite(P.Connect | P.Speak));
    await f.run('block');
    assert.equal(f.disconnects.length, 0);
    f.overwrites.get(f.target.id).deny.add(P.Stream);
    await f.run('unblock');
    const ow = f.overwrites.get(f.target.id);
    assert.equal(ow.allow.has([P.Connect, P.Speak]), true);
    assert.equal(ow.deny.has(P.Stream), true);
});

test('kick rejects self, a disconnected target, or a target in another VC', async (t) => {
    const f = fixture(t);
    await assert.rejects(moderation.moderate('kick', f.guild, f.owner, f.owner.id), /yourself/);
    f.target.voice.channelId = null;
    await assert.rejects(f.run('kick'), /must be connected/);
    f.target.voice.channelId = 'different-voice-channel';
    await assert.rejects(f.run('kick'), /must be connected/);
    assert.equal(f.disconnects.length, 0);
});

test('an old panel cannot target another VC and non-owners and foreign guilds are refused', async (t) => {
    const f = fixture(t);
    await assert.rejects(f.run('block', { expectedId: 'different-voice-channel' }), /different temporary voice channel/);
    await assert.rejects(moderation.moderate('block', f.guild, f.target, f.owner.id), /Only the owner/);
    await assert.rejects(moderation.listBlocked(f.guild, f.target), /Only the owner/);
    await assert.rejects(moderation.moderate('block', { ...f.guild, id: 'different-guild' }, f.owner, f.target.id), /your server/);
    t.mock.method(f.guild.members, 'fetch', async () => ({ ...f.target, guild: { id: 'different-guild' } }));
    await assert.rejects(f.run('block'), /no longer a member of this server/);
    assert.equal(f.writes.length, 0);
});

test('server owners, native staff, and moderators granted /perm are protected', async (t) => {
    const f = fixture(t);
    const originalOwnerId = f.guild.ownerId;
    f.guild.ownerId = f.target.id;
    await assert.rejects(f.run('block'), /Server staff/);
    f.guild.ownerId = originalOwnerId;
    f.target.permissions.add(P.Administrator);
    await assert.rejects(f.run('block'), /Server staff/);
    await assert.rejects(f.run('kick'), /Server staff/);
    f.target.permissions.remove(P.Administrator).add(P.ModerateMembers);
    await assert.rejects(f.run('block'), /Server staff/);
    f.target.permissions.remove(P.ModerateMembers);
    const { grantPermission } = require('../src/permissions');
    grantPermission(f.guild.id, 'warn', f.target.id);
    await assert.rejects(f.run('block'), /Server staff/);
    assert.equal(f.writes.length, 0);
    assert.equal(f.disconnects.length, 0);
});

test('missing bot permissions prevent Discord mutations', async (t) => {
    const f = fixture(t);
    f.channel.botPermissions.remove(P.MoveMembers);
    await assert.rejects(f.run('kick'), /Move Members/);
    await assert.rejects(f.run('block'), /Move Members/);
    f.channel.botPermissions.add(P.MoveMembers).remove(P.ManageRoles);
    await assert.rejects(f.run('block'), /Manage Roles/);
    assert.equal(f.disconnects.length, 0);
    assert.equal(f.writes.length, 0);
    f.channel.botPermissions.add(P.ManageRoles);
    await f.run('block');
    f.channel.botPermissions.remove(P.ManageRoles);
    await assert.rejects(f.run('unblock'), /Manage Roles/);
    assert.equal(f.overwrites.get(f.target.id).deny.has(P.Connect), true);
});

test('unblock never uses an old allow to bypass a later lock or role restriction', async (t) => {
    const f = fixture(t, { connected: false });
    f.overwrites.set(f.target.id, f.overwrite(P.Connect, P.Stream));
    await f.run('block');
    f.overwrites.set(f.guild.id, f.overwrite(0n, P.Connect | P.ViewChannel));
    assert.match(await f.run('unblock'), /respect current channel restrictions/);
    assert.equal(f.overwrites.get(f.target.id).allow.has(P.Connect), false);
    assert.equal(f.overwrites.get(f.target.id).deny.has(P.Stream), true);
    assert.equal(f.overwrites.get(f.guild.id).deny.has([P.Connect, P.ViewChannel]), true);
    f.overwrites.delete(f.guild.id);
    f.overwrites.get(f.target.id).allow.add(P.Connect);
    await f.run('block');
    f.channel.roleOverwrites.push(f.overwrite(0n, P.Connect));
    await f.run('unblock');
    assert.equal(f.overwrites.get(f.target.id).allow.has(P.Connect), false);
});

test('an existing explicit deny remains owned by staff and duplicate blocks do not write', async (t) => {
    const f = fixture(t, { connected: false });
    f.overwrites.set(f.target.id, f.overwrite(0n, P.Connect));
    await assert.rejects(f.run('block'), /set outside this control/);
    await assert.rejects(f.run('unblock'), /no block/);
    assert.equal(f.overwrites.get(f.target.id).deny.has(P.Connect), true);
    assert.equal(f.writes.length, 0);
    f.overwrites.delete(f.target.id);
    await f.run('block');
    await assert.rejects(f.run('block'), /already blocked/);
    assert.equal(f.writes.length, 1);
});

test('administrator Connect edits win even if an observed deny is later re-applied', async (t) => {
    const f = fixture(t, { connected: false });
    await f.run('block');
    const old = { permissionOverwrites: { cache: new Map(f.overwrites) } };
    f.overwrites.set(f.target.id, f.overwrite(P.Connect));
    moderation.observePermissionChanges(old, f.channel);
    f.overwrites.set(f.target.id, f.overwrite(0n, P.Connect));
    await assert.rejects(f.run('unblock'), /did not confirm who set this restriction/);
    assert.equal(f.overwrites.get(f.target.id).deny.has(P.Connect), true);
    f.overwrites.set(f.target.id, f.overwrite(P.Connect));
    const page = await moderation.listBlocked(f.guild, f.owner);
    assert.equal(page.entries.length, 0);
    assert.match(await f.run('unblock'), /already changed/);
    assert.equal(f.overwrites.get(f.target.id).allow.has(P.Connect), true);
    assert.equal(f.writes.length, 1);
});

test('blocks follow the VC on claim, and a still-connected blocked member cannot claim', async (t) => {
    const f = fixture(t, { connected: false });
    await f.run('block');
    assert.match(tv.addSpawned(f.channel.id, f.guild.id, f.target.id, 'trigger').error, /blocked member/);
    const nextOwner = { id: f.guild.ownerId, guild: f.guild, voice: { channelId: f.channel.id } };
    assert.equal(tv.addSpawned(f.channel.id, f.guild.id, nextOwner.id, 'trigger').success, true);
    await assert.rejects(f.run('unblock'), /Only the owner/);
    assert.deepEqual((await moderation.listBlocked(f.guild, nextOwner)).entries.map(row => row.user_id), [f.target.id]);
    await moderation.moderate('unblock', f.guild, nextOwner, f.target.id);
    assert.equal(f.overwrites.has(f.target.id), false);
});

test('manual deletion and startup orphan cleanup cascade blocks while failed deletion preserves them', async (t) => {
    const f = fixture(t, { connected: false });
    await f.run('block');
    const failure = t.mock.method(f.channel, 'delete', async () => { throw Error('temporary failure'); });
    await assert.rejects(tv.deleteOwnedChannel(f.guild, f.owner.id), /temporary failure/);
    assert.equal((await moderation.listBlocked(f.guild, f.owner)).entries.length, 1);
    failure.mock.restore();
    tv.deleteRecordOnChannelDelete(f.channel);
    assert.equal(tv.getSpawnedChannel(f.channel.id), null);
    const records = () => getDb().prepare('SELECT count(*) AS count FROM temp_vc_blocks WHERE channel_id = ?').get(f.channel.id).count;
    assert.equal(records(), 0);
    tv.addSpawned(f.channel.id, f.guild.id, f.owner.id, 'trigger');
    f.overwrites.clear();
    assert.deepEqual((await moderation.listBlocked(f.guild, f.owner)).entries, []);
    await f.run('block');
    f.guild.channels.cache.delete(f.channel.id);
    await tv.cleanupOrphans({ guilds: { cache: new Map([[f.guild.id, f.guild]]) } });
    assert.equal(tv.getSpawnedChannel(f.channel.id), null);
    assert.equal(records(), 0);
});

test('a replacement channel cannot see the old VC’s blocks during its deletion grace period', async (t) => {
    const f = fixture(t, { connected: false });
    await f.run('block');
    f.channel.members.clear();
    const replacement = { ...f.channel, id: '700' + f.channel.id.slice(3) };
    f.guild.channels.create = async () => {
        f.guild.channels.cache.set(replacement.id, replacement);
        return replacement;
    };
    f.owner.voice.setChannel = async channel => { f.owner.voice.channelId = channel.id; };
    t.after(() => {
        tv.cancelDeletion(f.channel.id);
        tv.removeSpawned(replacement.id);
    });
    assert.equal((await tv.spawnChannel(f.guild, f.owner, { channel_id: 'trigger' })).id, replacement.id);
    assert.equal(getDb().prepare('SELECT channel_id FROM temp_vc_blocks WHERE user_id = ?').get(f.target.id).channel_id, f.channel.id);
    assert.deepEqual((await moderation.listBlocked(f.guild, f.owner)).entries, []);
});

test('a concurrent unblock or claim cannot interleave with an in-flight block', async (t) => {
    const f = fixture(t, { connected: false });
    const edit = f.channel.permissionOverwrites.edit;
    const started = Promise.withResolvers();
    const finish = Promise.withResolvers();
    t.mock.method(f.channel.permissionOverwrites, 'edit', async (...args) => {
        started.resolve();
        await finish.promise;
        return edit(...args);
    });
    const blocking = f.run('block');
    await started.promise;
    try {
        await assert.rejects(f.run('unblock'), { code: 'TEMP_VC_BUSY' });
        assert.match(tv.addSpawned(f.channel.id, f.guild.id, f.guild.ownerId, 'trigger').error, /in progress/);
    } finally {
        finish.resolve();
        await blocking;
    }
    await f.run('unblock');
    assert.equal(f.overwrites.has(f.target.id), false);
});

test('a rejected permission edit can be retried and an unconfirmed accepted edit stays safe after restart', async (t) => {
    const f = fixture(t, { connected: false });
    const edit = f.channel.permissionOverwrites.edit;
    const denied = t.mock.method(f.channel.permissionOverwrites, 'edit', async () => {
        throw Object.assign(new Error('Missing Permissions'), { code: RESTJSONErrorCodes.MissingPermissions });
    });
    await assert.rejects(f.run('block'), /Missing Permissions/);
    assert.deepEqual((await moderation.listBlocked(f.guild, f.owner)).entries, []);
    denied.mock.restore();
    t.mock.method(f.channel.permissionOverwrites, 'edit', async (...args) => {
        await edit(...args);
        throw new Error('lost Discord response');
    });
    await assert.rejects(f.run('block'), /lost Discord response/);
    closeDb();
    assert.equal((await moderation.listBlocked(f.guild, f.owner)).entries[0].confirmed, 0);
    await assert.rejects(f.run('unblock'), /Ask server staff/);
    assert.equal(f.overwrites.get(f.target.id).deny.has(P.Connect), true);
});

test('failed unblock is retryable and failed disconnect leaves a confirmed block', async (t) => {
    const f = fixture(t);
    const failDisconnect = t.mock.method(f.target.voice, 'disconnect', async () => { throw new Error('disconnect unavailable'); });
    assert.match(await f.run('block'), /could not confirm they were disconnected/);
    assert.equal((await moderation.listBlocked(f.guild, f.owner)).entries[0].confirmed, 1);
    failDisconnect.mock.restore();
    assert.match(await f.run('kick'), /disconnected/i);
    const failDelete = t.mock.method(f.channel.permissionOverwrites, 'delete', async () => { throw new Error('overwrite unavailable'); });
    await assert.rejects(f.run('unblock'), /overwrite unavailable/);
    assert.equal((await moderation.listBlocked(f.guild, f.owner)).entries.length, 1);
    failDelete.mock.restore();
    await f.run('unblock');
    assert.deepEqual((await moderation.listBlocked(f.guild, f.owner)).entries, []);
});

test('voice category logs include the guild, channel, actor, target, action, and timestamp', async (t) => {
    const f = fixture(t);
    const { updateGuildConfig } = require('../src/config');
    const { setLoggerClient } = require('../src/logging');
    const sent = [];
    const logChannel = { guildId: f.guild.id, async send(message) { sent.push(message.embeds[0].toJSON()); } };
    const logChannelId = '800' + f.channel.id.slice(3);
    updateGuildConfig(f.guild.id, config => {
        config.logChannels.voice = logChannelId;
        return config;
    });
    setLoggerClient({ channels: { cache: new Map([[logChannelId, logChannel]]) } });
    t.after(() => setLoggerClient(null));
    await f.run('kick');
    await f.run('block');
    await f.run('unblock');
    assert.deepEqual(sent.map(embed => embed.title), [
        'Temporary VC member kicked', 'Temporary VC member blocked', 'Temporary VC member unblocked',
    ]);
    for (const entry of sent) {
        const fields = entry.fields.map(field => field.value).join('\n');
        assert.ok([f.guild.id, f.channel.id, f.owner.id, f.target.id].every(id => fields.includes(id)));
        assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
    }
});

test('a failed intent write stops before the Discord edit and a failed confirmation is recoverable', async (t) => {
    const f = fixture(t, { connected: false });
    const db = getDb();
    db.exec(`
        CREATE TEMP TRIGGER fail_block_intent BEFORE INSERT ON temp_vc_blocks
        BEGIN SELECT RAISE(ABORT, 'intent unavailable'); END;
    `);
    try {
        await assert.rejects(f.run('block'), /intent unavailable/);
        assert.equal(f.writes.length, 0);
    } finally {
        db.exec('DROP TRIGGER fail_block_intent');
    }
    db.exec(`
        CREATE TEMP TRIGGER fail_block_confirmation BEFORE UPDATE ON temp_vc_blocks
        BEGIN SELECT RAISE(ABORT, 'confirmation unavailable'); END;
    `);
    try {
        await assert.rejects(f.run('block'), /confirmation unavailable/);
        assert.equal((await moderation.listBlocked(f.guild, f.owner)).entries[0].confirmed, 0);
    } finally {
        db.exec('DROP TRIGGER fail_block_confirmation');
    }
    // A staff adjustment clears the unconfirmed denial, so the owner can
    // reconcile the record without creating an overwrite.
    f.overwrites.delete(f.target.id);
    assert.match(await f.run('unblock'), /already changed/);
    assert.equal(f.writes.length, 1);
});

test('lock and unlock preserve a member block and unrelated permissions', async (t) => {
    const f = fixture(t, { connected: false });
    f.overwrites.set(f.guild.id, f.overwrite(0n, P.ViewChannel));
    f.overwrites.set(f.owner.id, f.overwrite(P.Speak));
    await f.run('block');
    await tv.setChannelLocked(f.channel, f.guild, f.owner, true);
    assert.equal(f.overwrites.get(f.guild.id).deny.has([P.ViewChannel, P.Connect]), true);
    await tv.setChannelLocked(f.channel, f.guild, f.owner, false);
    assert.equal(f.overwrites.get(f.guild.id).deny.has(P.ViewChannel), true);
    assert.equal(f.overwrites.get(f.guild.id).deny.has(P.Connect), false);
    assert.equal(f.overwrites.get(f.owner.id).allow.has(P.Speak), true);
    assert.equal(f.overwrites.get(f.target.id).deny.has(P.Connect), true);
});

function component(f, type, customId, { member = f.owner, values = [] } = {}) {
    const responses = [];
    return {
        responses, values, customId, member, guild: f.guild, user: { id: member.id },
        isButton: () => type === 'button',
        isModalSubmit: () => false,
        isStringSelectMenu: () => false,
        isUserSelectMenu: () => type === 'userSelect',
        async reply(payload) { responses.push(payload); },
        async deferReply(payload) { this.deferred = true; this.deferredReply = payload; },
        async deferUpdate() { this.deferred = true; },
        async editReply(payload) { responses.push(payload); },
        async followUp(payload) { responses.push(payload); },
    };
}

test('slash commands and panel selections share a cooldown and the same moderation behavior', async (t) => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    const f = fixture(t);
    const { runCommand } = require('../src/commandPipeline');
    const { handleInteraction } = require('../src/interactions');
    const slash = component(f, 'slash');
    slash.commandName = 'tempvc';
    slash.options = { getSubcommand: () => 'kick', getUser: () => ({ id: f.target.id }) };
    assert.equal(await runCommand(slash), true);
    assert.equal(slash.deferredReply.flags, 64);
    assert.match(slash.responses[0].content, /Disconnected/);
    const button = component(f, 'button', 'tvc_block');
    await handleInteraction(button);
    const menuId = button.responses[0].components[0].toJSON().components[0].custom_id;
    const click = () => component(f, 'userSelect', menuId, { values: [f.target.id] });
    const tooSoon = click();
    await handleInteraction(tooSoon);
    assert.match(tooSoon.responses[0].content, /Please wait/);
    assert.equal(f.writes.length, 0);
    t.mock.timers.tick(3100);
    const accepted = click();
    await handleInteraction(accepted);
    assert.match(accepted.responses[0].content, /Blocked/);
    assert.equal(f.writes.length, 1);
    const coolDown = component(f, 'slash');
    coolDown.commandName = 'tempvc';
    coolDown.options = { getSubcommand: () => 'unblock', getUser: () => ({ id: f.target.id }) };
    await runCommand(coolDown);
    assert.match(coolDown.responses[0].content, /Please wait/);
});

test('selection and pagination revalidate the invoking member and channel independently', async (t) => {
    const f = fixture(t, { connected: false });
    const { handleInteraction } = require('../src/interactions');
    const buttons = tv.buildPanelComponents().flatMap(row => row.toJSON().components);
    assert.deepEqual(buttons.slice(-4).map(b => b.label), ['Kick Member', 'Block Member', 'Unblock Member', 'View Blocked Members']);
    const button = component(f, 'button', 'tvc_block');
    await handleInteraction(button);
    const menuId = button.responses[0].components[0].toJSON().components[0].custom_id;
    const wrongUser = component(f, 'userSelect', menuId, { member: f.target, values: [f.owner.id] });
    await handleInteraction(wrongUser);
    assert.match(wrongUser.responses[0].content, /Open a new/);
    const original = f.owner;
    const nextOwner = { id: f.guild.ownerId, guild: f.guild, voice: { channelId: f.channel.id } };
    tv.addSpawned(f.channel.id, f.guild.id, nextOwner.id, 'trigger');
    const stale = component(f, 'userSelect', menuId, { values: [f.target.id] });
    await handleInteraction(stale);
    assert.match(stale.responses[0].content, /Only the owner/);
    assert.equal(f.writes.length, 0);

    const db = getDb();
    const add = db.prepare('INSERT INTO temp_vc_blocks VALUES (?, ?, 0, 0, 1)');
    for (let i = 0; i < 23; i++) {
        const id = String(900000000000000000n + BigInt(i));
        add.run(f.channel.id, id);
        f.overwrites.set(id, f.overwrite(0n, P.Connect));
    }
    const list = component(f, 'button', 'tvc_blocked', { member: nextOwner });
    await handleInteraction(list);
    assert.match(list.responses[0].content, /Page 1 of 2/);
    assert.match(list.responses[0].content, /900000000000000000/);
    const navigation = list.responses[0].components[0].toJSON().components;
    const bystander = component(f, 'button', navigation[1].custom_id, { member: original });
    await handleInteraction(bystander);
    assert.match(bystander.responses[0].content, /Open your own/);
    const next = component(f, 'button', navigation[1].custom_id, { member: nextOwner });
    await handleInteraction(next);
    assert.match(next.responses[0].content, /Page 2 of 2/);
    assert.match(next.responses[0].content, /900000000000000022/);
    assert.doesNotMatch(next.responses[0].content, /900000000000000000/);
    assert.deepEqual(next.responses[0].allowedMentions.parse, []);
});

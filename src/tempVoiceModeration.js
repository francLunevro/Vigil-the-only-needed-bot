const { EmbedBuilder, OverwriteType, PermissionFlagsBits: P, RESTJSONErrorCodes } = require('discord.js');
const { getDb } = require('./db');
const { hasModerationAuthority } = require('./modGuard');
const { sendLog } = require('./logging');
const { logError } = require('./logError');
const tv = require('./tempVoice');

const PAGE_SIZE = 20;
const MUTATIONS = ['kick', 'block', 'unblock'];
const USER_ID = /^\d{17,20}$/;

function refuse(message) {
    const error = new Error(message);
    error.code = 'TEMP_VC_MODERATION';
    throw error;
}

function ownedChannel(guild, actor, expectedId) {
    if (!guild || actor?.guild?.id !== guild.id) refuse('Use this control in your server.');
    const found = tv.getMemberChannelFor(guild, actor);
    if (!found || found.row.guild_id !== guild.id || found.row.owner_id !== actor.id ||
        !tv.isVoiceChannel(found.channel) || found.channel.guildId !== guild.id) {
        refuse('Only the owner of this temporary voice channel can use its moderation controls.');
    }
    if (expectedId && found.channel.id !== expectedId) refuse('This control is for a different temporary voice channel. Open a new one.');
    return found.channel;
}

async function fetchChannel(guild, channelId) {
    const channel = await guild.channels.fetch(channelId, { force: true });
    if (!tv.isVoiceChannel(channel) || channel.guildId !== guild.id || channel.id !== channelId) {
        refuse('That temporary voice channel is no longer available.');
    }
    return channel;
}

async function fetchTarget(guild, targetId) {
    try {
        const member = await guild.members.fetch({ user: targetId, force: true });
        return member?.guild?.id === guild.id && member.id === targetId ? member : null;
    } catch (err) {
        if (err.code === RESTJSONErrorCodes.UnknownMember || err.code === RESTJSONErrorCodes.UnknownUser) return null;
        throw err;
    }
}

async function voiceState(guild, targetId) {
    try {
        return await guild.voiceStates.fetch(targetId, { force: true, cache: false });
    } catch (err) {
        if (err.code === RESTJSONErrorCodes.UnknownVoiceState || err.code === RESTJSONErrorCodes.UnknownMember) return null;
        throw err;
    }
}

function requireBotPermission(channel, bit, name) {
    const bot = channel.guild.members.me;
    if (!bot || !channel.permissionsFor(bot)?.has(bit)) refuse('Vigil needs **' + name + '** in this voice channel.');
}

function connectState(overwrite) {
    if (overwrite?.deny.has(P.Connect)) return false;
    return overwrite?.allow.has(P.Connect) ? true : null;
}

function forgetBlock(channelId, targetId) {
    getDb().prepare('DELETE FROM temp_vc_blocks WHERE channel_id = ? AND user_id = ?').run(channelId, targetId);
}

function editConnect(channel, targetId, value, reason) {
    return channel.permissionOverwrites.edit(targetId, { Connect: value }, { type: OverwriteType.Member, reason });
}

function logAction(action, guild, channel, actor, targetId, note) {
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Temporary VC member ' + { kick: 'kicked', block: 'blocked', unblock: 'unblocked' }[action])
        .addFields(
            { name: 'Server ID', value: guild.id, inline: true },
            { name: 'Voice channel', value: '<#' + channel.id + '> (`' + channel.id + '`)', inline: true },
            { name: 'Channel owner', value: '<@' + actor.id + '> (`' + actor.id + '`)', inline: true },
            { name: 'Member', value: '<@' + targetId + '> (`' + targetId + '`)', inline: true },
        )
        .setTimestamp();
    if (note) embed.setDescription(note);
    sendLog(embed, 'voice', channel.id, guild.id).catch(err => logError(err, 'tempvoice', 'moderation_log'));
}

async function applyBlock(guild, actor, channel, target, oldOverwrite, reason) {
    const db = getDb();
    const channelId = channel.id;
    const targetId = target.id;
    db.prepare(`
        INSERT INTO temp_vc_blocks (channel_id, user_id, previous_allow, had_overwrite) VALUES (?, ?, ?, ?)
    `).run(channelId, targetId, Number(connectState(oldOverwrite) === true), Number(!!oldOverwrite));
    try {
        await editConnect(channel, targetId, false, reason);
    } catch (err) {
        // A timeout or 5xx can follow an accepted write. Keep the intent so
        // a later unblock cannot accidentally remove a deny we can't attribute.
        if ([RESTJSONErrorCodes.MissingAccess, RESTJSONErrorCodes.MissingPermissions,
            RESTJSONErrorCodes.UnknownChannel, RESTJSONErrorCodes.UnknownMember, RESTJSONErrorCodes.UnknownUser].includes(err.code)) {
            forgetBlock(channelId, targetId);
        }
        throw err;
    }
    logAction('block', guild, channel, actor, targetId);
    db.prepare('UPDATE temp_vc_blocks SET confirmed = 1 WHERE channel_id = ? AND user_id = ?').run(channelId, targetId);
}

function canRestoreAllow(channel, member) {
    // Match Discord's overwrite precedence with the member Connect bit
    // omitted. An old member allow must not bypass today's restrictions.
    const overwrites = channel.overwritesFor(member);
    let connect = member.permissions.has(P.Connect);
    if (overwrites.everyone?.deny.has(P.Connect)) connect = false;
    if (overwrites.everyone?.allow.has(P.Connect)) connect = true;
    if (overwrites.roles.some(role => role.deny.has(P.Connect))) connect = false;
    if (overwrites.roles.some(role => role.allow.has(P.Connect))) connect = true;
    return connect && channel.permissionsFor(member)?.has(P.ViewChannel);
}

async function removeBlock(guild, actor, channel, target, targetId, block, overwrite, reason) {
    if (!block) refuse('Vigil has no block for this member in your voice channel.');
    if (connectState(overwrite) !== false) {
        forgetBlock(channel.id, targetId);
        return 'ℹ️ The channel permissions already changed. Vigil cleared its record without editing Discord permissions.';
    }
    if (!block.confirmed) refuse('Discord did not confirm who set this restriction. Ask server staff to review the channel permissions.');
    requireBotPermission(channel, P.ManageRoles, 'Manage Roles');
    const restoreAllow = !!(block.previous_allow && target && canRestoreAllow(channel, target));
    const deleteEmpty = !block.had_overwrite && !overwrite.allow.bitfield && overwrite.deny.bitfield === P.Connect;
    if (deleteEmpty) {
        await channel.permissionOverwrites.delete(targetId, reason);
    } else {
        if (!target) refuse('This member left the server. Ask server staff to review their remaining channel permissions.');
        await editConnect(channel, targetId, restoreAllow ? true : null, reason);
    }
    const note = block.previous_allow && !restoreAllow ? 'The old Connect allowance was cleared to respect current channel restrictions.' : '';
    logAction('unblock', guild, channel, actor, targetId, note);
    forgetBlock(channel.id, targetId);
    return '✅ Unblocked <@' + targetId + '> in <#' + channel.id + '>.' + (note ? ' ' + note : '');
}

async function moderate(action, guild, actor, targetId, { expectedId } = {}) {
    if (!MUTATIONS.includes(action) || !USER_ID.test(targetId)) refuse('Select a valid server member.');
    const { id: channelId } = ownedChannel(guild, actor, expectedId);
    if (actor.id === targetId && action !== 'unblock') refuse('You can’t ' + action + ' yourself.');

    return tv.withChannelAction(channelId, async () => {
        const target = await fetchTarget(guild, targetId);
        if (action !== 'unblock' && !target) refuse('That user is no longer a member of this server.');
        const connected = action === 'block' && (await voiceState(guild, targetId))?.channelId === channelId;
        const channel = await fetchChannel(guild, channelId);
        ownedChannel(guild, actor, channelId);
        const reason = 'Temp VC ' + action + ' by owner ' + actor.id + ' for member ' + targetId;

        if (action !== 'unblock' && (target.id === guild.members.me?.id || hasModerationAuthority(guild, target, channel))) {
            refuse('Server staff and Vigil are protected from temporary voice moderation.');
        }

        if (action === 'kick') {
            requireBotPermission(channel, P.MoveMembers, 'Move Members');
            const current = await voiceState(guild, targetId);
            ownedChannel(guild, actor, channelId);
            if (current?.channelId !== channelId) refuse('That member must be connected to your temporary voice channel.');
            await current.disconnect(reason);
            logAction('kick', guild, channel, actor, targetId);
            return '✅ Disconnected <@' + targetId + '> from <#' + channelId + '>. They can rejoin if they have access.';
        }

        const block = getDb().prepare('SELECT * FROM temp_vc_blocks WHERE channel_id = ? AND user_id = ?').get(channelId, targetId);
        const overwrite = channel.permissionOverwrites.cache.get(targetId);
        if (action === 'unblock') return removeBlock(guild, actor, channel, target, targetId, block, overwrite, reason);
        if (block && connectState(overwrite) === false) {
            if (!block.confirmed) refuse('Discord did not confirm who set this restriction. Ask server staff to review the channel permissions.');
            refuse('That member is already blocked. Use **Kick Member** if they are still connected.');
        }
        if (block) {
            forgetBlock(channelId, targetId);
            if (block.confirmed) refuse('The previous block was changed outside this control. Check the current permissions before blocking again.');
        }
        if (connectState(overwrite) === false) refuse('That member already has a channel-level Connect denial set outside this control.');
        requireBotPermission(channel, P.ManageRoles, 'Manage Roles');
        if (connected) requireBotPermission(channel, P.MoveMembers, 'Move Members');
        await applyBlock(guild, actor, channel, target, overwrite, reason);

        try {
            const current = await voiceState(guild, targetId);
            ownedChannel(guild, actor, channelId);
            if (current?.channelId === channelId) {
                requireBotPermission(channel, P.MoveMembers, 'Move Members');
                await current.disconnect(reason);
            }
        } catch (err) {
            logError(err, 'tempvoice', 'block_disconnect');
            return '⚠️ Blocked <@' + targetId + '>, but Vigil could not confirm they were disconnected. Use **Kick Member** if they are still in the channel.';
        }
        return '✅ Blocked <@' + targetId + '> from joining <#' + channelId + '>.';
    });
}

async function listBlocked(guild, actor, { expectedId, page = 0 } = {}) {
    const { id: channelId } = ownedChannel(guild, actor, expectedId);
    const channel = await fetchChannel(guild, channelId);
    ownedChannel(guild, actor, channelId);
    const rows = getDb().prepare('SELECT user_id, confirmed FROM temp_vc_blocks WHERE channel_id = ? ORDER BY user_id').all(channelId);
    const active = rows.filter(row => connectState(channel.permissionOverwrites.cache.get(row.user_id)) === false);
    const pages = Math.max(1, Math.ceil(active.length / PAGE_SIZE));
    const index = Math.max(0, Math.min(Number.isSafeInteger(page) ? page : 0, pages - 1));
    return { channelId, entries: active.slice(index * PAGE_SIZE, (index + 1) * PAGE_SIZE), index, pages };
}

function observePermissionChanges(oldChannel, newChannel) {
    const oldOverwrites = oldChannel.permissionOverwrites?.cache;
    const newOverwrites = newChannel.permissionOverwrites?.cache;
    if (!oldOverwrites || !newOverwrites) return;
    let markUnconfirmed;
    for (const [id, overwrite] of oldOverwrites) {
        if (overwrite.type !== OverwriteType.Member || connectState(overwrite) !== false ||
            connectState(newOverwrites.get(id)) === false) continue;
        // If someone later re-applies the deny, the old Vigil record no
        // longer establishes who owns it. Keep the row for reconciliation.
        markUnconfirmed ??= getDb().prepare(`
            UPDATE temp_vc_blocks SET confirmed = 0 WHERE channel_id = ? AND user_id = ? AND confirmed = 1
        `);
        markUnconfirmed.run(newChannel.id, id);
    }
}

module.exports = { MUTATIONS, ownedChannel, moderate, listBlocked, observePermissionChanges };

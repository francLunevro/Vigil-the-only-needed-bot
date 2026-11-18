const { isOwner } = require('./helpers');
const { PermissionFlagsBits } = require('discord.js');
const { hasPermission } = require('./permissions');

const MODERATION_GRANTS = [
    'kick', 'ban', 'tempban', 'unban', 'timeout', 'untimeout', 'warn', 'clearwarnings',
    'purge', 'lock', 'unlock', 'slowmode', 'role', 'nickname', 'tempvc',
];

function hasModerationAuthority(guild, member, channel) {
    return isOwner(member.id) || member.id === guild.ownerId ||
        member.permissions.any([
            PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageGuild,
            PermissionFlagsBits.KickMembers, PermissionFlagsBits.BanMembers, PermissionFlagsBits.ModerateMembers,
        ]) ||
        channel.permissionsFor(member)?.any([PermissionFlagsBits.MoveMembers, PermissionFlagsBits.ManageChannels]) ||
        MODERATION_GRANTS.some(command => hasPermission(guild.id, command, member.id));
}

module.exports = { hasModerationAuthority };

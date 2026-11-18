const { EmbedBuilder } = require('discord.js');
const {
    listCustomCommands, setCustomCommand, deleteCustomCommand,
    listAutoresponders, addAutoresponder, updateAutoresponder, deleteAutoresponder,
    MAX_PER_GUILD,
} = require('../customCommands');
const { getGuildConfig } = require('../config');

const MATCH_LABELS = {
    exact: 'exact message',
    contains: 'contains',
    startswith: 'starts with',
    regex: 'regular expression',
};

// /customcommand add|remove|list
async function executeCustomCommand(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'add') {
        const name = interaction.options.getString('name');
        const response = interaction.options.getString('response');
        const asEmbed = interaction.options.getBoolean('embed') || false;
        const result = setCustomCommand(guildId, name, { response, asEmbed }, interaction.user.id);
        if (result.error) {
            return interaction.reply({ content: '⚠️ ' + result.error, ephemeral: true });
        }
        const prefix = getGuildConfig(guildId).prefix || ';';
        const embed = new EmbedBuilder()
            .setColor(0x3BA55C)
            .setTitle(result.created ? '✅ Custom command created' : '✅ Custom command updated')
            .setDescription('`' + prefix + result.command.name + '` now replies with:\n' + result.command.response.slice(0, 900))
            .setFooter({ text: 'Placeholders: {user} {username} {server} {membercount} {channel} {args} · caps at 2000 characters' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'remove') {
        const name = interaction.options.getString('name');
        const removed = deleteCustomCommand(guildId, name);
        return interaction.reply({
            content: removed ? '🗑️ Deleted `' + String(name).toLowerCase() + '`.' : '⚠️ No custom command called `' + String(name).toLowerCase() + '`.',
            ephemeral: true,
        });
    }

    const commands = listCustomCommands(guildId);
    if (!commands.length) {
        return interaction.reply({ content: 'No custom commands yet. Add one with `/customcommand add`.', ephemeral: true });
    }
    const prefix = getGuildConfig(guildId).prefix || ';';
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('⌨️ Custom Commands')
        .setDescription(commands.slice(0, 25).map(c =>
            '`' + prefix + c.name + '` — ' + c.response.replace(/\s+/g, ' ').slice(0, 60) + (c.uses ? ' *(' + c.uses + ' uses)*' : '')
        ).join('\n'))
        .setFooter({ text: commands.length + '/' + MAX_PER_GUILD + ' used' });
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

// /autoresponder add|remove|toggle|list
async function executeAutoresponder(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild.id;

    if (sub === 'add') {
        const options = {
            trigger: interaction.options.getString('trigger'),
            response: interaction.options.getString('response'),
            matchType: interaction.options.getString('match') || 'contains',
            channelId: interaction.options.getChannel('channel') ? interaction.options.getChannel('channel').id : null,
        };
        const result = addAutoresponder(guildId, options, interaction.user.id);
        if (result.error) {
            return interaction.reply({ content: '⚠️ ' + result.error, ephemeral: true });
        }
        const r = result.responder;
        const embed = new EmbedBuilder()
            .setColor(0x3BA55C)
            .setTitle('✅ Autoresponder created')
            .addFields(
                { name: 'Trigger', value: '`' + r.trigger + '` (' + MATCH_LABELS[r.matchType] + ')' },
                { name: 'Scope', value: r.channelId ? '<#' + r.channelId + '> only' : 'Every channel' },
                { name: 'Responds with', value: r.response.slice(0, 900) },
            )
            .setFooter({ text: 'ID: ' + r.id + ' · use /autoresponder remove to delete it' });
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'toggle') {
        const id = interaction.options.getString('id');
        const enabled = interaction.options.getBoolean('enabled');
        const result = updateAutoresponder(guildId, id, { enabled });
        if (result.error) return interaction.reply({ content: '⚠️ ' + result.error, ephemeral: true });
        return interaction.reply({ content: (enabled ? '✅ Enabled' : '⏸️ Paused') + ' `' + result.responder.trigger + '`.', ephemeral: true });
    }

    if (sub === 'remove') {
        const id = interaction.options.getString('id');
        const removed = deleteAutoresponder(guildId, id);
        return interaction.reply({ content: removed ? '🗑️ Autoresponder deleted.' : '⚠️ No autoresponder with that ID.', ephemeral: true });
    }

    const responders = listAutoresponders(guildId);
    if (!responders.length) {
        return interaction.reply({ content: 'No autoresponders yet. Add one with `/autoresponder add`.', ephemeral: true });
    }
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('💬 Autoresponders')
        .setDescription(responders.slice(0, 25).map(r =>
            (r.enabled ? '🟢' : '⏸️') + ' `' + r.id + '` **' + r.trigger + '** (' + r.matchType + ')' +
            (r.channelId ? ' in <#' + r.channelId + '>' : '') + ' → ' + r.response.replace(/\s+/g, ' ').slice(0, 50)
        ).join('\n'))
        .setFooter({ text: 'Disable one with /autoresponder toggle <id> enabled:false' });
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { executeCustomCommand, executeAutoresponder };

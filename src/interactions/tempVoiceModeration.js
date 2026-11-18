const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, UserSelectMenuBuilder, RESTJSONErrorCodes } = require('discord.js');
const { MUTATIONS, ownedChannel, moderate, listBlocked } = require('../tempVoiceModeration');
const { logError } = require('../logError');

const labels = { kick: 'Kick Member', block: 'Block Member', unblock: 'Unblock Member' };
const noMentions = { parse: [] };

function errorReply(err) {
    if (err.code === 'TEMP_VC_MODERATION' || err.code === 'TEMP_VC_BUSY') return '❌ ' + err.message;
    logError(err, 'tempvoice', 'owner_moderation');
    if (err.status === 429 || err.name === 'RateLimitError') return '⏳ Discord is rate limiting this action. Try again shortly.';
    if (err.code === RESTJSONErrorCodes.UnknownChannel) return '❌ That temporary voice channel is gone.';
    if (err.code === RESTJSONErrorCodes.MissingAccess || err.code === RESTJSONErrorCodes.MissingPermissions) {
        return '❌ Discord denied the action. Ask staff to check Vigil’s permissions in that voice channel.';
    }
    return '❌ Vigil could not confirm the action. Check **View Blocked Members** before retrying a permission change.';
}

async function blockedPage(interaction, options) {
    const { guild, member, user } = interaction;
    const { entries, channelId, index, pages } = await listBlocked(guild, member, options);
    const lines = entries.map(entry => {
        const mention = guild.members.cache.has(entry.user_id) ? '<@' + entry.user_id + '> ' : '';
        return '• ' + mention + '`' + entry.user_id + '`' + (entry.confirmed ? '' : ' (unconfirmed)');
    });
    const content = '**Blocked members in <#' + channelId + '>**\n' + (lines.join('\n') || 'Nobody is blocked by Vigil.');
    const components = [];
    if (pages > 1) {
        const pageButton = (label, next, disabled) => new ButtonBuilder()
            .setCustomId('tvc_page_' + user.id + '_' + channelId + '_' + next)
            .setLabel(label).setStyle(ButtonStyle.Secondary).setDisabled(disabled);
        components.push(new ActionRowBuilder().addComponents(
            pageButton('Previous', index - 1, index === 0),
            pageButton('Next', index + 1, index === pages - 1),
        ));
    }
    return { content: content + (pages > 1 ? '\nPage ' + (index + 1) + ' of ' + pages : ''), components, allowedMentions: noMentions };
}

async function replyWithResult(interaction, action, targetId, options) {
    try {
        const result = action === 'blocked'
            ? await blockedPage(interaction, options)
            : { content: await moderate(action, interaction.guild, interaction.member, targetId, options), components: [], allowedMentions: noMentions };
        return interaction.editReply(result);
    } catch (err) {
        return interaction.editReply({ content: errorReply(err), components: [], allowedMentions: noMentions });
    }
}

async function executeModeration(interaction, action, targetId) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return replyWithResult(interaction, action, targetId);
}

async function handleModerationButton(interaction, [, action, actorId, channelId, page]) {
    if (action === 'blocked') return executeModeration(interaction, action);
    if (action === 'page') {
        if (actorId !== interaction.user.id || !channelId) {
            return interaction.reply({ content: 'Open your own blocked-member list to use this control.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate();
        return replyWithResult(interaction, 'blocked', null, { expectedId: channelId, page: Number(page) });
    }

    let channel;
    try {
        channel = ownedChannel(interaction.guild, interaction.member);
    } catch (err) {
        return interaction.reply({ content: errorReply(err), flags: MessageFlags.Ephemeral });
    }
    const select = new UserSelectMenuBuilder()
        .setCustomId('tvc_select_' + action + '_' + interaction.user.id + '_' + channel.id)
        .setPlaceholder(labels[action]);
    return interaction.reply({
        content: 'Select a member for **' + labels[action] + '** in <#' + channel.id + '>.',
        components: [new ActionRowBuilder().addComponents(select)],
        flags: MessageFlags.Ephemeral,
        allowedMentions: noMentions,
    });
}

async function handleModerationSelection(interaction, [, kind, action, actorId, channelId]) {
    if (kind !== 'select' || actorId !== interaction.user.id || !MUTATIONS.includes(action) ||
        !channelId || !interaction.guild || interaction.values.length !== 1) {
        return interaction.reply({ content: 'Open a new moderation control from the temp voice panel.', flags: MessageFlags.Ephemeral });
    }

    // Use the same cooldown key as slash /tempvc so switching surfaces
    // cannot bypass its per-user, per-guild window.
    const { beginAttempt, chargeCooldown, releaseAttempt } = require('../commandPipeline');
    const guildId = interaction.guild.id;
    const key = 'tempvc';
    await interaction.deferUpdate();
    let reserved = false;
    try {
        const wait = await beginAttempt(key, actorId, guildId);
        if (wait) return interaction.followUp({
            content: '⏳ Please wait **' + wait.remaining + 's** before using temp voice moderation again.',
            flags: MessageFlags.Ephemeral,
        });
        reserved = true;
        return await replyWithResult(interaction, action, interaction.values[0], { expectedId: channelId });
    } catch (err) {
        return interaction.editReply({ content: errorReply(err), components: [], allowedMentions: noMentions });
    } finally {
        if (reserved) {
            try {
                await chargeCooldown(key, actorId, guildId);
            } catch (err) {
                releaseAttempt(key, actorId, guildId);
                logError(err, 'tempvoice', 'moderation_cooldown');
            }
        }
    }
}

module.exports = { executeModeration, handleModerationButton, handleModerationSelection };

// ──────────────────── Temp-Voice panel interaction handlers ────────────────────
// The public "join to create" control panel: create / lock / unlock / rename /
// limit / claim / delete buttons, plus the rename and limit modals. Ownership
// is validated per click, so any member may press buttons on their own panel.
// The temp-VC domain logic lives in ../tempVoice, required lazily so tests can
// patch that module's exports.

const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');
const { isOwner } = require('../helpers');
const { sanitizeForEmbed, validateModalInput } = require('../helpers');
const { logError } = require('../logError');
const { MUTATIONS } = require('../tempVoiceModeration');
const { handleModerationButton } = require('./tempVoiceModeration');

// ──────────────────── Panel Buttons ────────────────────

async function handleTempVcButton(interaction, parts) {
    const action = parts[1]; // tvc_{action}
    const tv = require('../tempVoice');
    const guild = interaction.guild;
    const member = interaction.member;
    const userId = interaction.user.id;
    if (MUTATIONS.includes(action) || action === 'blocked' || action === 'page') {
        return handleModerationButton(interaction, parts);
    }

    if (action === 'create') {
        try {
            const res = await tv.createForMember(guild, member);
            // Fresh spawns are already panel-updated inside spawnChannel;
            // only the reuse path needs a refresh here (nothing changed
            // visually, but the call is cheap and idempotent).
            if (res.reused) tv.updatePanels(guild).catch((err) => logError(err, 'tempvoice', 'updatePanels'));
            return interaction.reply({
                content: res.reused
                    ? '🎧 Moved you back to <#' + res.channel.id + '>.'
                    : '🎧 Created **' + res.channel.name + '** and moved you in!',
                ephemeral: true,
            });
        } catch (err) {
            return interaction.reply({ content: '❌ ' + (err.message || err), ephemeral: true });
        }
    }

    const found = tv.getMemberChannelFor(guild, member);
    if (!found) {
        return interaction.reply({ content: '❌ You\'re not in (and don\'t own) a temp voice channel. Press **Create my VC** first.', ephemeral: true });
    }
    const { row, channel } = found;
    const owns = row.owner_id === userId || isOwner(userId);

    if (action === 'lock' || action === 'unlock') {
        if (!owns) {
            return interaction.reply({ content: '❌ Only the channel owner can ' + action + ' this channel.', ephemeral: true });
        }
        try {
            await tv.setChannelLocked(channel, guild, member, action === 'lock');
            return interaction.reply({ content: action === 'lock' ? '🔒 Channel locked — only you can join now.' : '🔓 Channel unlocked — everyone can join.', ephemeral: true });
        } catch (err) {
            return interaction.reply({ content: '❌ Failed to ' + action + ': ' + (err.message || err), ephemeral: true });
        }
    }

    if (action === 'rename' || action === 'limit') {
        if (!owns) {
            return interaction.reply({ content: '❌ Only the channel owner can do that.', ephemeral: true });
        }
        if (action === 'rename') {
            const modal = new ModalBuilder()
                .setCustomId('tvc_modal_rename')
                .setTitle('Rename your voice channel');
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('tvc_rename_name')
                    .setLabel('New channel name')
                    .setStyle(TextInputStyle.Short)
                    .setRequired(true)
                    .setMaxLength(100)
                    .setPlaceholder('e.g. Chill Zone'),
            ));
            return interaction.showModal(modal);
        }
        const modal = new ModalBuilder()
            .setCustomId('tvc_modal_limit')
            .setTitle('Set user limit');
        modal.addComponents(new ActionRowBuilder().addComponents(
            new TextInputBuilder()
                .setCustomId('tvc_limit_num')
                .setLabel('Max users (0 = unlimited, max 99)')
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(2)
                .setPlaceholder('0-99'),
        ));
        return interaction.showModal(modal);
    }

    if (action === 'claim') {
        const vcId = member.voice && member.voice.channelId;
        const inRow = vcId ? tv.getSpawnedChannel(vcId) : null;
        if (!inRow || inRow.guild_id !== guild.id) {
            return interaction.reply({ content: '❌ You need to be inside a temp voice channel to claim it.', ephemeral: true });
        }
        const ch = guild.channels.cache.get(vcId);
        if (!ch) {
            return interaction.reply({ content: '❌ That channel no longer exists.', ephemeral: true });
        }
        // channel.members is authoritative for who is actually in the VC.
        if (ch.members && ch.members.has(inRow.owner_id)) {
            return interaction.reply({ content: '❌ The owner is still here — no need to claim.', ephemeral: true });
        }
        const saved = tv.addSpawned(vcId, guild.id, userId, inRow.trigger_id);
        if (saved?.error) return interaction.reply({ content: '❌ ' + saved.error, ephemeral: true });
        tv.cancelDeletion(vcId);
        tv.updatePanels(guild).catch((err) => logError(err, 'tempvoice', 'updatePanels'));
        return interaction.reply({ content: '👑 You now own this channel. Use **Rename** / **Lock** / **Delete** to control it.', ephemeral: true });
    }

    if (action === 'delete') {
        if (!owns) {
            return interaction.reply({ content: '❌ Only the channel owner can delete it.', ephemeral: true });
        }
        try {
            await tv.deleteOwnedChannel(guild, userId);
            return interaction.reply({ content: '🗑️ Deleted your temp voice channel.', ephemeral: true });
        } catch (err) {
            return interaction.reply({ content: '❌ ' + (err.message || err), ephemeral: true });
        }
    }

    return interaction.reply({ content: 'Unknown panel action.', ephemeral: true });
}

// ──────────────────── Panel Modals ────────────────────

async function handleTempVcModal(interaction, parts) {
    const action = parts[2]; // tvc_modal_{action}
    const tv = require('../tempVoice');
    const guild = interaction.guild;
    const member = interaction.member;
    const userId = interaction.user.id;

    const found = tv.getMemberChannelFor(guild, member);
    if (!found) {
        return interaction.reply({ content: '❌ You don\'t have a temp voice channel anymore.', ephemeral: true });
    }
    const { row, channel } = found;
    if (row.owner_id !== userId && !isOwner(userId)) {
        return interaction.reply({ content: '❌ Only the channel owner can do that.', ephemeral: true });
    }

    if (action === 'rename') {
        const rawName = interaction.fields.getTextInputValue('tvc_rename_name');
        const validation = validateModalInput(rawName, { required: true, maxLength: tv.MAX_CHANNEL_NAME, allowMarkdown: false });
        if (!validation.valid) {
            return interaction.reply({ content: '❌ ' + validation.error, ephemeral: true });
        }
        const name = validation.value;
        try {
            await channel.setName(name, 'Temp VC renamed');
            return interaction.reply({ content: '✅ Renamed to **' + sanitizeForEmbed(name) + '**.', ephemeral: true });
        } catch (err) {
            return interaction.reply({ content: '❌ Failed to rename: ' + (err.message || err), ephemeral: true });
        }
    }

    if (action === 'limit') {
        const n = parseInt(interaction.fields.getTextInputValue('tvc_limit_num').trim(), 10);
        if (isNaN(n) || n < 0 || n > 99) {
            return interaction.reply({ content: '❌ Enter a number between **0 and 99** (0 = unlimited).', ephemeral: true });
        }
        try {
            await channel.setUserLimit(n, 'Temp VC user limit');
            return interaction.reply({ content: n === 0 ? '✅ User limit cleared (unlimited).' : '✅ User limit set to **' + n + '**.', ephemeral: true });
        } catch (err) {
            return interaction.reply({ content: '❌ Failed to set limit: ' + (err.message || err), ephemeral: true });
        }
    }

    return interaction.reply({ content: 'Unknown form.', ephemeral: true });
}

module.exports = {
    handleTempVcButton,
    handleTempVcModal,
};

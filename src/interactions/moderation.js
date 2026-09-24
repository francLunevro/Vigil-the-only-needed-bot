// ──────────────────── Moderation interaction handlers ────────────────────
// Confirmation buttons for kick / ban / temp-ban / purge, the cancel button,
// and the warn modal (open + submit). The router in ./index.js enforces the
// initiator check before any of these run.

const {
    EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    ActionRowBuilder, PermissionFlagsBits,
} = require('discord.js');
const { addWarning } = require('../warnings');
const { createCase } = require('../modCases');
const { getDb } = require('../db');
const { logError } = require('../logError');
const { sanitizeForDM, validateModalInput } = require('../helpers');
const { sendLog, modActionLogEmbed, membershipField } = require('../logging');

// ──────────────────── Cancel ────────────────────

async function handleCancel(interaction) {
    const desc = interaction.message.embeds[0]?.description || 'Action cancelled.';
    const embed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(0x95A5A6)
        .setDescription('~~' + desc + '~~')
        .setFooter({ text: 'Cancelled by ' + interaction.user.tag });

    await interaction.update({ embeds: [embed], components: [] });
}

// ──────────────────── Confirm Kick ────────────────────

async function handleConfirmKick(interaction, parts) {
    const targetId = parts.slice(2).join('_');
    const guild = interaction.guild;

    if (!guild.members.me.permissions.has(PermissionFlagsBits.KickMembers)) {
        return interaction.update({ content: '❌ I lost the **Kick Members** permission.', components: [], embeds: [] });
    }

    const member = await guild.members.fetch(targetId).catch(() => null);
    if (!member) {
        return interaction.update({ content: '❌ That user is no longer in the server.', components: [], embeds: [] });
    }
    if (!member.kickable) {
        return interaction.update({ content: '❌ I can no longer kick that user (role hierarchy changed).', components: [], embeds: [] });
    }

    const reasonField = interaction.message.embeds[0]?.fields?.find(f => f.name === 'Reason');
    const reason = reasonField ? reasonField.value : 'No reason provided';

    try {
        await member.kick(reason);
        createCase(interaction.guild.id, targetId, interaction.user.id, interaction.user.tag, 'kick', reason);
        // Wick-style log entry in the moderation log channel.
        await sendLog(modActionLogEmbed({
            verb: 'Kick', color: 0xE74C3C,
            target: member.user,
            moderator: interaction.user,
            reason,
            extraFields: [membershipField(member)],
        }), 'moderation', null, guild.id);
        const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0xE74C3C)
            .setTitle('👢 Member Kicked ✅')
            .setDescription('<@' + targetId + '> has been kicked.');
        await interaction.update({ embeds: [embed], components: [] });
    } catch (err) {
        logError(err, 'interactions', 'confirmKick');
        await interaction.update({ content: '❌ Failed to kick: ' + err.message, components: [], embeds: [] });
    }
}

// ──────────────────── Confirm Temp Ban ────────────────────

async function handleConfirmTempBan(interaction, parts) {
    // ctb_{initiatorId}_{targetId}_{duration}_{deleteSeconds}
    const targetId = parts[2];
    const duration = parts[3] || '7d';
    const deleteSeconds = parseInt(parts[4]) || 0;
    const guild = interaction.guild;

    if (!guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.update({ content: '❌ I lost the **Ban Members** permission.', components: [], embeds: [] });
    }

    const durationMs = {
        '1h': 3600000, '6h': 21600000, '24h': 86400000,
        '3d': 259200000, '7d': 604800000, '14d': 1209600000, '30d': 2592000000,
    }[duration] || 604800000;

    const durationLabel = {
        '1h': '1 hour', '6h': '6 hours', '24h': '24 hours',
        '3d': '3 days', '7d': '7 days', '14d': '14 days', '30d': '30 days',
    }[duration] || '7 days';

    const reasonField = interaction.message.embeds[0]?.fields?.find(f => f.name === 'Reason');
    const reason = reasonField ? reasonField.value : 'No reason provided';
    const proofField = interaction.message.embeds[0]?.fields?.find(f => f.name === 'Proof');
    const proof = proofField ? proofField.value : null;

    try {
        await guild.bans.create(targetId, { reason: '[Temp Ban ' + durationLabel + '] ' + reason, deleteMessageSeconds: deleteSeconds });

        // Store the temp ban in the DB with auto-unban timestamp
        const db = getDb();
        const unbanAt = Date.now() + durationMs;
        db.prepare('INSERT INTO temp_bans (user_id, guild_id, reason, banned_at, unban_at) VALUES (?, ?, ?, ?, ?)')
            .run(targetId, guild.id, reason, Date.now(), unbanAt);

        createCase(interaction.guild.id, targetId, interaction.user.id, interaction.user.tag, 'tempban', reason + ' (Duration: ' + durationLabel + ')');

        // Wick-style log entry in the moderation log channel.
        const tbTarget = await interaction.client.users.fetch(targetId).catch(() => null);
        await sendLog(modActionLogEmbed({
            verb: 'Ban', color: 0xE74C3C,
            target: tbTarget || { id: targetId },
            moderator: interaction.user,
            reason,
            duration: durationLabel,
            proof,
        }), 'moderation', null, guild.id);

        const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0xE74C3C)
            .setTitle('🔨 Temp Banned ✅')
            .setDescription('<@' + targetId + '> has been temp banned for **' + durationLabel + '**.')
            .setFooter({ text: 'Auto-unban at <t:' + Math.floor(unbanAt / 1000) + ':R>' });

        await interaction.update({ embeds: [embed], components: [] });
    } catch (err) {
        logError(err, 'interactions', 'confirmTempBan');
        await interaction.update({ content: '❌ Failed to temp ban: ' + err.message, components: [], embeds: [] });
    }
}

// ──────────────────── Confirm Ban ────────────────────

async function handleConfirmBan(interaction, parts) {
    // cb_{initiatorId}_{targetId}[_clear] — the optional trailing "clear" flag
    // selects message deletion and must NOT become part of the target ID.
    const deleteMessageSeconds = parts[parts.length - 1] === 'clear' ? 86400 : 0;
    const targetId = (deleteMessageSeconds ? parts.slice(2, -1) : parts.slice(2)).join('_');
    const guild = interaction.guild;

    if (!guild.members.me.permissions.has(PermissionFlagsBits.BanMembers)) {
        return interaction.update({ content: '❌ I lost the **Ban Members** permission.', components: [], embeds: [] });
    }

    const reasonField = interaction.message.embeds[0]?.fields?.find(f => f.name === 'Reason');
    const reason = reasonField ? reasonField.value : 'No reason provided';
    const proofField = interaction.message.embeds[0]?.fields?.find(f => f.name === 'Proof');
    const proof = proofField ? proofField.value : null;

    try {
        await guild.bans.create(targetId, { reason: reason, deleteMessageSeconds: deleteMessageSeconds });
        createCase(interaction.guild.id, targetId, interaction.user.id, interaction.user.tag, 'ban', reason);
        // Wick-style log entry in the moderation log channel.
        const banTarget = await interaction.client.users.fetch(targetId).catch(() => null);
        await sendLog(modActionLogEmbed({
            verb: 'Ban', color: 0xE74C3C,
            target: banTarget || { id: targetId },
            moderator: interaction.user,
            reason,
            duration: 'Permanent',
            proof,
        }), 'moderation', null, guild.id);
        const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0xE74C3C)
            .setTitle('🔨 Member Banned ✅')
            .setDescription('<@' + targetId + '> has been banned.');
        await interaction.update({ embeds: [embed], components: [] });
    } catch (err) {
        logError(err, 'interactions', 'confirmBan');
        await interaction.update({ content: '❌ Failed to ban: ' + err.message, components: [], embeds: [] });
    }
}

// ──────────────────── Confirm Purge ────────────────────

async function handleConfirmPurge(interaction, parts) {
    const amount = parseInt(parts[2]) || 0;
    const guild = interaction.guild;

    if (!guild.members.me.permissions.has(PermissionFlagsBits.ManageMessages)) {
        return interaction.update({ content: '❌ I lost the **Manage Messages** permission.', components: [], embeds: [] });
    }
    if (!interaction.channel.isTextBased?.()) {
        return interaction.update({ content: '❌ This channel is not a text channel.', components: [], embeds: [] });
    }

    // Defer first so the interaction is acknowledged before potentially slow DB ops
    await interaction.deferUpdate();

    try {
        const fetched = await interaction.channel.bulkDelete(amount, true);
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('🧹 Messages Purged ✅')
            .setDescription('Deleted **' + fetched.size + '** message(s) in ' + interaction.channel)
            .setFooter({ text: 'By ' + interaction.user.tag })
            .setTimestamp();

        // Try to edit the confirmation message — it might have been bulk-deleted
        try {
            await interaction.editReply({ embeds: [embed], components: [] });
        } catch {
            // Original message was deleted by bulkDelete, send a fresh one
            await interaction.channel.send({ embeds: [embed] });
        }
    } catch (err) {
        logError(err, 'interactions', 'confirmPurge');
        const errMsg = '❌ Failed to purge: ' + err.message;
        try {
            await interaction.editReply({ content: errMsg, components: [], embeds: [] });
        } catch {
            await interaction.channel.send({ content: errMsg });
        }
    }
}

// ──────────────────── Warn Modal (open) ────────────────────

async function handleWarnModalOpen(interaction, parts) {
    const targetId = parts.slice(2).join('_');

    const modal = new ModalBuilder()
        .setCustomId('wr_' + interaction.user.id + '_' + targetId)
        .setTitle('Issue Warning');

    const reasonInput = new TextInputBuilder()
        .setCustomId('warn_reason')
        .setLabel('Reason for warning')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Enter the reason for this warning...')
        .setMaxLength(1000)
        .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));

    await interaction.showModal(modal);
}

// ──────────────────── Warn Modal (submit) ────────────────────

async function handleWarnSubmit(interaction, parts) {
    const initiatorId = parts[1];
    const targetId = parts.slice(2).join('_');
    const rawReason = interaction.fields.getTextInputValue('warn_reason');

    // Security check
    if (interaction.user.id !== initiatorId) {
        return interaction.reply({ content: '❌ This isn\'t your warning form.', ephemeral: true });
    }

    // Validate and sanitize the reason
    const validation = validateModalInput(rawReason, { required: true, maxLength: 1000 });
    if (!validation.valid) {
        return interaction.reply({ content: '❌ ' + validation.error, ephemeral: true });
    }
    const reason = validation.value;

    const warnings = addWarning(interaction.guild.id, targetId, interaction.user.tag, reason);
    createCase(interaction.guild.id, targetId, interaction.user.id, interaction.user.tag, 'warn', reason);

    const embed = new EmbedBuilder()
        .setColor(0xF1C40F)
        .setTitle('⚠️ Warning Issued')
        .setDescription('<@' + targetId + '> has been warned.')
        .addFields(
            { name: 'Reason', value: reason },
            { name: 'Warning Count', value: String(warnings.length) },
            { name: 'Moderator', value: String(interaction.user) },
        )
        .setFooter({ text: interaction.guild.name, iconURL: interaction.guild.iconURL() })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });

    // DM the user (sanitized for DM)
    try {
        const user = await interaction.client.users.fetch(targetId);
        await user.send('⚠️ You have been warned in **' + interaction.guild.name + '**.\nReason: ' + sanitizeForDM(reason));
    } catch {
        // DMs closed, silently skip
    }

    // Check warning thresholds for auto-punish
    try {
        const { checkThresholds } = require('../warningThresholds');
        const guild = interaction.guild;
        const result = await checkThresholds(guild, targetId, interaction);
        if (result) {
            await interaction.followUp({
                content: '⚠️ **Auto-punish:** <@' + targetId + '> was ' + result + ' (reached ' + warnings.length + ' warnings).',
                ephemeral: true,
            }).catch((err) => logError(err, 'interactions', 'autoPunish_followUp'));
        }
    } catch (err) {
        logError(err, 'interactions', 'checkThresholds');
    }
}

module.exports = {
    handleCancel,
    handleConfirmKick,
    handleConfirmTempBan,
    handleConfirmBan,
    handleConfirmPurge,
    handleWarnModalOpen,
    handleWarnSubmit,
};

const { EmbedBuilder } = require('discord.js');
const { createReport } = require('../reports');
const { getCases } = require('../modCases');
const { sendLog, modActionLogEmbed, userStatsValue } = require('../logging');
const { logError } = require('../logError');

async function executeReport(interaction) {
    const target = interaction.options.getUser('target');
    const reason = interaction.options.getString('reason');
    const messageId = interaction.options.getString('message_id') || null;

    // Can't report yourself, a bot, or the bot itself.
    if (target.id === interaction.user.id) {
        return interaction.reply({ content: 'You cannot report yourself.', ephemeral: true });
    }
    if (target.bot) {
        return interaction.reply({ content: 'You cannot report a bot.', ephemeral: true });
    }

    // Resolve the reported message content if a message id was provided.
    let messageContent = null;
    if (messageId) {
        try {
            const msg = await interaction.channel.messages.fetch(messageId).catch(() => null);
            messageContent = msg ? (msg.content || '(no text content)').slice(0, 1000) : null;
        } catch { /* ignore */ }
    }

    const report = createReport(
        interaction.guild.id,
        interaction.user.id,
        interaction.user.tag,
        target.id,
        target.tag,
        reason,
        messageContent,
        messageId,
    );

    // Wick-style notice to the moderation log channel, best-effort.
    try {
        const member = await interaction.guild.members.fetch(target.id).catch(() => null);
        const lastCase = getCases(interaction.guild.id, target.id, 1)[0] || null;
        const embed = modActionLogEmbed({
            title: '🚩 Report filed',
            color: 0xF1C40F,
            target,
            moderator: interaction.user,
            fields: [
                { name: 'User', value: userStatsValue({ user: target, member, lastCase }) },
                { name: 'Reason(s)', value: reason.slice(0, 1000) || '—' },
                ...(messageContent ? [{ name: 'Highlighted message(s)', value: messageContent.slice(0, 1000) }] : []),
                { name: 'Reported by', value: interaction.user.tag + ' (<@' + interaction.user.id + '>)' },
                { name: 'Report ID', value: '`' + report.id + '`' },
            ],
        });
        await sendLog(embed, 'moderation', null, interaction.guild.id);
    } catch (err) {
        logError(err, 'report', 'notify');
    }

    const embed = new EmbedBuilder()
        .setColor(0x3BA55C)
        .setTitle('✅ Report Submitted')
        .setDescription('Your report against **' + target.tag + '** has been submitted to the moderation team.')
        .setFooter({ text: 'Report ID: ' + report.id })
        .setTimestamp();
    await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { executeReport };
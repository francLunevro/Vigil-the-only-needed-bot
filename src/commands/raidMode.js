const { EmbedBuilder } = require('discord.js');
const { getRaidConfig, enableRaidMode, disableRaidMode } = require('../raidMode');

async function executeRaidMode(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (!interaction.memberPermissions?.has('ManageMessages')) {
        return interaction.reply({ content: 'You need the Manage Messages permission to manage raid mode.', ephemeral: true });
    }

    if (sub === 'on') {
        const duration = interaction.options.getInteger('duration');
        const notice = interaction.options.getChannel('notice');
        try {
            const cfg = await enableRaidMode(guild, {
                durationMinutes: duration || undefined,
                noticeChannel: notice ? notice.id : undefined,
            });
            const mins = cfg.durationMinutes || 60;
            const embed = new EmbedBuilder()
                .setColor(0xED4245)
                .setTitle('🚨 Raid Mode ON')
                .setDescription('The server is in lockdown. New members will be timed out for **' + mins + ' min** and text channels slowed down.')
                .addFields({ name: 'Duration', value: String(mins) + ' min', inline: true })
                .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (err) {
            await interaction.reply({ content: 'Failed to enable raid mode: ' + err.message, ephemeral: true }).catch(() => {});
        }
    } else if (sub === 'off') {
        try {
            await disableRaidMode(guild);
            const embed = new EmbedBuilder()
                .setColor(0x3BA55C)
                .setTitle('✅ Raid Mode OFF')
                .setDescription('The lockdown has been lifted. New members can talk and slowmode has been reset.')
                .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (err) {
            await interaction.reply({ content: 'Failed to disable raid mode: ' + err.message, ephemeral: true }).catch(() => {});
        }
    } else if (sub === 'status') {
        const cfg = getRaidConfig(guild.id);
        const embed = new EmbedBuilder()
            .setColor(cfg.enabled ? 0xED4245 : 0x3BA55C)
            .setTitle('🚨 Raid Mode Status')
            .setDescription(cfg.enabled ? 'Raid mode is **ACTIVE**. New joins are locked down.' : 'Raid mode is **OFF**.')
            .addFields(
                { name: 'Status', value: cfg.enabled ? '🟥 Active' : '🟩 Off', inline: true },
                { name: 'Duration', value: String(cfg.durationMinutes || 60) + ' min', inline: true },
                { name: 'Started', value: cfg.startedAt ? '<t:' + Math.floor(cfg.startedAt / 1000) + ':R>' : '—', inline: true },
            )
            .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });
    }
}

module.exports = { executeRaidMode };
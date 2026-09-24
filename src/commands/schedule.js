const { EmbedBuilder } = require('discord.js');
const { addScheduledPost, listScheduledPosts, removeScheduledPost, parseSchedule } = require('../scheduledPosts');
const { logError } = require('../logError');

async function executeSchedule(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    // Posting is a management action; don't let anyone schedule announcements.
    if (!interaction.memberPermissions?.has('ManageMessages')) {
        return interaction.reply({ content: "You need the Manage Messages permission to schedule posts.", ephemeral: true });
    }

    if (sub === 'post') {
        const channel = interaction.options.getChannel('channel');
        const content = interaction.options.getString('content');
        const scheduleStr = interaction.options.getString('schedule');
        const title = interaction.options.getString('title');
        const color = interaction.options.getString('color');

        if (!channel.isTextBased?.()) {
            return interaction.reply({ content: "Please select a text channel.", ephemeral: true });
        }

        const parsed = parseSchedule(scheduleStr);
        if (!parsed) {
            return interaction.reply({
                content: "Invalid schedule. Use `daily 18:00`, `weekly monday 18:00`, or `interval 60`.",
                ephemeral: true,
            });
        }

        try {
            const post = addScheduledPost(guild.id, channel.id, {
                title, content, color,
                scheduleType: parsed.scheduleType,
                scheduleValue: parsed.scheduleValue,
            }, interaction.user.id);

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Scheduled Post Created')
                .setDescription('This will post to ' + channel + ' on **' + scheduleStr + '**.')
                .addFields(
                    { name: 'ID', value: '`' + post.id + '`' },
                    { name: 'Next run', value: '<t:' + Math.floor(post.nextRunAt / 1000) + ':R>' },
                )
                .setFooter({ text: 'Use /schedule cancel <id> to remove it' })
                .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: true });
        } catch (err) {
            await interaction.reply({ content: 'Failed to schedule post: ' + err.message, ephemeral: true }).catch((err) => logError(err, 'commands', 'schedule/post'));
        }

    } else if (sub === 'list') {
        const posts = listScheduledPosts(guild.id);
        if (posts.length === 0) {
            return interaction.reply({ content: 'No scheduled posts for this server.', ephemeral: true });
        }
        const lines = posts.map(p => {
            const ch = guild.channels.cache.get(p.channelId);
            const when = '<t:' + Math.floor(p.nextRunAt / 1000) + ':R>';
            return (p.enabled ? '[x] ' : '[ ] ') + '**' + (p.title || p.content.slice(0, 30)) + '** -> ' + (ch ? ch.toString() : p.channelId) + ' | ' + p.scheduleType + ' | next ' + when + ' | `' + p.id + '`';
        }).join('\n');
        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle('Scheduled Posts')
            .setDescription(lines)
            .setFooter({ text: 'Use /schedule cancel <id> to remove one' })
            .setTimestamp();
        await interaction.reply({ embeds: [embed], ephemeral: true });

    } else if (sub === 'cancel') {
        const id = interaction.options.getString('id');
        const removed = removeScheduledPost(id, guild.id);
        if (!removed) {
            return interaction.reply({ content: 'No scheduled post found with that ID.', ephemeral: true });
        }
        await interaction.reply({ content: 'Scheduled post removed.', ephemeral: true });
    }
}

module.exports = { executeSchedule };
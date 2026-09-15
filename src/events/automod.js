const { EmbedBuilder } = require('discord.js');

// ─── Friendly names for Discord's native AutoMod enums ───
// AutomodAction: 1=BLOCK_MESSAGE, 2=SEND_ALERT_MESSAGE, 3=TIMEOUT, 4=BLOCK_MEMBER_INTERACTION
const AUTOMOD_ACTIONS = {
    1: 'Block Message',
    2: 'Send Alert',
    3: 'Timeout',
    4: 'Block Member',
};
// AutomodTriggerType: 1=KEYWORD, 2=HARMLESS_LINK, 3=SPAM, 4=MENTION_SPAM
const AUTOMOD_TRIGGERS = {
    1: 'Keyword',
    2: 'Harmful Link',
    3: 'Spam',
    4: 'Mention Spam',
};

module.exports = [
    {
        name: 'autoModerationActionExecution',
        once: false,
        execute: (deps) => async (execution) => {
            if (!execution.guild) return;
            const guildId = execution.guild.id;

            const actionMeta = execution.action || {};
            const action = AUTOMOD_ACTIONS[actionMeta.type] || 'Automod Action';
            const duration = actionMeta.metadata?.durationSeconds;
            const trigger = AUTOMOD_TRIGGERS[execution.ruleTriggerType] || 'Rule';
            const user = execution.user;
            const channel = execution.channel;

            const embed = new EmbedBuilder()
                .setColor(0xE74C3C)
                .setTitle('🤖 Discord Auto-Mod: ' + action)
                .setDescription(
                    '**Trigger:** ' + trigger + '\n'
                    + (user ? '**User:** ' + user.tag + ' (' + user.id + ')\n' : '')
                    + (channel ? '**Channel:** ' + channel.toString() + '\n' : '')
                    + '**Action:** ' + action
                    + (duration ? ' (' + duration + 's)' : '')
                )
                .setFooter({ text: execution.guild.name, iconURL: execution.guild.iconURL() })
                .setTimestamp();

            if (execution.content) {
                embed.addFields({ name: 'Content', value: execution.content.slice(0, 1024) });
            }
            if (execution.matchedContent) {
                embed.addFields({ name: 'Matched', value: execution.matchedContent.slice(0, 256) });
            }

            deps.sendLog(embed, 'automod', null, guildId);
        },
    },
];

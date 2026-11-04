const { EmbedBuilder } = require('discord.js');
const { parseDuration, formatDuration } = require('../helpers');
const {
    grantTempRole, revokeTempRole, listTempRoles,
    MIN_DURATION_MS, MAX_DURATION_MS,
} = require('../tempRoles');
const { createCase } = require('../modCases');
const { logError } = require('../logError');

function expiryField(expiresAt) {
    return '<t:' + Math.floor(expiresAt / 1000) + ':R>';
}

// /temprole add user: duration: [role:] | remove user: role: | list
async function executeTempRole(interaction) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'add') {
        const target = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const durationInput = interaction.options.getString('duration');
        const reason = interaction.options.getString('reason') || 'No reason provided';

        const durationMs = parseDuration(durationInput);
        if (!durationMs) {
            return interaction.reply({ content: '⚠️ Could not parse `' + durationInput + '`. Use `30m`, `24h`, `7d`, `1h30m`.', ephemeral: true });
        }
        if (durationMs < MIN_DURATION_MS) return interaction.reply({ content: '⚠️ The minimum is 1 minute.', ephemeral: true });
        if (durationMs > MAX_DURATION_MS) return interaction.reply({ content: '⚠️ The maximum is 365 days.', ephemeral: true });

        const result = await grantTempRole({
            guild,
            role,
            userId: target.id,
            durationMs,
            grantedBy: interaction.user.id,
            // Checked against the invoker, not just the bot: a grant must not be
            // a way to hand out roles that outrank the person granting them.
            actorId: interaction.user.id,
        });
        if (result.error) return interaction.reply({ content: '⚠️ ' + result.error, ephemeral: true });

        try {
            createCase(guild.id, target.id, interaction.user.id, interaction.user.tag, 'temprole',
                role.name + ' for ' + formatDuration(durationMs) + ' — ' + reason);
        } catch (err) {
            logError(err, 'commands', 'temprole/case');
        }

        const embed = new EmbedBuilder()
            .setColor(0x5865F2)
            .setTitle(result.extended ? '♻️ Temporary role extended' : '⏳ Temporary role granted')
            .setDescription('<@&' + role.id + '> → ' + target + (result.extended ? ' (timer restarted)' : ''))
            .addFields(
                { name: 'Expires', value: expiryField(result.entry.expiresAt) + ' (' + formatDuration(durationMs) + ')', inline: true },
                { name: 'Reason', value: reason.slice(0, 1024), inline: true },
            )
            .setFooter({ text: 'The bot removes the role automatically — no follow-up needed' })
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'remove') {
        const target = interaction.options.getUser('user');
        const role = interaction.options.getRole('role');
        const result = await revokeTempRole({ guild, userId: target.id, roleId: role.id, reason: 'Revoked by ' + interaction.user.tag, actorId: interaction.user.id });
        if (result.error) return interaction.reply({ content: '⚠️ ' + result.error, ephemeral: true });
        return interaction.reply({ content: '✅ Removed <@&' + role.id + '> from ' + target + ' early.', ephemeral: true });
    }

    // list
    const all = listTempRoles(guild.id);
    const userId = interaction.options.getUser('user');
    const rows = userId ? all.filter((r) => r.userId === userId.id) : all;
    if (!rows.length) {
        return interaction.reply({
            content: userId ? 'No temporary roles pending for that member.' : 'No temporary roles are pending in this server.',
            ephemeral: true,
        });
    }
    const lines = rows.slice(0, 25).map((r) =>
        '<@&' + r.roleId + '> → <@' + r.userId + '> · expires ' + expiryField(r.expiresAt) +
        (r.attempts ? ' · ⚠️ ' + r.attempts + ' failed removal attempt(s)' : '')
    ).join('\n');
    const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('⏳ Temporary Roles')
        .setDescription(lines)
        .setFooter({ text: rows.length + ' pending' + (rows.length > 25 ? ' (showing 25)' : '') });
    return interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { executeTempRole };

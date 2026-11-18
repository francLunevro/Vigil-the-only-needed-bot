// ──────────────────── /logs — stored message-log search ────────────────────
// The Discord surface of the search engine in ../logSearch. The command only
// gathers filters and renders the first page; parsing, SQL and paging live in
// the module so they can be tested without a Discord client.
//
// Access is layered and unchanged: `logs` is not a public command, so the
// pipeline's owner guard (bot owner or a /perm grant) runs first, and
// commandPolicy puts Discord's ManageGuild permission on the slash command.
// Every query is additionally scoped to `interaction.guild.id`, so no search
// can read another server's rows.

const { EmbedBuilder } = require('discord.js');
const { logError } = require('../logError');
const {
    parseSearchQuery, searchMessageLog, createSession, renderSearchPage,
    describeFilters, clampLimit, ACTIONS,
} = require('../logSearch');

async function executeLogs(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub !== 'search') return;

    const guild = interaction.guild;
    if (!guild) {
        return interaction.reply({ content: '❌ `/logs search` only works inside a server.', ephemeral: true });
    }

    const user = interaction.options.getUser('user');
    const channel = interaction.options.getChannel('channel');
    const rawAction = interaction.options.getString('action');
    const rawQuery = interaction.options.getString('query');
    const limit = clampLimit(interaction.options.getInteger('limit'));

    // Prefix commands bypass Discord's choice list, so a stray value has to be
    // dropped here rather than bound into the query.
    const action = ACTIONS.includes(String(rawAction)) ? String(rawAction) : null;

    const parsed = parseSearchQuery(rawQuery);
    if (parsed.error) {
        return interaction.reply({ content: '❌ ' + parsed.error, ephemeral: true });
    }

    const filters = {
        userId: user ? user.id : null,
        channelId: channel ? channel.id : null,
        action,
        query: parsed.text || null,
    };
    const filtersLabel = describeFilters(filters);

    let result;
    try {
        result = searchMessageLog({
            guildId: guild.id,
            terms: parsed.terms,
            userId: filters.userId,
            channelId: filters.channelId,
            action: filters.action,
            limit,
        });
    } catch (err) {
        logError(err, 'commands', 'logs/search');
        return interaction.reply({ content: '❌ The log search failed. The error has been logged.', ephemeral: true });
    }

    if (result.rows.length === 0) {
        const empty = new EmbedBuilder()
            .setColor(0x95A5A6)
            .setTitle('📋 No matching log entries')
            .setDescription('Nothing in the stored message log matches that search.\n\n' + filtersLabel)
            .setFooter({ text: 'Only messages the bot could see are stored — deleted and edited ones, newest 1,000 per server.' });
        return interaction.reply({ embeds: [empty], ephemeral: true });
    }

    // The rows stay in the session so the Previous/Next buttons never re-run
    // the search, and only this user in this guild can page through them.
    const session = createSession({
        userId: interaction.user.id,
        guildId: guild.id,
        rows: result.rows,
        total: result.total,
        truncated: result.truncated,
        limit: result.limit,
        filtersLabel,
        guildName: guild.name,
        guildIcon: typeof guild.iconURL === 'function' ? guild.iconURL() : null,
    });

    await interaction.reply({ ...renderSearchPage(session, 0), ephemeral: true });
}

module.exports = { executeLogs };

// ──────────────────── Log-search pagination buttons ────────────────────
// Custom id: ls_<userId>_<sessionId>_<page | close>. It carries the user id
// first on purpose: the router in ./index.js reads parts[1] as the initiator
// and refuses everyone else before this module is reached. The same check
// repeats below, so a session id that leaked still isn't a way into someone
// else's results.
//
// Paging never re-runs the search — getSession hands back the rows the original
// command stored, so a click is a re-render. A missing session means it expired
// (15 minutes) or was replaced, and that is reported rather than left as a
// dead button.

const { logError } = require('../logError');
const { getSession, destroySession, renderSearchPage } = require('../logSearch');

const EXPIRED = '⌛ That log search has expired. Run `/logs search` again to start a new one.';

async function handleLogSearchButton(interaction, parts) {
    const ownerId = parts[1];
    const sessionId = parts[2];
    const target = parts[3];

    try {
        if (interaction.user.id !== ownerId) {
            return interaction.reply({
                content: '❌ Only the person who ran `/logs search` can page through these results.',
                ephemeral: true,
            });
        }

        const guildId = interaction.guild ? interaction.guild.id : undefined;
        const session = getSession(sessionId, { userId: interaction.user.id, guildId });
        if (!session) {
            return interaction.update({ content: EXPIRED, embeds: [], components: [] });
        }

        if (target === 'close') {
            destroySession(session.id);
            return interaction.update({ content: '🔎 Log search closed. Run `/logs search` again whenever you need it.', embeds: [], components: [] });
        }

        return interaction.update(renderSearchPage(session, target));
    } catch (err) {
        // 10062 / "Unknown interaction" means Discord already dropped the
        // token — there is nothing left to edit, so this ends in the log
        // instead of an unhandled rejection in the interaction handler.
        logError(err, 'interactions', 'logSearch');
        try {
            if (typeof interaction.followUp === 'function') {
                await interaction.followUp({ content: '❌ Could not load that page. Run `/logs search` again.', ephemeral: true });
            }
        } catch (replyErr) {
            logError(replyErr, 'interactions', 'logSearch/reply');
        }
    }
}

module.exports = { handleLogSearchButton, EXPIRED };

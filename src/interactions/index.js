// ──────────────────── Interactive Components Router ────────────────────
// Entry point for buttons, modal submissions, select menus and user selects.
// The handlers live in focused modules beside this one:
//   moderation.js  — moderation confirms (kick / ban / temp-ban / purge / cancel / warn)
//   polls.js       — poll voting + voter lists
//   tickets.js     — ticket create / close / claim / rate / keep / transfer / add-user
//   tempVoice.js   — temp-VC panel buttons + rename / limit modals
//
// Custom ID prefixes (the router reads the first `_`-separated token):
//   ck_…   confirm kick        cb_…   confirm ban      ctb_…  confirm temp ban
//   cp_…   confirm purge       cancel_…  cancel         wm_ / wr_  warn modal
//   pv_ / pm_ / pa_ / pvv   polls   (anyone may click)
//   tk_…   tickets                 (anyone may click; each handler re-checks)
//   tvc_…  temp-VC panel           (anyone may click their own panel)
//   rm_…   role menu               (select menu)
//
// Every other button is initiator-only: the clicker's id must match the id
// encoded in the custom id, so a bystander can't fire someone else's confirm.

const moderation = require('./moderation');
const polls = require('./polls');
const tickets = require('./tickets');
const tempVoice = require('./tempVoice');

async function handleInteraction(interaction) {
    if (interaction.isButton()) {
        return handleButton(interaction);
    }
    if (interaction.isModalSubmit()) {
        return handleModal(interaction);
    }
    if (interaction.isStringSelectMenu()) {
        return handleSelectMenu(interaction);
    }
    if (interaction.isUserSelectMenu()) {
        return handleUserSelect(interaction);
    }
}

// ──────────────────── Button router ────────────────────

async function handleButton(interaction) {
    const parts = interaction.customId.split('_');
    const prefix = parts[0];
    const initiatorId = parts[1];

    // Poll votes — anyone can vote, no security check needed
    if (prefix === 'pv' || prefix === 'pm' || prefix === 'pa') {
        return polls.handlePollVote(interaction, parts);
    }
    // Poll voters button
    if (prefix === 'pvv') {
        return polls.handlePollVoters(interaction);
    }
    // Ticket buttons — tk_{action}_{...} (anyone can interact, no initiator check)
    if (prefix === 'tk') {
        const tkAction = parts[1];
        // tk_create_{panelId}_{typeId} OR tk_create_{panelId}
        if (tkAction === 'create') {
            return tickets.handleTicketCreate(interaction, parts);
        }
        // tk_close_{ticketId} — anyone in the channel can use
        if (tkAction === 'close') {
            return tickets.handleTicketClose(interaction, parts);
        }
        // tk_claim_{ticketId} — anyone can claim
        if (tkAction === 'claim') {
            return tickets.handleTicketClaim(interaction, parts);
        }
        // tk_rate_{ticketId}_{rating} — anyone can rate (no initiator check)
        if (tkAction === 'rate') {
            return tickets.handleTicketRating(interaction, parts);
        }
        // tk_rateskip_{ticketId}
        if (tkAction === 'rateskip') {
            return tickets.handleTicketRateSkip(interaction, parts);
        }
        // tk_keep_{ticketId} — inactivity keep-alive
        if (tkAction === 'keep') {
            return tickets.handleTicketKeep(interaction, parts);
        }
        // tk_transfer_{ticketId}
        if (tkAction === 'transfer') {
            return tickets.handleTicketTransfer(interaction, parts);
        }
        // tk_adduser_{ticketId}
        if (tkAction === 'adduser') {
            return tickets.handleTicketAddUser(interaction, parts);
        }
        return interaction.reply({ content: '❌ Unknown ticket button.', ephemeral: true });
    }

    // Temp VC panel buttons — anyone can use their own panel (per-click validation inside)
    if (prefix === 'tvc') {
        return tempVoice.handleTempVcButton(interaction, parts);
    }

    // All other buttons: only the person who initiated the action can interact
    if (interaction.user.id !== initiatorId) {
        return interaction.reply({
            content: '❌ Only the person who ran this command can interact with these buttons.',
            ephemeral: true,
        });
    }

    switch (prefix) {
        case 'ck': return moderation.handleConfirmKick(interaction, parts);
        case 'cb': return moderation.handleConfirmBan(interaction, parts);
        case 'ctb': return moderation.handleConfirmTempBan(interaction, parts);
        case 'cp': return moderation.handleConfirmPurge(interaction, parts);
        case 'cancel': return moderation.handleCancel(interaction, parts);
        case 'wm': return moderation.handleWarnModalOpen(interaction, parts);
        default:
            await interaction.reply({ content: 'Unknown interaction.', ephemeral: true });
    }
}

// ──────────────────── Modal router ────────────────────

async function handleModal(interaction) {
    const parts = interaction.customId.split('_');
    const prefix = parts[0];

    if (prefix === 'wr') {
        return moderation.handleWarnSubmit(interaction, parts);
    }
    if (prefix === 'tvc') {
        return tempVoice.handleTempVcModal(interaction, parts);
    }
    if (prefix === 'tk') {
        const tkAction = parts[1];
        if (tkAction === 'questions') {
            // Lazy require so tests can patch ./tickets' exports.
            const { handleQuestionsSubmit } = require('../tickets');
            return handleQuestionsSubmit(interaction);
        }
        if (tkAction === 'feedback') {
            return tickets.handleFeedbackModal(interaction, parts);
        }
        if (tkAction === 'transfer') {
            return tickets.handleTransferModal(interaction, parts);
        }
        if (tkAction === 'adduser') {
            return tickets.handleAddUserModal(interaction, parts);
        }
        return interaction.reply({ content: '❌ Unknown ticket form.', ephemeral: true });
    }
}

// ──────────────────── Select menu router ────────────────────

const { handleRoleMenuSelect } = require('../commands/roleMenu');

async function handleSelectMenu(interaction) {
    const parts = interaction.customId.split('_');
    if (parts[0] === 'rm') {
        return handleRoleMenuSelect(interaction);
    }
    // Ticket panel type selection
    if (parts[0] === 'tk' && parts[1] === 'select') {
        return tickets.handleTicketTypeSelect(interaction, parts);
    }
    await interaction.reply({ content: 'Select menu received.', ephemeral: true });
}

// ──────────────────── User select ────────────────────

async function handleUserSelect(interaction) {
    const parts = interaction.customId.split('_');
    if (parts[0] === 'tvc') {
        return require('./tempVoiceModeration').handleModerationSelection(interaction, parts);
    }
    await interaction.reply({ content: 'User selected.', ephemeral: true });
}

module.exports = {
    handleInteraction,
    // Poll helpers used by the dashboard API (POST /api/polls/end) and the
    // restart-safe timed-poll sweeper (started in events/ready.js).
    recordPoll: polls.recordPoll,
    endPoll: polls.endPoll,
    setPollClient: polls.setPollClient,
    startPollCheck: polls.startPollCheck,
    stopPollCheck: polls.stopPollCheck,
    checkPolls: polls.checkPolls,
};

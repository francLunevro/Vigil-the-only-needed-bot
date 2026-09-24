// ──────────────────── Ticket interaction handlers ────────────────────
// Ticket panel buttons (create / close / claim), the rating flow (rate /
// skip / feedback modal), inactivity keep-alive, and transfer / add-user
// (button + modal). Ticket-domain functions themselves live in ../tickets;
// they are required lazily so tests can patch that module's exports.

const {
    EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle,
    ActionRowBuilder, ButtonBuilder,
} = require('discord.js');
const { getDb } = require('../db');
const { logError } = require('../logError');

// ──────────────────── Ticket Create ────────────────────

async function handleTicketCreate(interaction, parts) {
    // tk_create_{panelId}_{typeId} OR tk_create_{panelId}
    const panelId = parts[2];
    const typeId = parts[3];

    const guild = interaction.guild;
    const config = require('../tickets').getTicketConfig(guild.id);

    if (!config.enabled) {
        return interaction.reply({ content: '❌ Tickets are not enabled in this server.', ephemeral: true });
    }

    // Feature 3: Check blacklist
    const { isBlacklisted } = require('../tickets');
    const blacklisted = isBlacklisted(guild.id, interaction.user.id);
    if (blacklisted) {
        return interaction.reply({
            content: '❌ You are blacklisted from creating tickets.\nReason: ' + (blacklisted.reason || 'No reason provided'),
            ephemeral: true,
        });
    }

    // Check for existing open ticket (auto-closes stale tickets whose channel was deleted)
    const existing = require('../tickets').getBlockingOpenTicket(guild, interaction.user.id);

    if (existing) {
        return interaction.reply({ content: '❌ You already have an open ticket! <#' + existing.channel_id + '>', ephemeral: true });
    }

    if (typeId) {
        // Direct type specified — show questions modal
        const type = require('../tickets').getPanelType(typeId);
        if (!type) return interaction.reply({ content: '❌ This ticket type no longer exists.', ephemeral: true });
        const { showQuestionsModal } = require('../tickets');
        return showQuestionsModal(interaction, type);
    }

    // No type — show panel type selector
    const { showTicketTypeModal } = require('../tickets');
    const panel = require('../tickets').getPanel(panelId);
    if (!panel) return interaction.reply({ content: '❌ This panel no longer exists.', ephemeral: true });
    await showTicketTypeModal(interaction, panel);
}

async function handleTicketClose(interaction, _parts) {
    const guild = interaction.guild;
    const channel = interaction.channel;

    await interaction.deferReply({ ephemeral: true });

    try {
        const { closeTicket } = require('../tickets');
        const result = await closeTicket(guild, channel, interaction.user, null);
        if (result.error) {
            return interaction.editReply({ content: '❌ ' + result.error });
        }
        await interaction.editReply({ content: '✅ Closing ticket **#' + result.ticketNumber + '**...' });
    } catch (err) {
        logError(err, 'interactions', 'ticketClose');
        await interaction.editReply({ content: '❌ Failed to close ticket.' });
    }
}

async function handleTicketClaim(interaction, _parts) {
    const guild = interaction.guild;
    const channel = interaction.channel;

    await interaction.deferReply({ ephemeral: true });

    try {
        const { claimTicket } = require('../tickets');
        const result = await claimTicket(guild, channel, interaction.user);
        if (result.error) {
            return interaction.editReply({ content: '❌ ' + result.error });
        }
        await interaction.editReply({ content: '✅ You claimed ticket **#' + result.ticketNumber + '**.' });
    } catch (err) {
        logError(err, 'interactions', 'ticketClaim');
        await interaction.editReply({ content: '❌ Failed to claim ticket.' });
    }
}

// ──────────────────── Ticket Type Select Menu ────────────────────

async function handleTicketTypeSelect(interaction, _parts) {
    // tk_select_{panelId}
    const typeId = interaction.values[0];

    const guild = interaction.guild;
    const config = require('../tickets').getTicketConfig(guild.id);
    if (!config.enabled) {
        return interaction.reply({ content: '❌ Tickets are not enabled in this server.', ephemeral: true });
    }

    // Feature 3: Check blacklist
    const { isBlacklisted } = require('../tickets');
    const blacklisted = isBlacklisted(guild.id, interaction.user.id);
    if (blacklisted) {
        return interaction.reply({
            content: '❌ You are blacklisted from creating tickets.\nReason: ' + (blacklisted.reason || 'No reason provided'),
            ephemeral: true,
        });
    }

    // Check for existing open ticket (auto-closes stale tickets whose channel was deleted)
    const existing = require('../tickets').getBlockingOpenTicket(guild, interaction.user.id);
    if (existing) {
        return interaction.reply({ content: '❌ You already have an open ticket! <#' + existing.channel_id + '>', ephemeral: true });
    }

    const { showQuestionsModal } = require('../tickets');
    const type = require('../tickets').getPanelType(typeId);
    if (!type) {
        return interaction.reply({ content: '❌ This ticket type no longer exists.', ephemeral: true });
    }

    // Show the questions modal (must be the first response — do NOT update() first)
    await showQuestionsModal(interaction, type);
}

// ──────────────────── Rating Handlers (Feature 1) ────────────────────

async function handleTicketRating(interaction, parts) {
    // tk_rate_{ticketId}_{rating}
    const ticketId = parts.slice(2, -1).join('_');
    const rating = parseInt(parts[parts.length - 1]);

    if (rating < 1 || rating > 5) {
        return interaction.reply({ content: '❌ Invalid rating.', ephemeral: true });
    }

    const { saveRating } = require('../tickets');

    // Get guild ID from the ticket record
    const db = getDb();
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) {
        return interaction.reply({ content: '❌ Ticket not found.', ephemeral: true });
    }

    // Show feedback modal (must be the first response — do NOT update() first)
    const modal = new ModalBuilder()
        .setCustomId('tk_feedback_' + ticketId + '_' + rating)
        .setTitle('Rate Your Experience — ' + rating + '/5');

    const feedbackInput = new TextInputBuilder()
        .setCustomId('tk_feedback_text')
        .setLabel('Any additional feedback? (optional)')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Tell us about your experience...')
        .setMaxLength(1000)
        .setRequired(false);

    modal.addComponents(new ActionRowBuilder().addComponents(feedbackInput));

    try {
        await interaction.showModal(modal);
    } catch (err) {
        // If modal fails (e.g. message deleted), save rating without feedback
        saveRating(ticketId, ticket.guild_id, rating, null);
        await interaction.reply({ content: '✅ Thanks for your rating!', ephemeral: true }).catch((err) => logError(err, 'interactions', 'rating_reply'));
    }
}

// ──────────────────── Rating Skip Handler (Feature 1) ────────────────────

async function handleTicketRateSkip(interaction, _parts) {
    // tk_rateskip_{ticketId} — dismiss the rating prompt and disable the buttons
    try {
        const disabledComponents = interaction.message.components.map(row =>
            new ActionRowBuilder().addComponents(
                row.components.map(btn =>
                    ButtonBuilder.from(btn).setDisabled(true)
                )
            )
        );
        await interaction.update({ components: disabledComponents });
    } catch {
        await interaction.deferUpdate().catch((err) => logError(err, 'interactions', 'rateskip_deferUpdate'));
    }
}

// ──────────────────── Feedback Modal Handler (Feature 1) ────────────────────

async function handleFeedbackModal(interaction, parts) {
    // tk_feedback_{ticketId}_{rating}
    const ticketId = parts.slice(2, -1).join('_');
    const rating = parseInt(parts[parts.length - 1]);
    const feedback = interaction.fields.getTextInputValue('tk_feedback_text');

    const db = getDb();
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) {
        return interaction.reply({ content: '❌ Ticket not found.', ephemeral: true });
    }

    const { saveRating } = require('../tickets');
    saveRating(ticketId, ticket.guild_id, rating, feedback || null);

    // Disable the rating buttons on the DM message
    let disabled = false;
    try {
        const disabledComponents = interaction.message.components.map(row =>
            new ActionRowBuilder().addComponents(
                row.components.map(btn =>
                    ButtonBuilder.from(btn).setDisabled(true)
                )
            )
        );
        await interaction.update({ components: disabledComponents });
        disabled = true;
    } catch {}

    if (disabled) {
        await interaction.followUp({ content: '✅ Thanks for your feedback!', ephemeral: true }).catch((err) => logError(err, 'interactions', 'feedback_followUp'));
    } else {
        await interaction.reply({ content: '✅ Thanks for your feedback!', ephemeral: true }).catch((err) => logError(err, 'interactions', 'feedback_reply'));
    }
}

// ──────────────────── Inactivity Keep-Alive (Feature 2) ────────────────────

async function handleTicketKeep(interaction, parts) {
    // tk_keep_{ticketId}
    const ticketId = parts.slice(2).join('_');

    const { updateLastActivity } = require('../tickets');
    updateLastActivity(ticketId);

    // Update the warning embed
    try {
        const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0x5865F2)
            .setTitle('✅ Still Active')
            .setDescription('This ticket has been marked as still active. The inactivity timer has been reset.')
            .setFooter({ text: 'Reset by ' + interaction.user.tag });

        const disabledRow = new ActionRowBuilder().addComponents(
            interaction.message.components[0].components.map(btn =>
                ButtonBuilder.from(btn).setDisabled(true)
            )
        );

        await interaction.update({ embeds: [embed], components: [disabledRow] });
    } catch {}

    await interaction.followUp({ content: '✅ The inactivity timer has been reset.', ephemeral: true }).catch((err) => logError(err, 'interactions', 'keep_followUp'));
}

// ──────────────────── Ticket Transfer (Feature 4) ────────────────────

async function handleTicketTransfer(interaction, parts) {
    // tk_transfer_{ticketId}
    const ticketId = parts.slice(2).join('_');

    // Show user select modal
    const modal = new ModalBuilder()
        .setCustomId('tk_transfer_modal_' + ticketId)
        .setTitle('Transfer Ticket');

    const userInput = new TextInputBuilder()
        .setCustomId('tk_transfer_user')
        .setLabel('User ID to transfer to')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter the Discord ID of the staff member')
        .setRequired(true)
        .setMaxLength(30);

    modal.addComponents(new ActionRowBuilder().addComponents(userInput));

    await interaction.showModal(modal);
}

async function handleTransferModal(interaction, _parts) {
    // tk_transfer_modal_{ticketId}
    const targetId = interaction.fields.getTextInputValue('tk_transfer_user').trim();

    if (!targetId) {
        return interaction.reply({ content: '❌ Please enter a valid user ID.', ephemeral: true });
    }

    const guild = interaction.guild;
    const channel = interaction.channel;

    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (!targetMember) {
        return interaction.reply({ content: '❌ Could not find a member with that ID in this server.', ephemeral: true });
    }

    const { transferTicket } = require('../tickets');
    const result = await transferTicket(guild, channel, interaction.user, targetMember);

    if (result.error) {
        return interaction.reply({ content: '❌ ' + result.error, ephemeral: true });
    }

    await interaction.reply({ content: '✅ Ticket transferred to **' + targetMember.user.tag + '**.', ephemeral: true });
}

// ──────────────────── Ticket Add User ────────────────────

async function handleTicketAddUser(interaction, parts) {
    const ticketId = parts.slice(2).join('_');

    const modal = new ModalBuilder()
        .setCustomId('tk_adduser_modal_' + ticketId)
        .setTitle('Add User to Ticket');

    const userInput = new TextInputBuilder()
        .setCustomId('tk_adduser_id')
        .setLabel('User ID to add')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Enter the Discord ID of the user')
        .setRequired(true)
        .setMaxLength(30);

    modal.addComponents(new ActionRowBuilder().addComponents(userInput));

    await interaction.showModal(modal);
}

async function handleAddUserModal(interaction, _parts) {
    // tk_adduser_modal_{ticketId}
    const targetId = interaction.fields.getTextInputValue('tk_adduser_id').trim();

    if (!targetId) {
        return interaction.reply({ content: '❌ Please enter a valid user ID.', ephemeral: true });
    }

    const guild = interaction.guild;
    const channel = interaction.channel;

    const targetMember = await guild.members.fetch(targetId).catch(() => null);
    if (!targetMember) {
        return interaction.reply({ content: '❌ Could not find a member with that ID in this server.', ephemeral: true });
    }

    const { addUserToTicket } = require('../tickets');
    const result = await addUserToTicket(guild, channel, interaction.user, targetMember);

    if (result.error) {
        return interaction.reply({ content: '❌ ' + result.error, ephemeral: true });
    }

    await interaction.reply({ content: '✅ Added **' + targetMember.user.tag + '** to this ticket.', ephemeral: true });
}

module.exports = {
    handleTicketCreate,
    handleTicketClose,
    handleTicketClaim,
    handleTicketTypeSelect,
    handleTicketRating,
    handleTicketRateSkip,
    handleFeedbackModal,
    handleTicketKeep,
    handleTicketTransfer,
    handleTransferModal,
    handleTicketAddUser,
    handleAddUserModal,
};

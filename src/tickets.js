// ──────────────────── Ticket System v2 ────────────────────
// Supports multiple panels per guild, each with configurable
// ticket types, per-type categories/roles/questions, and
// dropdown-based type selection.

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    PermissionFlagsBits, ChannelType,
} = require('discord.js');
const { getDb } = require('./db');
const { logError } = require('./logError');
const { displayColorToInt } = require('./config');
const { formatDuration } = require('./helpers');

let client = null;

function setTicketClient(c) {
    client = c;
}

// ──────────────────── Colors ────────────────────

// Panel and type colors are '#RRGGBB' display strings; the parser lives in
// config.js (displayColorToInt) so tickets, greetings and the dashboard all
// agree on what a color string means.
const TICKET_COLORS = {
    open: 0x5865F2,
    closed: 0xE74C3C,
    claimed: 0xF1C40F,
};

// ──────────────────── Global Config ────────────────────

function getTicketConfig(guildId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM ticket_config WHERE guild_id = ?').get(guildId);
    if (row) return row;
    db.prepare(`INSERT INTO ticket_config (guild_id, enabled, ticket_count, close_on_leave, log_channel_id)
        VALUES (?, ?, ?, ?, ?)`).run(guildId, 0, 0, 0, null);
    return { guild_id: guildId, enabled: 0, ticket_count: 0, close_on_leave: 0, log_channel_id: null };
}

function updateTicketConfig(guildId, updates) {
    const db = getDb();
    const current = getTicketConfig(guildId);
    const merged = { ...current, ...updates };
    db.prepare(`UPDATE ticket_config SET enabled = ?, ticket_count = ?, close_on_leave = ?, log_channel_id = ? WHERE guild_id = ?`)
        .run(merged.enabled ? 1 : 0, merged.ticket_count || 0, merged.close_on_leave ? 1 : 0, merged.log_channel_id || null, guildId);
    return merged;
}

// ──────────────────── Panel CRUD ────────────────────

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getPanels(guildId) {
    const db = getDb();
    return db.prepare('SELECT * FROM ticket_panels WHERE guild_id = ? ORDER BY created_at ASC').all(guildId);
}

function getPanel(panelId, guildId) {
    const db = getDb();
    return db.prepare('SELECT * FROM ticket_panels WHERE id = ? AND guild_id = ?').get(panelId, guildId);
}

function createPanel(guildId, name) {
    const db = getDb();
    const id = generateId();
    db.prepare(`INSERT INTO ticket_panels (id, guild_id, name, created_at) VALUES (?, ?, ?, ?)`)
        .run(id, guildId, name, Date.now());
    return getPanel(id, guildId);
}

function updatePanel(panelId, updates, guildId) {
    const db = getDb();
    const current = getPanel(panelId, guildId);
    if (!current) return null;
    const merged = { ...current, ...updates };
    db.prepare(`UPDATE ticket_panels SET name = ?, channel_id = ?, panel_message_id = ?, color = ?, image_url = ?, description = ? WHERE id = ? AND guild_id = ?`)
        .run(merged.name, merged.channel_id || null, merged.panel_message_id || null, merged.color || '#5865F2', merged.image_url || null, merged.description || '', panelId, guildId);
    return getPanel(panelId, guildId);
}

function deletePanel(panelId, guildId) {
    const db = getDb();
    return db.transaction(() => {
        const deleted = db.prepare('DELETE FROM ticket_panels WHERE id = ? AND guild_id = ?').run(panelId, guildId);
        if (!deleted.changes) return false;
        db.prepare('DELETE FROM ticket_panel_types WHERE panel_id = ? AND guild_id = ?').run(panelId, guildId);
        return true;
    })();
}

function clonePanel(panelId, guildId) {
    const db = getDb();
    const panel = getPanel(panelId, guildId);
    if (!panel) return null;
    const newId = generateId();
    const newName = (panel.name || 'Panel') + ' (copy)';
    db.prepare(`INSERT INTO ticket_panels (id, guild_id, name, channel_id, panel_message_id, color, image_url, description, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        newId, panel.guild_id, newName, null, null, panel.color || '#5865F2',
        panel.image_url || null, panel.description || '', Date.now()
    );
    // Clone all types
    const types = getPanelTypes(panelId, guildId);
    for (const t of types) {
        const newTypeId = generateId();
        db.prepare(`INSERT INTO ticket_panel_types (id, panel_id, guild_id, name, emoji, category_id, support_roles, welcome_message, ticket_name_format, questions, sort_order, created_at, inactivity_timeout, inactivity_grace)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
            newTypeId, newId, t.guild_id, t.name, t.emoji, t.category_id,
            t.support_roles, t.welcome_message, t.ticket_name_format,
            t.questions, t.sort_order, Date.now(), t.inactivity_timeout, t.inactivity_grace
        );
    }
    return getPanel(newId, guildId);
}

// ──────────────────── Panel Type CRUD ────────────────────

function getPanelTypes(panelId, guildId) {
    const db = getDb();
    return db.prepare('SELECT * FROM ticket_panel_types WHERE panel_id = ? AND guild_id = ? ORDER BY sort_order ASC, created_at ASC').all(panelId, guildId);
}

function getPanelTicketCounter(panelId, guildId) {
    const db = getDb();
    const row = db.prepare('SELECT ticket_counter FROM ticket_panels WHERE id = ? AND guild_id = ?').get(panelId, guildId);
    return row ? row.ticket_counter : null;
}

function setPanelTicketCounter(panelId, count, guildId) {
    const db = getDb();
    return db.prepare('UPDATE ticket_panels SET ticket_counter = ? WHERE id = ? AND guild_id = ?').run(count, panelId, guildId).changes > 0;
}

function getPanelType(typeId, guildId) {
    const db = getDb();
    return db.prepare('SELECT * FROM ticket_panel_types WHERE id = ? AND guild_id = ?').get(typeId, guildId);
}

function createPanelType(panelId, guildId, name, emoji) {
    if (!getPanel(panelId, guildId)) return null;
    const db = getDb();
    const id = generateId();
    db.prepare(`INSERT INTO ticket_panel_types (id, panel_id, guild_id, name, emoji, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, panelId, guildId, name, emoji || '🎫', Date.now());
    return getPanelType(id, guildId);
}

function updatePanelType(typeId, updates, guildId, panelId) {
    const db = getDb();
    if (!getPanel(panelId, guildId)) return null;
    const current = getPanelType(typeId, guildId);
    if (!current || current.panel_id !== panelId) return null;
    const merged = { ...current, ...updates };
    // Only stringify when the incoming value is not already a stored JSON string,
    // otherwise partial updates (e.g. changing only support_roles) double-encode
    // questions/support_roles and corrupt them.
    const stringifyIfNotString = (v) => (typeof v === 'string' ? v : JSON.stringify(v || []));
    db.prepare(`UPDATE ticket_panel_types SET name = ?, emoji = ?, category_id = ?, support_roles = ?, welcome_message = ?, ticket_name_format = ?, questions = ?, sort_order = ? WHERE id = ? AND guild_id = ? AND panel_id = ?`)
        .run(merged.name, merged.emoji || '🎫', merged.category_id || null,
            stringifyIfNotString(merged.support_roles),
            merged.welcome_message || '', merged.ticket_name_format || 'ticket-{username}-{number}',
            stringifyIfNotString(merged.questions), merged.sort_order || 0, typeId, guildId, panelId);
    return getPanelType(typeId, guildId);
}

function deletePanelType(typeId, guildId, panelId) {
    if (!getPanel(panelId, guildId)) return false;
    return getDb().prepare('DELETE FROM ticket_panel_types WHERE id = ? AND guild_id = ? AND panel_id = ?')
        .run(typeId, guildId, panelId).changes > 0;
}

function reorderPanelTypes(panelId, guildId, typeIds) {
    if (!getPanel(panelId, guildId)) return false;
    const db = getDb();
    return db.transaction(() => {
        const allowed = new Set(getPanelTypes(panelId, guildId).map(type => type.id));
        if (!typeIds.every(id => allowed.has(id))) return false;
        const update = db.prepare('UPDATE ticket_panel_types SET sort_order = ? WHERE id = ? AND guild_id = ? AND panel_id = ?');
        typeIds.forEach((id, index) => update.run(index, id, guildId, panelId));
        return true;
    })();
}

// ──────────────────── Parse Helpers ────────────────────

function parseSupportRoles(supportRoles) {
    if (!supportRoles) return [];
    if (Array.isArray(supportRoles)) return supportRoles;
    try { return JSON.parse(supportRoles); } catch { return []; }
}

function parseQuestions(questions) {
    if (!questions) return [];
    if (Array.isArray(questions)) return questions;
    try { return JSON.parse(questions); } catch { return []; }
}

// ──────────────────── Send Panel ────────────────────

async function sendTicketPanel(panelInput, channel) {
    const guild = channel.guild;
    const panelId = typeof panelInput === 'string' ? panelInput : panelInput?.id;
    const panel = getPanel(panelId, guild.id);
    if (!panel) return { error: 'Panel not found.' };
    const types = getPanelTypes(panel.id, panel.guild_id);

    const embed = new EmbedBuilder()
        .setColor(displayColorToInt(panel.color, TICKET_COLORS.open))
        .setAuthor({ name: guild.name, iconURL: guild.iconURL() })
        .setTitle('🎫 ' + (panel.name || 'Support Tickets'))
        .setDescription(panel.description || 'Click the button below to create a ticket.')
        .setTimestamp();

    if (panel.image_url) embed.setImage(panel.image_url);

    // If there are multiple types, show a select menu
    const components = [];

    if (types.length > 1) {
        const select = new StringSelectMenuBuilder()
            .setCustomId('tk_select_' + panel.id)
            .setPlaceholder('Choose a ticket type...');

        for (const t of types) {
            select.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(t.name)
                    .setValue(t.id)
                    .setEmoji(t.emoji || '🎫')
                    .setDescription('Create a ' + t.name + ' ticket')
            );
        }

        components.push(new ActionRowBuilder().addComponents(select));
    }

    // Create button that creates a ticket (uses default or first type).
    // When a panel has multiple types the select menu IS the create action —
    // picking a type from the dropdown creates the ticket directly — so the
    // button is only shown for single-type (or empty) panels.
    if (types.length <= 1) {
        const buttonId = types.length === 1 ? 'tk_create_' + panel.id + '_' + types[0].id : 'tk_create_' + panel.id;
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(buttonId)
                .setLabel('Create Ticket')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🎫')
        );
        components.push(row);
    }

    const msg = await channel.send({ embeds: [embed], components });

    // Store panel_message_id so we can update it later
    updatePanel(panel.id, { channel_id: channel.id, panel_message_id: msg.id }, guild.id);

    return { success: true, messageId: msg.id };
}

// ──────────────────── Create Ticket ────────────────────

async function createTicket(guild, creator, panelType, answers) {
    const db = getDb();
    const config = getTicketConfig(guild.id);

    // Resolve panel type
    const type = typeof panelType === 'string' ? getPanelType(panelType, guild.id) : panelType;
    if (!type || type.guild_id !== guild.id) return { error: 'Ticket type not found.' };

    // Numbering: when the panel has its own counter set (dashboard "Set Count"),
    // use that; otherwise fall back to the global counter. Keep the global
    // counter ahead of any manually-set number so ticket numbers don't collide
    // across panels.
    let ticketNumber;
    const panelCounter = type.panel_id ? getPanelTicketCounter(type.panel_id, guild.id) : null;
    if (panelCounter && Number.isInteger(panelCounter) && panelCounter > 0) {
        ticketNumber = panelCounter;
        setPanelTicketCounter(type.panel_id, panelCounter + 1, guild.id);
        if (ticketNumber > (config.ticket_count || 0)) {
            updateTicketConfig(guild.id, { ticket_count: ticketNumber });
        }
    } else {
        ticketNumber = (config.ticket_count || 0) + 1;
        updateTicketConfig(guild.id, { ticket_count: ticketNumber });
    }

    // Build channel name (Feature 5 - extended tokens)
    const safeName = creator.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const nameFormat = type.ticket_name_format || 'ticket-{username}-{number}';
    const channelName = nameFormat
        .replace('{username}', safeName)
        .replace('{number}', String(ticketNumber).padStart(4, '0'))
        .replace('{name}', safeName)
        .replace('{type}', (type.name || 'ticket').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20))
        .replace('{category}', (type.name || 'ticket').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 10))
        .replace(/[^a-z0-9-]/g, '')
        .slice(0, 96) || ('ticket-' + safeName + '-' + ticketNumber);

    const ticketId = guild.id + '_' + ticketNumber;

    // Permissions
    const everyoneRole = guild.roles.everyone;
    const supportRoleIds = parseSupportRoles(type.support_roles);

    const permissionOverwrites = [
        { id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
            id: creator.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.AddReactions],
        },
        {
            id: client.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.ManageMessages, PermissionFlagsBits.AttachFiles],
        },
    ];

    for (const roleId of supportRoleIds) {
        const role = guild.roles.cache.get(roleId);
        if (role) {
            permissionOverwrites.push({
                id: role.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.AddReactions],
            });
        }
    }

    // Category
    const category = type.category_id ? guild.channels.cache.get(type.category_id) : null;

    const channel = await guild.channels.create({
        name: channelName,
        type: ChannelType.GuildText,
        parent: category ? category.id : null,
        permissionOverwrites,
        topic: 'Ticket #' + ticketNumber + ' | ' + type.name + ' | ' + creator.tag,
    });

    // Store in DB
    const answersJson = answers ? JSON.stringify(answers) : null;
    db.prepare(`INSERT INTO tickets (id, guild_id, ticket_number, channel_id, creator_id, creator_tag, panel_type_id, panel_type_name, status, reason, answers, created_at, last_activity_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ticketId, guild.id, ticketNumber, channel.id, creator.id, creator.tag,
        type.id, type.name, 'open', null, answersJson, Date.now(), Date.now()
    );

    // Send welcome embed
    const supportRoleMentions = supportRoleIds.map(id => '<@&' + id + '>').join(' ');

    const welcomeEmbed = new EmbedBuilder()
        .setColor(displayColorToInt(type.color, TICKET_COLORS.open))
        .setAuthor({ name: 'Ticket #' + ticketNumber, iconURL: guild.iconURL() })
        .setTitle('🎫 ' + type.name + ' Ticket')
        .setDescription(type.welcome_message || 'Thank you for creating a ticket. A staff member will be with you shortly.')
        .addFields(
            { name: 'Created By', value: String(creator), inline: true },
            { name: 'Type', value: type.emoji + ' ' + type.name, inline: true },
        )
        .setFooter({ text: guild.name, iconURL: guild.iconURL() })
        .setTimestamp();

    // Ticket SLA (src/ticketSla.js — required lazily because that module reads
    // this one): stating the promise where the ticket is opened is the only
    // place the member, the staff and the tracker all see the same number.
    const sla = getSlaConfig(guild.id);
    if (sla.enabled && sla.firstResponseMinutes) {
        welcomeEmbed.addFields({ name: 'First response target', value: sla.firstResponseMinutes + ' min', inline: true });
    }

    // Pin the answers embed to keep it visible (Feature 6 - Ticket Tool style)
    if (answers && Array.isArray(answers) && answers.length > 0) {
        const answersEmbed = new EmbedBuilder()
            .setColor(displayColorToInt(type.color, TICKET_COLORS.open))
            .setTitle('📋 Ticket Form Answers')
            .setDescription('Questions and answers submitted when creating this ticket:')
            .setFooter({ text: 'Ticket #' + ticketNumber })
            .setTimestamp();
        for (const a of answers) {
            answersEmbed.addFields({ name: a.question || 'Question', value: a.answer || '*No answer*', inline: false });
        }
        const pinnedMsg = await channel.send({ embeds: [answersEmbed] });
        try { await pinnedMsg.pin(); } catch {}
    }

    const closeBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk_close_' + ticketId).setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );
    const claimBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk_claim_' + ticketId).setLabel('Claim Ticket').setStyle(ButtonStyle.Primary).setEmoji('✋')
    );

    await channel.send({
        content: supportRoleMentions || null,
        embeds: [welcomeEmbed],
        components: [claimBtn, closeBtn],
    });

    await logTicketAction(guild, type.emoji + ' ' + type.name + ' Ticket Created', TICKET_COLORS.open, {
        'Ticket #': '#' + ticketNumber, 'Creator': String(creator),
        'Channel': '<#' + channel.id + '>', 'Type': type.name,
    }, config.log_channel_id);

    recordTicketMessage(ticketId, '0', 'System', null, type.name + ' ticket created by ' + creator.tag, 1);

    return { channel, ticketId, ticketNumber };
}

// ──────────────────── Panel Select / Modal Flow ────────────────────

async function showTicketTypeModal(interaction, panel) {
    // Show a select menu for ticket types
    const types = getPanelTypes(panel.id, panel.guild_id);
    if (types.length === 0) {
        return interaction.reply({
            content: '❌ This panel has no ticket types configured. Please contact the server staff.',
            ephemeral: true,
        });
    }

    if (types.length === 1) {
        // Skip dropdown, go straight to questions
        return showQuestionsModal(interaction, types[0]);
    }

    // Show dropdown
    const select = new StringSelectMenuBuilder()
        .setCustomId('tk_select_' + panel.id)
        .setPlaceholder('Choose a ticket type...');

    for (const t of types) {
        select.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(t.name)
                .setValue(t.id)
                .setEmoji(t.emoji || '🎫')
                .setDescription('Create a ' + t.name + ' ticket')
        );
    }

    const row = new ActionRowBuilder().addComponents(select);

    await interaction.reply({
        content: '📋 **Please select the type of ticket you want to create:**',
        components: [row],
        ephemeral: true,
    });
}

async function showQuestionsModal(interaction, type) {
    const questions = parseQuestions(type.questions);

    if (questions.length === 0) {
        // No questions - create ticket directly
        await interaction.deferReply({ ephemeral: true });
        try {
            const result = await createTicket(interaction.guild, interaction.user, type, []);
            if (result.error) return interaction.editReply({ content: '❌ ' + result.error });
            return interaction.editReply({
                content: '✅ Your **' + type.name + '** ticket has been created! <#' + result.channel.id + '>',
            });
        } catch (err) {
            logError(err, 'tickets', 'createTicket');
            return interaction.editReply({ content: '❌ Failed to create ticket: ' + err.message });
        }
    }

    // Show modal with questions
    const modal = new ModalBuilder()
        .setCustomId('tk_questions_' + type.id + '_' + interaction.user.id)
        .setTitle(type.emoji + ' ' + type.name);

    for (let i = 0; i < Math.min(questions.length, 5); i++) {
        const q = questions[i];
        const input = new TextInputBuilder()
            .setCustomId('tq_' + i)
            .setLabel(q.label || q.question || 'Question ' + (i + 1))
            .setStyle(TextInputStyle.Short)
            .setRequired(q.required !== false)
            .setMaxLength(q.maxLength || 500);

        if (q.placeholder) input.setPlaceholder(q.placeholder);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
    }

    await interaction.showModal(modal);
}

async function handleQuestionsSubmit(interaction) {
    const parts = interaction.customId.split('_');
    // tk_questions_{typeId}_{userId}
    const typeId = parts[2];
    const userId = parts[3];

    if (interaction.user.id !== userId) {
        return interaction.reply({ content: '❌ This form is not for you.', ephemeral: true });
    }

    const type = getPanelType(typeId, interaction.guild.id);
    if (!type) {
        return interaction.reply({ content: '❌ This ticket type no longer exists.', ephemeral: true });
    }

    const questions = parseQuestions(type.questions);
    const answers = [];

    // The modal only renders up to 5 inputs — never read beyond that or it throws
    const maxQuestions = Math.min(questions.length, 5);
    for (let i = 0; i < maxQuestions; i++) {
        const val = interaction.fields.getTextInputValue('tq_' + i);
        answers.push({ question: questions[i].label || questions[i].question, answer: val || '' });
    }

    await interaction.deferReply({ ephemeral: true });

    try {
        const result = await createTicket(interaction.guild, interaction.user, type, answers);
        if (result.error) return interaction.editReply({ content: '❌ ' + result.error });

        const embed = new EmbedBuilder()
            .setColor(TICKET_COLORS.open)
            .setTitle('🎫 Ticket Created')
            .setDescription('Your **' + type.name + '** ticket has been created! Channel: <#' + result.channel.id + '>')
            .setFooter({ text: 'Ticket #' + result.ticketNumber })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        logError(err, 'tickets', 'handleQuestionsSubmit');
        await interaction.editReply({ content: '❌ Failed to create ticket: ' + err.message });
    }
}

// ──────────────────── Close / Claim / Add/Remove (unchanged logic) ────────────────────

// Ticket visibility is not ticket-management authority. A user must have a
// configured support role, Manage Channels/Administrator, or own the server.
async function isTicketStaff(guild, ticket, actor) {
    if (!guild || !ticket || !actor?.id) return false;

    let member = actor.roles?.cache ? actor : guild.members?.cache?.get(actor.id);
    if (!member && guild.members?.fetch) {
        member = await guild.members.fetch(actor.id).catch(() => null);
    }
    if (!member) return false;

    if (member.id === guild.ownerId) return true;
    if (member.permissions?.has(PermissionFlagsBits.Administrator) || member.permissions?.has(PermissionFlagsBits.ManageChannels)) return true;

    const type = ticket.panel_type_id ? getPanelType(ticket.panel_type_id, guild.id) : null;
    const supportRoleIds = parseSupportRoles(type?.support_roles);
    return supportRoleIds.some(roleId => member.roles?.cache?.has(roleId));
}

async function closeTicket(guild, channel, closer, reason) {
    const db = getDb();
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ? AND status IN (?, ?)')
        .get(channel.id, guild.id, 'open', 'claimed');
    if (!ticket) return { error: 'No open ticket found for this channel.' };
    if (closer.id !== ticket.creator_id && !(await isTicketStaff(guild, ticket, closer))) {
        return { error: 'Only the ticket creator or support staff can close this ticket.' };
    }
    return closeTicketById(guild, channel, closer, reason, ticket);
}

async function closeTicketById(guild, channel, closer, reason, ticket) {
    const db = getDb();
    const closeReason = reason || 'No reason provided';

    // Conditional close: two presses (or a button plus the inactivity sweeper)
    // both read 'open' a moment earlier. Only the row that actually transitions
    // may send the embed, log, DM and transcript, or a ticket gets closed twice.
    const closed = db.prepare(`UPDATE tickets SET status = ?, closed_by_id = ?, closed_by_tag = ?, closed_at = ?, closed_reason = ?
        WHERE id = ? AND status IN (?, ?)`)
        .run('closed', closer.id, closer.tag, Date.now(), closeReason, ticket.id, 'open', 'claimed');
    if (closed.changes === 0) {
        return { error: 'This ticket is already closed.' };
    }

    try {
        const closeEmbed = new EmbedBuilder()
            .setColor(TICKET_COLORS.closed)
            .setTitle('🔒 Ticket Closed')
            .setDescription('This ticket has been closed by **' + closer.tag + '**' + (reason ? '\nReason: ' + reason : ''))
            .setFooter({ text: guild.name, iconURL: guild.iconURL() })
            .setTimestamp();
        await channel.send({ embeds: [closeEmbed] });
    } catch (err) { logError(err, 'tickets', 'closeEmbed'); }

    // The close log is where a ticket's end state is read, so the two numbers
    // that describe how it went — how long the member waited for the first
    // human reply, and how long the ticket was open — belong here.
    const slaConfig = getSlaConfig(guild.id);
    const closedAt = Date.now();
    const firstResponseAt = ticket.first_response_at ? Number(ticket.first_response_at) : null;
    await logTicketAction(guild, '🔒 Ticket Closed', TICKET_COLORS.closed, {
        'Ticket #': '#' + ticket.ticket_number, 'Closed By': String(closer), 'Reason': closeReason,
        'First Response': slaConfig.enabled
            ? (firstResponseAt ? formatWait(firstResponseAt - Number(ticket.created_at)) : 'None')
            : '—',
        'Open For': slaConfig.enabled ? formatWait(closedAt - Number(ticket.created_at)) : '—',
    }, null);

    recordTicketMessage(ticket.id, '0', 'System', null, 'Ticket closed by ' + closer.tag + (reason ? ' — Reason: ' + reason : ''), 1);

    setTimeout(async () => {
        try {
            await saveTranscript(guild, ticket, channel);
            await channel.delete('Ticket closed by ' + closer.tag);
        } catch (err) { logError(err, 'tickets', 'deleteChannel'); }
    }, 5000);

    try {
        const creator = await client.users.fetch(ticket.creator_id).catch(() => null);
        if (creator) {
            const dmEmbed = new EmbedBuilder()
                .setColor(TICKET_COLORS.closed)
                .setTitle('🎫 Ticket Closed — ' + guild.name)
                .setDescription('Your ticket **#' + ticket.ticket_number + '** has been closed.')
                .addFields({ name: 'Closed By', value: closer.tag, inline: true }, { name: 'Reason', value: closeReason, inline: true })
                .setFooter({ text: 'Ticket #' + ticket.ticket_number }).setTimestamp();
            
            // Feature 1: Send rating buttons with the DM
            const ratingRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('tk_rate_' + ticket.id + '_1').setLabel('⭐').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('tk_rate_' + ticket.id + '_2').setLabel('⭐⭐').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('tk_rate_' + ticket.id + '_3').setLabel('⭐⭐⭐').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('tk_rate_' + ticket.id + '_4').setLabel('⭐⭐⭐⭐').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('tk_rate_' + ticket.id + '_5').setLabel('⭐⭐⭐⭐⭐').setStyle(ButtonStyle.Secondary)
            );
            const skipRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('tk_rateskip_' + ticket.id).setLabel('Skip').setStyle(ButtonStyle.Secondary)
            );
            await creator.send({ embeds: [dmEmbed], components: [ratingRow, skipRow] }).catch((err) => logError(err, 'tickets', 'rating_dm'));
        }
    } catch {}

    return { success: true, ticketNumber: ticket.ticket_number };
}

async function claimTicket(guild, channel, claimer) {
    const db = getDb();
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ? AND status = ?').get(channel.id, guild.id, 'open');
    if (!ticket) return { error: 'No open ticket found for this channel.' };
    if (!(await isTicketStaff(guild, ticket, claimer))) {
        return { error: 'Only support staff can claim tickets.' };
    }

    // Two staff can click Claim in the same second; both passed the read above.
    // The winner is decided by the row itself, so only one claim is announced.
    const claim = db.prepare('UPDATE tickets SET status = ?, claimer_id = ? WHERE id = ? AND status = ?')
        .run('claimed', claimer.id, ticket.id, 'open');
    if (claim.changes === 0) {
        const current = db.prepare('SELECT status, claimer_id FROM tickets WHERE id = ?').get(ticket.id);
        if (!current || current.status === 'closed') return { error: 'This ticket is already closed.' };
        return { error: 'This ticket was already claimed'
            + (current && current.claimer_id ? ' by <@' + current.claimer_id + '>' : '') + '.' };
    }

    const claimEmbed = new EmbedBuilder()
        .setColor(TICKET_COLORS.claimed).setTitle('✋ Ticket Claimed')
        .setDescription('**' + claimer.tag + '** is now handling this ticket.')
        .setFooter({ text: guild.name, iconURL: guild.iconURL() }).setTimestamp();
    await channel.send({ embeds: [claimEmbed] });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk_close_' + ticket.id).setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );
    await channel.send({ components: [row] });

    // Feature 4: Add Transfer + Add User buttons alongside Close
    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('tk_adduser_' + ticket.id).setLabel('Add User').setStyle(ButtonStyle.Success).setEmoji('📌'),
        new ButtonBuilder().setCustomId('tk_transfer_' + ticket.id).setLabel('Transfer').setStyle(ButtonStyle.Primary).setEmoji('🔄'),
        new ButtonBuilder().setCustomId('tk_close_' + ticket.id).setLabel('Close Ticket').setStyle(ButtonStyle.Danger).setEmoji('🔒')
    );
    await channel.send({ components: [actionRow] }).catch((err) => logError(err, 'tickets', 'claim_buttons'));

    // Broadcast SSE for dashboard
    try {
        if (global.broadcastDashboard) {
            global.broadcastDashboard('ticket_claimed', { guildId: guild.id, ticketId: ticket.id, claimerId: claimer.id, claimerTag: claimer.tag });
        }
    } catch {}

    // Claiming is staff picking the ticket up, not yet a reply — so it is not a
    // first response. Showing how long the member has already waited is the
    // feedback loop that makes the SLA visible while it is still fixable.
    const slaConfig = getSlaConfig(guild.id);
    const claimedAt = ticket.first_response_at ? Number(ticket.first_response_at) : Date.now();
    await logTicketAction(guild, '✋ Ticket Claimed', TICKET_COLORS.claimed, {
        'Ticket #': '#' + ticket.ticket_number, 'Claimed By': String(claimer),
        'Waited': slaConfig.enabled ? formatWait(claimedAt - Number(ticket.created_at)) : '—',
        'First Response': ticket.first_response_at && slaConfig.enabled
            ? formatWait(Number(ticket.first_response_at) - Number(ticket.created_at))
            : 'Not yet',
    }, null);
    recordTicketMessage(ticket.id, '0', 'System', null, 'Ticket claimed by ' + claimer.tag, 1);

    return { success: true, ticketNumber: ticket.ticket_number };
}

async function addUserToTicket(guild, channel, adder, targetUser) {
    const db = getDb();
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ?').get(channel.id, guild.id);
    if (!ticket) return { error: 'No ticket found for this channel.' };
    if (!(await isTicketStaff(guild, ticket, adder))) {
        return { error: 'Only support staff can add users to a ticket.' };
    }
    try {
        await channel.permissionOverwrites.create(targetUser, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, AddReactions: true,
        });
        const embed = new EmbedBuilder().setColor(TICKET_COLORS.open)
            .setDescription('➕ ' + String(targetUser) + ' has been added to this ticket by **' + adder.tag + '**').setTimestamp();
        await channel.send({ embeds: [embed] });
        recordTicketMessage(ticket.id, '0', 'System', null, targetUser.tag + ' added to ticket by ' + adder.tag, 1);
        return { success: true };
    } catch (err) { logError(err, 'tickets', 'addUser'); return { error: 'Failed to add user: ' + err.message }; }
}

async function removeUserFromTicket(guild, channel, remover, targetUser) {
    const db = getDb();
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ?').get(channel.id, guild.id);
    if (!ticket) return { error: 'No ticket found for this channel.' };
    try {
        await channel.permissionOverwrites.delete(targetUser).catch((err) => logError(err, 'tickets', 'removeUser_overwrite_delete'));
        const embed = new EmbedBuilder().setColor(TICKET_COLORS.closed)
            .setDescription('➖ ' + String(targetUser) + ' has been removed from this ticket by **' + remover.tag + '**').setTimestamp();
        await channel.send({ embeds: [embed] });
        recordTicketMessage(ticket.id, '0', 'System', null, targetUser.tag + ' removed from ticket by ' + remover.tag, 1);
        return { success: true };
    } catch (err) { logError(err, 'tickets', 'removeUser'); return { error: 'Failed to remove user: ' + err.message }; }
}

async function renameTicket(guild, channel, renamer, newName) {
    try { await channel.setName(newName); return { success: true }; }
    catch (err) { logError(err, 'tickets', 'rename'); return { error: 'Failed to rename channel: ' + err.message }; }
}

// ──────────────────── Transcript ────────────────────

function recordTicketMessage(ticketId, authorId, authorTag, authorAvatar, content, isSystem) {
    try {
        const db = getDb();
        db.prepare(`INSERT INTO ticket_messages (ticket_id, author_id, author_tag, author_avatar, content, is_system, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`).run(ticketId, authorId, authorTag, authorAvatar || null, content || '', isSystem ? 1 : 0, Date.now());
    } catch (err) { logError(err, 'tickets', 'recordMessage'); }
}

// How much history a transcript snapshots. Discord returns at most 100
// messages per call, so the old single call silently kept only the tail of a
// busy ticket — the README promises the whole conversation. Page backwards
// with `before` until the channel is exhausted, with a hard ceiling so a
// pathological channel cannot exhaust memory.
const TRANSCRIPT_PAGE_SIZE = 100;
const TRANSCRIPT_MAX_MESSAGES = 10000;
// The stored text is what the dashboard and the log attachment carry, so it is
// capped too — but never silently: hitting this appends a visible notice.
const TRANSCRIPT_MAX_CHARS = 5000000;

async function fetchTranscriptMessages(channel) {
    const messages = [];
    let before = null;
    let capped = false;
    for (;;) {
        const batch = await channel.messages
            .fetch(before ? { limit: TRANSCRIPT_PAGE_SIZE, before } : { limit: TRANSCRIPT_PAGE_SIZE })
            .catch(() => null);
        if (!batch) {
            // The very first page failing means no transcript at all; a later
            // failure keeps the pages already in hand.
            if (messages.length === 0) return null;
            break;
        }
        const page = typeof batch.values === 'function' ? [...batch.values()] : [];
        if (page.length === 0) break;
        messages.push(...page);
        if (page.length < TRANSCRIPT_PAGE_SIZE) break; // reached the start of the channel
        before = page[page.length - 1].id; // collections are newest-first
        if (!before) break;
        if (messages.length >= TRANSCRIPT_MAX_MESSAGES) {
            messages.length = TRANSCRIPT_MAX_MESSAGES;
            // Only claim truncation when the channel provably holds more.
            const probe = await channel.messages.fetch({ limit: 1, before }).catch(() => null);
            capped = !!(probe && probe.size > 0);
            break;
        }
    }
    return { messages, capped };
}

async function saveTranscript(guild, ticket, channel) {
    try {
        const db = getDb();
        const fetchedResult = await fetchTranscriptMessages(channel);
        if (!fetchedResult) return;
        const { messages: fetched, capped } = fetchedResult;

        const insert = db.prepare(`INSERT OR IGNORE INTO ticket_messages (ticket_id, author_id, author_tag, author_avatar, content, is_system, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
        const tx = db.transaction(() => {
            for (const msg of fetched) {
                if (msg.author.bot && !msg.system) continue;
                const avatar = msg.author.displayAvatarURL({ size: 32 }) || null;
                insert.run(ticket.id, msg.author.id, msg.author.tag, avatar, msg.content || '', msg.system ? 1 : 0, msg.createdTimestamp || Date.now());
            }
        });
        tx();

        const typeLabel = ticket.panel_type_name ? ' (' + ticket.panel_type_name + ')' : '';
        const transcriptLines = [
            '═══════════════════════════════════════════',
            '  TICKET TRANSCRIPT — #' + ticket.ticket_number + typeLabel,
            '  Guild: ' + guild.name + ' (' + guild.id + ')',
            '  Created by: ' + ticket.creator_tag + ' (' + ticket.creator_id + ')',
            '  Created at: ' + new Date(ticket.created_at).toLocaleString(),
            ticket.closed_at ? '  Closed at: ' + new Date(ticket.closed_at).toLocaleString() : '',
            '═══════════════════════════════════════════', '',
        ];

        // Add answers if present
        if (ticket.answers) {
            try {
                const answers = JSON.parse(ticket.answers);
                transcriptLines.push('── Form Answers ──');
                for (const a of answers) {
                    transcriptLines.push('  ' + (a.question || '?') + ': ' + (a.answer || '-'));
                }
                transcriptLines.push('───────────────────', '');
            } catch {}
        }

        if (capped) {
            transcriptLines.push('[Channel history truncated at ' + TRANSCRIPT_MAX_MESSAGES
                + ' messages — the channel holds more than this transcript.]', '');
        }

        const allMsgs = db.prepare('SELECT * FROM ticket_messages WHERE ticket_id = ? ORDER BY created_at ASC').all(ticket.id);
        for (const m of allMsgs) {
            const time = new Date(m.created_at).toLocaleString();
            transcriptLines.push(m.is_system ? '[System — ' + time + '] ' + m.content : '[' + time + '] ' + m.author_tag + ': ' + m.content);
        }
        transcriptLines.push('', '═══════════════════════════════════════════');
        transcriptLines.push('  End of transcript — ' + allMsgs.length + ' messages');

        let transcript = transcriptLines.join('\n');
        if (transcript.length > TRANSCRIPT_MAX_CHARS) {
            // Never cut the record without saying so.
            transcript = transcript.slice(0, TRANSCRIPT_MAX_CHARS)
                + '\n\n[Transcript truncated at ' + TRANSCRIPT_MAX_CHARS + ' characters — '
                + allMsgs.length + ' messages are stored, open the ticket export for all of them.]';
        }
        db.prepare('UPDATE tickets SET transcript = ? WHERE id = ?').run(transcript, ticket.id);

        const config = getTicketConfig(guild.id);
        if (config.log_channel_id) {
            try {
                const logChannel = guild.channels.cache.get(config.log_channel_id);
                if (logChannel) {
                    const transcriptEmbed = new EmbedBuilder()
                        .setColor(TICKET_COLORS.closed)
                        .setTitle('📄 Ticket #' + ticket.ticket_number + typeLabel + ' — Transcript')
                        .setDescription('Ticket closed with **' + allMsgs.length + '** messages.')
                        .addFields(
                            { name: 'Created By', value: ticket.creator_tag || 'Unknown', inline: true },
                            { name: 'Closed By', value: ticket.closed_by_tag || 'Unknown', inline: true },
                            { name: 'Reason', value: ticket.closed_reason || '*Not provided*', inline: true },
                        )
                        .setFooter({ text: guild.name, iconURL: guild.iconURL() }).setTimestamp();
                    await logChannel.send({
                        embeds: [transcriptEmbed],
                        files: [{ attachment: Buffer.from(transcript), name: 'ticket-' + ticket.ticket_number + '-' + guild.id + '.txt' }],
                    }).catch((err) => logError(err, 'tickets', 'transcript_send'));
                }
            } catch {}
        }
    } catch (err) { logError(err, 'tickets', 'saveTranscript'); }
}

// ──────────────────── Logging Helper ────────────────────

// Answers whether the log actually reached a channel. The ticket SLA sweeper
// (src/ticketSla.js) needs that answer: an alert it could not post must not be
// marked as sent, or the ticket would never be alerted about again.
async function logTicketAction(guild, title, color, fields, logChannelId) {
    if (!logChannelId) {
        const config = getTicketConfig(guild.id);
        logChannelId = config.log_channel_id;
    }
    if (!logChannelId) return false;
    try {
        const channel = guild.channels.cache.get(logChannelId);
        if (!channel) return false;
        const embed = new EmbedBuilder().setColor(color).setTitle(title)
            .setFooter({ text: guild.name, iconURL: guild.iconURL() }).setTimestamp();
        for (const [name, value] of Object.entries(fields)) embed.addFields({ name, value: String(value), inline: true });
        await channel.send({ embeds: [embed] });
        return true;
    } catch (err) { logError(err, 'tickets', 'logTicketAction'); return false; }
}

// "12 min" / "2h 5m" for the SLA readouts, straight from the shared helper so
// the ticket channel and the dashboard describe a wait the same way.
function formatWait(ms) {
    if (!Number.isFinite(Number(ms)) || Number(ms) < 0) return '—';
    return formatDuration(Number(ms));
}

// The SLA thresholds, read without a hard dependency on src/ticketSla.js (that
// module requires this one, so a top-level import would be a cycle). A failure
// here degrades to "SLA display off" — it must never stop a ticket being
// created, claimed or closed.
function getSlaConfig(guildId) {
    try {
        return require('./ticketSla').getTicketSlaConfig(guildId);
    } catch (err) {
        logError(err, 'tickets', 'sla_config');
        return { enabled: false, firstResponseMinutes: null, alertAfterMinutes: null, alertChannelId: null };
    }
}

// ──────────────────── Member Leave Check ────────────────────

async function handleMemberLeave(member) {
    const db = getDb();
    const config = getTicketConfig(member.guild.id);
    if (!config.close_on_leave) return;
    const tickets = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND creator_id = ? AND status IN (?, ?)')
        .all(member.guild.id, member.id, 'open', 'claimed');
    for (const ticket of tickets) {
        try {
            const channel = member.guild.channels.cache.get(ticket.channel_id);
            if (!channel) continue;
            // Same conditional transition as closeTicketById: if the ticket was
            // closed between the read and here, leave the real reason in place.
            const auto = db.prepare(`UPDATE tickets SET status = ?, closed_by_id = ?, closed_by_tag = ?, closed_at = ?, closed_reason = ?
                WHERE id = ? AND status IN (?, ?)`)
                .run('closed', client.user.id, client.user.tag + ' (Auto)', Date.now(), 'Member left the server', ticket.id, 'open', 'claimed');
            if (auto.changes === 0) continue;
            const embed = new EmbedBuilder().setColor(TICKET_COLORS.closed).setTitle('🔒 Ticket Auto-Closed')
                .setDescription('**' + member.user.tag + '** has left the server. Ticket automatically closed.').setTimestamp();
            await channel.send({ embeds: [embed] });
            setTimeout(async () => {
                try { await saveTranscript(member.guild, ticket, channel); await channel.delete('Member left — auto close ticket'); }
                catch (err) { logError(err, 'tickets', 'autoCloseDelete'); }
            }, 5000);
        } catch (err) { logError(err, 'tickets', 'handleMemberLeave'); }
    }
}

// ──────────────────── Deleted-Channel Cleanup ────────────────────
// If a ticket channel is deleted manually, the DB row stays 'open' forever —
// which blocks the user from creating new tickets and shows a phantom open
// ticket in the dashboard. These helpers close such orphaned rows.

function markTicketChannelDeleted(ticket) {
    try {
        const db = getDb();
        const byId = client && client.user ? client.user.id : null;
        const byTag = client && client.user ? client.user.tag + ' (Auto)' : 'System (Auto)';
        const deleted = db.prepare(`UPDATE tickets SET status = ?, closed_by_id = ?, closed_by_tag = ?, closed_at = ?, closed_reason = ?
            WHERE id = ? AND status IN (?, ?)`)
            .run('closed', byId, byTag, Date.now(), 'Channel deleted', ticket.id, 'open', 'claimed');
        if (deleted.changes === 0) return;
        recordTicketMessage(ticket.id, '0', 'System', null, 'Ticket closed — channel was deleted', 1);
    } catch (err) { logError(err, 'tickets', 'markTicketChannelDeleted'); }
}

// Close every open/claimed ticket in a guild whose channel no longer exists.
function closeDeletedChannelTickets(guild) {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM tickets WHERE guild_id = ? AND status IN ('open','claimed')").all(guild.id);
    let closed = 0;
    for (const t of rows) {
        if (!guild.channels.cache.get(t.channel_id)) {
            markTicketChannelDeleted(t);
            closed++;
        }
    }
    return closed;
}

// Returns the user's first genuinely-open ticket, auto-closing any stale ones
// whose channels were deleted. Returns null when the user may create a ticket.
// Only the user's own rows are scanned here — other users' stale tickets are
// handled by the channelDelete hook and the periodic sweep.
function getBlockingOpenTicket(guild, userId) {
    const db = getDb();
    const mine = db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND creator_id = ? AND status IN (?, ?)')
        .all(guild.id, userId, 'open', 'claimed');
    let firstLive = null;
    for (const t of mine) {
        if (!guild.channels.cache.get(t.channel_id)) {
            markTicketChannelDeleted(t);
        } else if (!firstLive) {
            firstLive = t;
        }
    }
    return firstLive;
}

// One member's ticket history — the member file's view (src/memberFile.js).
// Unlike getBlockingOpenTicket this only reads: it never marks a deleted
// channel, because a staff file must not mutate anything it looks at. Guild
// scoped (idx_tickets_creator covers guild_id + creator_id).
function getTicketsForUser(guildId, userId, limit = 25) {
    const db = getDb();
    const safeLimit = Math.min(limit || 25, 100);
    return db.prepare('SELECT * FROM tickets WHERE guild_id = ? AND creator_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(guildId, userId, safeLimit);
}

// channelDelete event hook — close a ticket if its channel was deleted.
function handleTicketChannelDeleted(channel) {
    try {
        const db = getDb();
        const ticket = db.prepare("SELECT * FROM tickets WHERE channel_id = ? AND status IN ('open','claimed')").get(channel.id);
        if (!ticket) return;
        markTicketChannelDeleted(ticket);
    } catch (err) { logError(err, 'tickets', 'handleTicketChannelDeleted'); }
}

// ──────────────────── Ticket Transfer (Feature 4) ────────────────────

async function transferTicket(guild, channel, transferer, targetMember) {
    const db = getDb();
    const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ? AND guild_id = ? AND status = ?').get(channel.id, guild.id, 'claimed');
    if (!ticket) return { error: 'No claimed ticket found for this channel.' };
    if (!(await isTicketStaff(guild, ticket, transferer))) {
        return { error: 'Only support staff can transfer tickets.' };
    }
    if (!(await isTicketStaff(guild, ticket, targetMember))) {
        return { error: 'Tickets can only be transferred to support staff.' };
    }

    const previousClaimer = ticket.claimer_id;
    db.prepare('UPDATE tickets SET claimer_id = ? WHERE id = ?').run(targetMember.id, ticket.id);

    const transferEmbed = new EmbedBuilder()
        .setColor(TICKET_COLORS.claimed)
        .setTitle('🔄 Ticket Transferred')
        .setDescription('**' + targetMember.user.tag + '** is now handling this ticket (transferred from <@' + previousClaimer + '>).')
        .setFooter({ text: guild.name, iconURL: guild.iconURL() }).setTimestamp();
    await channel.send({ embeds: [transferEmbed] });

    // Update the claimer's channel permissions
    try {
        await channel.permissionOverwrites.edit(targetMember.id, {
            ViewChannel: true, SendMessages: true, ReadMessageHistory: true, AttachFiles: true, AddReactions: true,
        });
    } catch {}

    recordTicketMessage(ticket.id, '0', 'System', null, 'Ticket transferred from ' + transferer.tag + ' to ' + targetMember.user.tag, 1);

    // SSE broadcast
    try {
        if (global.broadcastDashboard) {
            global.broadcastDashboard('ticket_transferred', {
                guildId: guild.id, ticketId: ticket.id,
                previousClaimer: previousClaimer, newClaimer: targetMember.id,
                newClaimerTag: targetMember.user.tag,
            });
        }
    } catch {}

    return { success: true, ticketNumber: ticket.ticket_number };
}

// ──────────────────── Blacklist (Feature 3) ────────────────────

function getBlacklist(guildId) {
    const db = getDb();
    return db.prepare('SELECT * FROM ticket_blacklist WHERE guild_id = ? ORDER BY blacklisted_at DESC').all(guildId);
}

function addBlacklist(guildId, userId, reason, blacklistedBy) {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO ticket_blacklist (guild_id, user_id, reason, blacklisted_by, blacklisted_at) VALUES (?, ?, ?, ?, ?)')
        .run(guildId, userId, reason || '', blacklistedBy, Date.now());
    return true;
}

function removeBlacklist(guildId, userId) {
    const db = getDb();
    db.prepare('DELETE FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
    return true;
}

function isBlacklisted(guildId, userId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM ticket_blacklist WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
    return row || null;
}

// ──────────────────── Inactivity Auto-Close (Feature 2) ────────────────────

function updateLastActivity(ticketId) {
    try {
        const db = getDb();
        db.prepare('UPDATE tickets SET last_activity_at = ? WHERE id = ?').run(Date.now(), ticketId);
    } catch {}
}

// Check all open/claimed tickets for inactivity every 2 minutes
let inactivityInterval = null;

function startInactivityCheck(clientInstance) {
    if (inactivityInterval) clearInterval(inactivityInterval);
    inactivityInterval = setInterval(async () => {
        try {
            const db = getDb();
            // Close any open/claimed ticket whose channel no longer exists (e.g.
            // deleted manually while the bot was offline) so stale rows never
            // block new tickets or show phantom open tickets.
            for (const staleGuild of clientInstance.guilds.cache.values()) {
                closeDeletedChannelTickets(staleGuild);
            }
            // Get all open/claimed tickets with their panel type info
            const tickets = db.prepare(`
                SELECT t.*, tp.inactivity_timeout
                FROM tickets t
                LEFT JOIN ticket_panel_types tp ON t.panel_type_id = tp.id
                WHERE t.status IN ('open', 'claimed') AND tp.inactivity_timeout IS NOT NULL AND tp.inactivity_timeout > 0
            `).all();

            const now = Date.now();
            for (const ticket of tickets) {
                const guild = clientInstance.guilds.cache.get(ticket.guild_id);
                if (!guild) continue;

                const channel = guild.channels.cache.get(ticket.channel_id);
                if (!channel) continue;

                const lastActivity = ticket.last_activity_at || ticket.created_at;
                const timeoutMs = ticket.inactivity_timeout * 60 * 60 * 1000;
                const graceMs = (ticket.inactivity_grace || 6) * 60 * 60 * 1000;
                const elapsed = now - lastActivity;

                if (elapsed >= timeoutMs && elapsed < (timeoutMs + graceMs)) {
                    // Check if we already sent a warning (look for system message)
                    const warningSent = db.prepare(
                        'SELECT id FROM ticket_messages WHERE ticket_id = ? AND content LIKE ? AND is_system = 1'
                    ).get(ticket.id, '%inactivity%auto-close%');

                    if (!warningSent) {
                        // Send warning embed with "Still need help?" button
                        const warningEmbed = new EmbedBuilder()
                            .setColor(0xF1C40F)
                            .setTitle('⏰ Inactivity Warning')
                            .setDescription(
                                'This ticket has been inactive for **' + ticket.inactivity_timeout + ' hour' +
                                (ticket.inactivity_timeout === 1 ? '' : 's') + '**.' +
                                '\n\nIf no response is received within the grace period, this ticket will be automatically closed.' +
                                '\n\nClick **Still need help?** to keep this ticket open.'
                            )
                            .setFooter({ text: guild.name, iconURL: guild.iconURL() })
                            .setTimestamp();

                        const keepBtn = new ActionRowBuilder().addComponents(
                            new ButtonBuilder()
                                .setCustomId('tk_keep_' + ticket.id)
                                .setLabel('Still need help?')
                                .setStyle(ButtonStyle.Success)
                                .setEmoji('🙋')
                        );

                        try {
                            await channel.send({ embeds: [warningEmbed], components: [keepBtn] });
                            recordTicketMessage(ticket.id, '0', 'System', null,
                                '⚠️ Inactivity auto-close warning sent (timeout: ' + ticket.inactivity_timeout + 'h)', 1);
                        } catch {}
                    }
                } else if (elapsed >= (timeoutMs + graceMs)) {
                    // Auto-close the ticket
                    try {
                        const closer = clientInstance.user;
                        await closeTicketById(guild, channel, closer, 'Auto-closed due to inactivity', ticket);
                    } catch (err) {
                        require('./logError')(err, 'tickets', 'inactivityAutoClose');
                    }
                }
            }
        } catch (err) {
            try {
                const { logError } = require('./logError');
                logError(err, 'tickets', 'inactivityCheck');
            } catch {}
        }
    }, 120000); // Check every 2 minutes
}

function stopInactivityCheck() {
    if (inactivityInterval) {
        clearInterval(inactivityInterval);
        inactivityInterval = null;
    }
}

// ──────────────────── Save Rating (Feature 1) ────────────────────

function saveRating(ticketId, guildId, rating, feedback) {
    const db = getDb();
    db.prepare('INSERT OR REPLACE INTO ticket_ratings (ticket_id, guild_id, rating, feedback, submitted_at) VALUES (?, ?, ?, ?, ?)')
        .run(ticketId, guildId, rating, feedback || null, Date.now());
    return true;
}

function getGuildRatings(guildId) {
    const db = getDb();
    return db.prepare('SELECT * FROM ticket_ratings WHERE guild_id = ? ORDER BY submitted_at DESC LIMIT 50').all(guildId);
}

function getAverageRating(guildId) {
    const db = getDb();
    const row = db.prepare('SELECT AVG(rating) as avg, COUNT(*) as total FROM ticket_ratings WHERE guild_id = ?').get(guildId);
    return row || { avg: 0, total: 0 };
}

// ──────────────────── Exports ────────────────────

module.exports = {
    setTicketClient,
    // Config
    getTicketConfig, updateTicketConfig,
    // Panels
    getPanels, getPanel, createPanel, updatePanel, deletePanel, clonePanel,
    getPanelTypes, getPanelType, createPanelType, updatePanelType, deletePanelType, reorderPanelTypes,
    getPanelTicketCounter, setPanelTicketCounter,
    parseQuestions, parseSupportRoles,
    // Ticket actions
    createTicket, closeTicket, claimTicket, isTicketStaff,
    addUserToTicket, removeUserFromTicket, renameTicket,
    closeTicketById,
    // Panel flow
    sendTicketPanel, showTicketTypeModal, showQuestionsModal, handleQuestionsSubmit,
    // Transcript
    saveTranscript, recordTicketMessage, logTicketAction, formatWait,
    // Auto-close
    handleMemberLeave,
    // Deleted-channel cleanup
    getBlockingOpenTicket, getTicketsForUser, closeDeletedChannelTickets, handleTicketChannelDeleted,
    // Feature 1: Ratings
    saveRating, getGuildRatings, getAverageRating,
    // Feature 2: Inactivity
    updateLastActivity, startInactivityCheck, stopInactivityCheck,
    // Feature 3: Blacklist
    getBlacklist, addBlacklist, removeBlacklist, isBlacklisted,
    // Feature 4: Transfer
    transferTicket,
    // UI
    TICKET_COLORS,
};

// ──────────────────── Part 06: Engagement ────────────────────
// Reaction roles, role menus, reminders, giveaways, and polls /
// announcements sent through the bot.

const { getDb, recordAuditTrail } = require('../../db');
const { getReactionRoles, addReactionRole, removeReactionRole } = require('../../reactionRoles');
const { createRoleMenu, getRoleMenu, getRoleMenus, removeRoleMenu, addRoleMenuOption, getRoleMenuOptions, removeRoleMenuOption } = require('../../roleMenus');
const { logError } = require('../../logError');
const { getGuildConfig } = require('../../config');
const custom = require('../../customCommands');
const { sanitizeForDB, sanitizeForEmbed } = require('../../helpers');
const { EmbedBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ActionRowBuilder } = require('discord.js');
const { getClient } = require('../core');
const { parseWinnerIds } = require('../../giveaways');

function register(app, ctx) {
    const { requireAuth, checkOwner, filterByScope, getSessionUser } = ctx;

    // ── Reaction Roles API ──
    app.get('/api/server/:id/reaction-roles', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const roles = getReactionRoles(guild.id);
            const channels = guild.channels.cache
                .filter(c => c.type === 0 || c.type === 5 || c.type === 15)
                .sort((a, b) => a.position - b.position)
                .map(c => ({ id: c.id, name: '#' + c.name }));
            const rolesList = guild.roles.cache
                .filter(r => r.name !== '@everyone' && !r.managed)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor }));
            res.json({ roles, channels, rolesList });
        } catch { res.json({ roles: [], channels: [], rolesList: [] }); }
    });

    app.post('/api/server/:id/reaction-roles', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { messageId, channelId, emoji, roleId, label } = req.body;
        if (!messageId || !channelId || !emoji || !roleId) return res.status(400).json({ error: 'Missing required fields' });
        try {
            const channel = guild.channels.cache.get(channelId);
            if (!channel) return res.status(400).json({ error: 'Channel not found' });
            const role = guild.roles.cache.get(roleId);
            if (!role) return res.status(400).json({ error: 'Role not found' });
            const result = addReactionRole(guild.id, messageId, channelId, emoji, roleId, label || null);
            res.json({ success: true, roles: result });
        } catch (err) {
            logError(err, 'dashboard', 'reactionrole_add');
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/server/:id/reaction-roles', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { messageId, emoji } = req.body;
        if (!messageId || !emoji) return res.status(400).json({ error: 'Missing messageId or emoji' });
        try {
            const result = removeReactionRole(guild.id, messageId, emoji);
            if (!result) return res.status(404).json({ error: 'Reaction role not found' });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'reactionrole_remove');
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/reaction-roles/message', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { channelId, content, roles } = req.body;
        if (!channelId || !roles?.length) return res.status(400).json({ error: 'Missing channelId or roles' });
        try {
            const channel = guild.channels.cache.get(channelId);
            if (!channel || !channel.isTextBased()) return res.status(400).json({ error: 'Invalid text channel' });
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('Reaction Roles')
                .setDescription(content || 'React to get roles!')
                .setFooter({ text: 'Click a reaction to get/remove the role' });
            const msg = await channel.send({ embeds: [embed] });
            for (const r of roles) {
                await addReactionRole(guild.id, msg.id, channelId, r.emoji, r.roleId, r.label || null);
                try { await msg.react(r.emoji); } catch {}
            }
            res.json({ success: true, messageId: msg.id });
        } catch (err) {
            logError(err, 'dashboard', 'reactionrole_message');
            res.status(500).json({ error: err.message });
        }
    });

    // ── Role Menus API ──
    app.get('/api/server/:id/role-menus', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const menus = getRoleMenus(guild.id);
            const channels = guild.channels.cache
                .filter(c => c.type === 0 || c.type === 5 || c.type === 15)
                .sort((a, b) => a.position - b.position)
                .map(c => ({ id: c.id, name: '#' + c.name }));
            const rolesList = guild.roles.cache
                .filter(r => r.name !== '@everyone' && !r.managed)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? null : r.hexColor }));
            res.json({ menus, channels, rolesList });
        } catch { res.json({ menus: [], channels: [], rolesList: [] }); }
    });

    // Options for one role menu. The vanilla editor fetched this URL, but the
    // route had never been registered — so its options list always came back
    // 404 and the editor was silently unusable. It reads the same rows the
    // publish route uses, so the two can't disagree.
    app.get('/api/server/:id/role-menus/:messageId/options', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            if (!getRoleMenu(guild.id, req.params.messageId)) return res.status(404).json({ error: 'Menu not found' });
            const options = getRoleMenuOptions(guild.id, req.params.messageId).map(o => ({
                roleId: o.role_id,
                label: o.label,
                emoji: o.emoji,
                description: o.description,
                sortOrder: o.sort_order,
            }));
            res.json({ options });
        } catch (err) {
            logError(err, 'dashboard', 'rolemenu_options');
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/role-menus', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { channelId, title } = req.body;
        if (!channelId) return res.status(400).json({ error: 'Missing channelId' });
        try {
            const channel = guild.channels.cache.get(channelId);
            if (!channel || !channel.isTextBased()) return res.status(400).json({ error: 'Invalid text channel' });
            if (!guild.members.me.permissions.has('ManageRoles')) return res.status(403).json({ error: 'Bot needs Manage Roles permission' });
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🌟 ' + (title || 'Self-Assignable Roles'))
                .setDescription('Select the roles you want from the dropdown below!\n*(You can select multiple)*')
                .setFooter({ text: guild.name, iconURL: guild.iconURL() })
                .setTimestamp();
            const msg = await channel.send({ embeds: [embed] });
            createRoleMenu(guild.id, msg.id, channelId, title || 'Self-Assignable Roles');
            // The menu's title is user-authored text, so only ids are recorded.
            recordAuditTrail({ type: 'rolemenu', userId: getSessionUser(req), guildId: guild.id, action: 'rolemenu.create', details: { menuId: msg.id } });
            res.json({ success: true, messageId: msg.id, menu: getRoleMenus(guild.id).find(m => m.message_id === msg.id) });
        } catch (err) {
            logError(err, 'dashboard', 'rolemenu_create');
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/role-menus/:messageId/options', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { roleId, label, emoji, description } = req.body;
        if (!roleId) return res.status(400).json({ error: 'Missing roleId' });
        try {
            const role = guild.roles.cache.get(roleId);
            if (!role) return res.status(400).json({ error: 'Role not found' });
            if (role.managed) return res.status(400).json({ error: 'Cannot add managed/bot roles' });
            if (role.comparePositionTo(guild.members.me.roles.highest) >= 0) return res.status(400).json({ error: 'Role is higher than bot\'s highest role' });
            if (!addRoleMenuOption(guild.id, req.params.messageId, roleId, label || role.name, emoji, description)) {
                return res.status(404).json({ error: 'Menu not found' });
            }
            // The label and description are user-authored text; ids only.
            recordAuditTrail({ type: 'rolemenu', userId: getSessionUser(req), guildId: guild.id, action: 'rolemenu.option.add', details: { menuId: String(req.params.messageId), roleId: String(roleId) } });
            res.json({ success: true, options: getRoleMenuOptions(guild.id, req.params.messageId) });
        } catch (err) {
            logError(err, 'dashboard', 'rolemenu_add_option');
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/server/:id/role-menus/:messageId/options', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { roleId } = req.body;
        if (!roleId) return res.status(400).json({ error: 'Missing roleId' });
        try {
            const result = removeRoleMenuOption(guild.id, req.params.messageId, roleId);
            if (!result) return res.status(404).json({ error: 'Option not found' });
            recordAuditTrail({ type: 'rolemenu', userId: getSessionUser(req), guildId: guild.id, action: 'rolemenu.option.remove', details: { menuId: String(req.params.messageId), roleId: String(roleId) } });
            res.json({ success: true, options: getRoleMenuOptions(guild.id, req.params.messageId) });
        } catch (err) {
            logError(err, 'dashboard', 'rolemenu_remove_option');
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/server/:id/role-menus/:messageId/publish', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const menu = getRoleMenu(guild.id, req.params.messageId);
            if (!menu) return res.status(404).json({ error: 'Menu not found' });
            const channel = guild.channels.cache.get(menu.channel_id);
            if (!channel) return res.status(400).json({ error: 'Channel not found' });
            const msg = await channel.messages.fetch(req.params.messageId).catch(() => null);
            if (!msg || msg.author?.id !== client.user?.id || !msg.author?.id) return res.status(404).json({ error: 'Message not found' });
            const options = getRoleMenuOptions(guild.id, req.params.messageId);
            if (!options.length) return res.status(400).json({ error: 'Menu has no roles! Add some first.' });
            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('🌟 ' + (msg.embeds[0]?.title || 'Self-Assignable Roles'))
                .setDescription('Select the roles you want from the dropdown below!\n*(You can select multiple)*')
                .setFooter({ text: guild.name, iconURL: guild.iconURL() })
                .setTimestamp();
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId('rm_' + req.params.messageId)
                .setPlaceholder('Select roles...')
                .setMinValues(0)
                .setMaxValues(options.length)
                .addOptions(options.map(o => new StringSelectMenuOptionBuilder()
                    .setLabel(o.label || guild.roles.cache.get(o.role_id)?.name || o.role_id)
                    .setValue(o.role_id)
                    .setDescription(o.description || null)
                    .setEmoji(o.emoji || null)
                ));
            const row = new ActionRowBuilder().addComponents(selectMenu);
            await msg.edit({ embeds: [embed], components: [row] });
            recordAuditTrail({ type: 'rolemenu', userId: getSessionUser(req), guildId: guild.id, action: 'rolemenu.publish', details: { menuId: String(req.params.messageId), optionCount: options.length } });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'rolemenu_publish');
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/server/:id/role-menus/:messageId', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const menu = getRoleMenu(guild.id, req.params.messageId);
            if (!menu) return res.status(404).json({ error: 'Menu not found' });
            const channel = guild.channels.cache.get(menu.channel_id);
            if (channel) {
                const msg = await channel.messages.fetch(req.params.messageId).catch(() => null);
                if (msg?.author?.id === client.user?.id && msg?.author?.id) await msg.delete().catch((err) => logError(err, 'dashboard', 'rolemenu_message_delete'));
            }
            const result = removeRoleMenu(guild.id, req.params.messageId);
            if (!result) return res.status(404).json({ error: 'Menu not found' });
            recordAuditTrail({ type: 'rolemenu', userId: getSessionUser(req), guildId: guild.id, action: 'rolemenu.remove', details: { menuId: String(req.params.messageId) } });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'rolemenu_delete');
            res.status(500).json({ error: err.message });
        }
    });

    // ── Reminders ──
    // Reminders are personal Discord DMs, not guild records. Owner sessions
    // (the shared password or OWNER_ID) keep the admin view over every pending
    // reminder; a scoped session only ever sees and changes its own. The target
    // id is never taken from the request body for a scoped caller, otherwise a
    // limited dashboard account could DM any user on Discord.
    function reminderTargetUserId(req) {
        if (checkOwner(req)) return null; // null means "owner, caller supplies the target"
        return req.discordUserId ? String(req.discordUserId) : '';
    }

    app.get('/api/reminders', requireAuth, (req, res) => {
        try {
            const reminders = require('../../reminders');
            const target = reminderTargetUserId(req);
            const all = target === null
                ? reminders.getAllPending()
                : (target ? reminders.getUserReminders(target) : []);
            res.json(all.slice(0, 50).map(r => ({
                id: r.id, text: r.text.slice(0, 100),
                remindAt: r.remindAt, createdAt: r.createdAt, userId: r.userId,
            })));
        } catch { res.json([]); }
    });

    app.post('/api/reminders', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const { userId, channelId, text, durationMs } = req.body || {};
        const scopedTarget = reminderTargetUserId(req);
        const targetUserId = scopedTarget === null ? String(userId || '') : scopedTarget;
        if (!targetUserId) return res.status(400).json({ error: 'Missing userId' });
        if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Missing text' });
        if (text.length > 2000) return res.status(400).json({ error: 'Reminder text is limited to 2000 characters' });
        const delay = Number(durationMs);
        if (!Number.isFinite(delay) || delay <= 0 || delay > 365 * 24 * 60 * 60 * 1000) {
            return res.status(400).json({ error: 'Invalid reminder delay' });
        }
        try {
            const reminders = require('../../reminders');
            const reminder = reminders.addReminder(targetUserId, channelId || null, text, delay);
            // The reminder body is user content and stays out of the log; the id,
            // the target and the delay are enough to describe the change.
            recordAuditTrail({ type: 'reminder', userId: getSessionUser(req), action: 'reminder.create', details: { reminderId: reminder.id, targetUserId, durationMs: delay } });
            res.json({ success: true, reminder });
        } catch (err) {
            logError(err, 'dashboard', 'reminder_create');
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/reminders/:id', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const scopedTarget = reminderTargetUserId(req);
        const targetUserId = scopedTarget === null ? String(req.body?.userId || '') : scopedTarget;
        if (!targetUserId) return res.status(400).json({ error: 'Missing userId' });
        try {
            const reminders = require('../../reminders');
            const result = reminders.removeReminder(req.params.id, targetUserId);
            if (!result) return res.status(404).json({ error: 'Reminder not found' });
            recordAuditTrail({ type: 'reminder', userId: getSessionUser(req), action: 'reminder.remove', details: { reminderId: String(req.params.id), targetUserId } });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'reminder_delete');
            res.status(500).json({ error: err.message });
        }
    });

    // ── Giveaways Manager ──
    app.get('/api/giveaways', requireAuth, (req, res) => {
        try {
            const client = getClient();
            const db = getDb();
            const rows = db.prepare('SELECT * FROM giveaways ORDER BY created_at DESC LIMIT 100').all();
            res.json(filterByScope(req, rows, 'guild_id').map(g => ({
                id: g.id,
                guildId: g.guild_id,
                guildName: (client && client.guilds.cache.get(g.guild_id)) ? client.guilds.cache.get(g.guild_id).name : g.guild_id,
                channelId: g.channel_id,
                prize: g.prize,
                winners: g.winners,
                hostTag: g.host_tag || null,
                endsAt: g.ends_at,
                status: g.status,
                winnerIds: parseWinnerIds(g.winner_ids),
                endedAt: g.ended_at,
                createdAt: g.created_at,
            })));
        } catch { res.json([]); }
    });

    app.post('/api/giveaways/create', requireAuth, async (req, res) => {
        try {
            const client = getClient();
            if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can create giveaways' });
            if (!client || !client.user) return res.status(503).json({ error: 'Bot is not online yet' });
            const { guildId, channelId, prize, durationHours, winners, description } = req.body || {};
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return res.status(400).json({ error: 'Bot is not in that server' });
            if (!prize || typeof prize !== 'string' || !prize.trim()) return res.status(400).json({ error: 'Missing prize' });
            const hours = parseFloat(durationHours);
            if (!hours || hours <= 0 || hours > 24 * 30) return res.status(400).json({ error: 'Invalid duration in hours' });
            const winnerCount = Math.min(Math.max(parseInt(winners) || 1, 1), 20);
            let channel = channelId ? guild.channels.cache.get(channelId) : null;
            if (!channel || !channel.isTextBased()) {
                channel = guild.channels.cache.find(c => c.type === 0 && guild.members.me && c.permissionsFor(guild.members.me)?.has('SendMessages')) || null;
            }
            if (!channel) return res.status(400).json({ error: 'No text channel the bot can post in' });
            const gw = require('../../giveaways');
            const g = gw.createGiveaway({
                guildId: guild.id,
                channelId: channel.id,
                prize: sanitizeForDB(prize).slice(0, 200),
                durationMs: Math.round(hours * 3600000),
                winners: winnerCount,
                hostId: 'dashboard',
                hostTag: 'Dashboard',
                description: description ? sanitizeForDB(description).slice(0, 500) : undefined,
            });
            await gw.postGiveaway(channel, g);
            recordAuditTrail({ type: 'giveaway', userId: getSessionUser(req), guildId: guild.id, action: 'giveaway.create', details: { giveawayId: g.id, channelId: channel.id, winners: winnerCount } });
            res.json({ success: true, id: g.id });
        } catch (err) {
            logError(err, 'dashboard', 'giveaway_create');
            res.status(500).json({ error: err.message || 'Failed to create giveaway' });
        }
    });

    app.post('/api/giveaways/end', requireAuth, async (req, res) => {
        try {
            if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can end giveaways' });
            const endId = String(req.body?.id || '');
            const ended = await require('../../giveaways').endGiveaway(endId);
            // endGiveaway reports a no-op (unknown id, already ended) as { error }
            // rather than throwing, so the entry is gated on a real end. The
            // response below is unchanged either way.
            if (ended && ended.success) {
                const row = getDb().prepare('SELECT guild_id FROM giveaways WHERE id = ?').get(endId);
                recordAuditTrail({ type: 'giveaway', userId: getSessionUser(req), guildId: row ? row.guild_id : null, action: 'giveaway.end', details: { giveawayId: endId, winners: (ended.winners || []).length } });
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to end giveaway' });
        }
    });

    app.post('/api/giveaways/cancel', requireAuth, (req, res) => {
        try {
            if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can cancel giveaways' });
            const result = require('../../giveaways').cancelGiveaway(String(req.body?.id || ''));
            if (!result.success) return res.status(400).json({ error: 'Giveaway not found or not active' });
            const cancelledId = String(req.body?.id || '');
            const row = getDb().prepare('SELECT guild_id FROM giveaways WHERE id = ?').get(cancelledId);
            recordAuditTrail({ type: 'giveaway', userId: getSessionUser(req), guildId: row ? row.guild_id : null, action: 'giveaway.cancel', details: { giveawayId: cancelledId } });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to cancel giveaway' });
        }
    });

    app.post('/api/giveaways/reroll', requireAuth, async (req, res) => {
        try {
            if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can reroll giveaways' });
            const rerollId = String(req.body?.id || '');
            const winners = await require('../../giveaways').rerollGiveaway(rerollId);
            // A rejected reroll comes back as { error } instead of throwing, so
            // only a real reroll is recorded — and the response shape stays as it
            // was, including the pass-through of the result object.
            if (winners && winners.success) {
                const row = getDb().prepare('SELECT guild_id FROM giveaways WHERE id = ?').get(rerollId);
                recordAuditTrail({ type: 'giveaway', userId: getSessionUser(req), guildId: row ? row.guild_id : null, action: 'giveaway.reroll', details: { giveawayId: rerollId, winners: (winners.winners || []).length } });
            }
            res.json({ success: true, winners: winners || [] });
        } catch (err) {
            res.status(500).json({ error: err.message || 'Failed to reroll' });
        }
    });

    // ── Polls/Announcements ──
    app.post('/api/polls/create', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can create polls' });
        const { guildId, channelId, question, options, multi, anonymous, durationHours } = req.body || {};
        if (!guildId || !channelId || !question || !options || options.length < 2) return res.status(400).json({ error: 'Missing required fields' });
        try {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return res.status(400).json({ error: 'Bot is not in that server' });
            const channel = guild.channels.cache.get(channelId);
            if (!channel || !channel.isTextBased()) return res.status(400).json({ error: 'Invalid text channel' });

            const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

            const pollId = 'poll_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            const endsAt = Date.now() + (parseFloat(durationHours) || 24) * 3600000;

            const db = getDb();
            db.prepare('INSERT INTO poll_votes (message_id, user_id, option_index, voted_at, poll_type) VALUES (?, ?, ?, ?, ?)')
                .run(pollId, 'system', -1, Date.now(), multi ? 'multi' : anonymous ? 'anonymous' : 'single');

            const embed = new EmbedBuilder()
                .setColor(0x5865F2)
                .setTitle('📊 ' + sanitizeForDB(question).slice(0, 256))
                .setFooter({ text: 'Poll ends <t:' + Math.floor(endsAt / 1000) + ':R>' });

            // Options as fields (matching /poll), so the live vote tally can
            // render counts — handlePollVote rewrites fields, and a
            // description-only option list never showed any numbers.
            for (const opt of options) {
                embed.addFields({
                    name: sanitizeForDB(opt).slice(0, 256),
                    value: '📊 Votes: **0** (0%)',
                    inline: options.length <= 2,
                });
            }

            const buttons = options.map((opt, i) => new ButtonBuilder()
                .setCustomId((multi ? 'pm' : anonymous ? 'pa' : 'pv') + '_vote_' + i + '_' + pollId)
                .setLabel(opt.slice(0, 80))
                .setStyle(ButtonStyle.Primary));

            const rows = [];
            for (let i = 0; i < buttons.length; i += 5) {
                rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
            }
            rows.push(new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('pvv_' + pollId).setLabel('Show Voters').setStyle(ButtonStyle.Secondary)
            ));

            const msg = await channel.send({ embeds: [embed], components: rows });

            db.prepare('UPDATE poll_votes SET message_id = ? WHERE message_id = ?').run(msg.id, pollId);
            // Record where the poll lives so POST /api/polls/end can finalize it.
            require('../../interactions').recordPoll({
                messageId: msg.id,
                guildId,
                channelId,
                question,
                options,
                pollType: multi ? 'multi' : anonymous ? 'anonymous' : 'single',
                endsAt,
            });

            res.json({ success: true, messageId: msg.id, pollId });
        } catch (err) {
            logError(err, 'dashboard', 'poll_create');
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/polls/end', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can end polls' });
        const { messageId } = req.body || {};
        if (!messageId) return res.status(400).json({ error: 'Missing messageId' });
        try {
            await require('../../interactions').endPoll(messageId, { client, channelId: req.body?.channelId });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/announcements/create', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can send announcements' });
        const { guildId, channelId, title, message, color } = req.body || {};
        if (!guildId || !channelId || !title || !message) return res.status(400).json({ error: 'Missing required fields' });
        try {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) return res.status(400).json({ error: 'Bot is not in that server' });
            const channel = guild.channels.cache.get(channelId);
            if (!channel || !channel.isTextBased()) return res.status(400).json({ error: 'Invalid text channel' });

            const { EmbedBuilder } = require('discord.js');
            const embed = new EmbedBuilder()
                .setColor(color ? sanitizeForDB(color) : 0x5865F2)
                .setTitle(sanitizeForEmbed(title).slice(0, 256))
                .setDescription(sanitizeForDB(message).slice(0, 4096))
                .setTimestamp();

            await channel.send({ embeds: [embed] });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'announcement_create');
            res.status(500).json({ error: err.message });
        }
    });

    // ── Custom Commands ──
    // Both of these live under /api/server/:id/*, so the tenant guard in part
    // 02 has already refused anyone without a grant on the guild.
    app.get('/api/server/:id/custom-commands', requireAuth, (req, res) => {
        try {
            res.json({
                commands: custom.listCustomCommands(req.params.id),
                prefix: getGuildConfig(req.params.id).prefix || ';',
                maxPerGuild: custom.MAX_PER_GUILD,
            });
        } catch (err) {
            logError(err, 'dashboard', 'custom_commands_list');
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/custom-commands', requireAuth, (req, res) => {
        const { name, response, asEmbed } = req.body || {};
        try {
            const result = custom.setCustomCommand(req.params.id, name, { response, asEmbed: !!asEmbed }, getSessionUser(req));
            if (result.error) return res.status(400).json({ error: result.error });
            res.json({ success: true, command: result.command, created: result.created });
        } catch (err) {
            logError(err, 'dashboard', 'custom_command_save');
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/server/:id/custom-commands/:name', requireAuth, (req, res) => {
        try {
            const removed = custom.deleteCustomCommand(req.params.id, req.params.name);
            if (!removed) return res.status(404).json({ error: 'No custom command with that name' });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'custom_command_delete');
            res.status(500).json({ error: err.message });
        }
    });

    // ── Autoresponders ──
    app.get('/api/server/:id/autoresponders', requireAuth, (req, res) => {
        const client = getClient();
        const guild = client ? client.guilds.cache.get(req.params.id) : null;
        try {
            const channels = guild
                ? guild.channels.cache.filter(c => c.type === 0 || c.type === 5).sort((a, b) => a.position - b.position).map(c => ({ id: c.id, name: '#' + c.name }))
                : [];
            res.json({ responders: custom.listAutoresponders(req.params.id), channels, matchTypes: custom.MATCH_TYPES });
        } catch (err) {
            logError(err, 'dashboard', 'autoresponders_list');
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/autoresponders', requireAuth, (req, res) => {
        const { trigger, response, matchType, channelId } = req.body || {};
        try {
            const result = custom.addAutoresponder(req.params.id, { trigger, response, matchType, channelId }, getSessionUser(req));
            if (result.error) return res.status(400).json({ error: result.error });
            res.json({ success: true, responder: result.responder });
        } catch (err) {
            logError(err, 'dashboard', 'autoresponder_create');
            res.status(500).json({ error: err.message });
        }
    });

    app.patch('/api/server/:id/autoresponders/:rid', requireAuth, (req, res) => {
        try {
            const result = custom.updateAutoresponder(req.params.id, req.params.rid, req.body || {});
            if (result.error) return res.status(400).json({ error: result.error });
            res.json({ success: true, responder: result.responder });
        } catch (err) {
            logError(err, 'dashboard', 'autoresponder_update');
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/server/:id/autoresponders/:rid', requireAuth, (req, res) => {
        try {
            const removed = custom.deleteAutoresponder(req.params.id, req.params.rid);
            if (!removed) return res.status(404).json({ error: 'No autoresponder with that ID' });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'autoresponder_delete');
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { register };

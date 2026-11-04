// ──────────────────── Part 04: Servers ────────────────────
// Server list, per-server settings/roles/channels, Discord audit log,
// logging config, prefix, greetings, member lists & lookups, webhooks,
// invite stats, and the server detail endpoint.

const { getGuildConfig, updateGuildConfig, getWelcomeConfig, getGoodbyeConfig, updateWelcomeConfig, intToHexString } = require('../../config');
const { getGuildStats } = require('../../stats');
const { getMemberFile } = require('../../memberFile');
const { getInviterStats } = require('../../invites');
const { getAllPermissions } = require('../../permissions');
const { getReactionRoles } = require('../../reactionRoles');
const { getModDmConfig, setModDmConfig } = require('../../modDm');
const { LOG_CATEGORIES } = require('../../constants');
const { logError } = require('../../logError');
const { sanitizeForDB, sanitizeName } = require('../../helpers');
const { getClient } = require('../core');
const { recordAuditTrail } = require('../../db');

function register(app, ctx) {
    const { requireAuth, checkOwner, filterByScope, getSessionUser } = ctx;

    // ── Servers List ──
    app.get('/api/servers', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.json([]);
        const servers = client.guilds.cache.map(g => ({
            id: g.id, name: g.name,
            icon: g.iconURL({ size: 64 }) || '',
            memberCount: g.memberCount,
            boostTier: g.premiumTier,
            boostCount: g.premiumSubscriptionCount || 0,
            channels: g.channels.cache.size,
        })).sort((a, b) => b.memberCount - a.memberCount);
        res.json(filterByScope(req, servers, 'id'));
    });

    // ── Server Management: Roles ──
    app.post('/api/server/:id/settings', requireAuth, (req, res) => {
        const client = getClient();
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can change server settings' });
        const guild = client ? client.guilds.cache.get(req.params.id) : null;
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { prefix, embedColor, modDm } = req.body || {};
        if (prefix !== undefined) {
            const p = String(prefix).trim();
            if (p && (p.length > 5 || /\s/.test(p))) return res.status(400).json({ error: 'Prefix must be 1-5 characters with no spaces' });
            updateGuildConfig(guild.id, cfg => { cfg.prefix = p || ';'; return cfg; });
        }
        if (embedColor !== undefined) {
            const c = String(embedColor).trim();
            if (c && !/^#[0-9a-fA-F]{6}$/.test(c)) return res.status(400).json({ error: 'Embed color must be a hex value like #5865F2' });
            updateGuildConfig(guild.id, cfg => { cfg.embedColor = c || null; return cfg; });
        }
        // Moderation DM receipts (src/modDm.js): switch the receipts off, or
        // set the appeal instructions they carry. Both are optional fields.
        if (modDm !== undefined) {
            if (typeof modDm !== 'object' || modDm === null) return res.status(400).json({ error: 'modDm must be an object' });
            const updates = {};
            if (modDm.enabled !== undefined) {
                if (typeof modDm.enabled !== 'boolean') return res.status(400).json({ error: 'modDm.enabled must be a boolean' });
                updates.enabled = modDm.enabled;
            }
            if (modDm.appealInfo !== undefined) {
                if (modDm.appealInfo !== null && typeof modDm.appealInfo !== 'string') {
                    return res.status(400).json({ error: 'modDm.appealInfo must be a string or null' });
                }
                // Truncation happens in modDm; the route only rejects bad types.
                updates.appealInfo = modDm.appealInfo;
            }
            setModDmConfig(guild.id, updates);
        }
        res.json({ success: true });
    });

    app.get('/api/server/:id/roles', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const roles = guild.roles.cache
            .filter(r => r.name !== '@everyone')
            .sort((a, b) => b.position - a.position)
            .map(r => ({
                id: r.id,
                name: r.name,
                color: r.hexColor === '#000000' ? null : r.hexColor,
                position: r.position,
                memberCount: r.members.size,
                managed: r.managed,
                permissions: r.permissions.toArray().slice(0, 10),
            }));
        res.json(roles);
    });

    // ── Server Management: Channels ──
    app.get('/api/server/:id/channels', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const typeNames = { 0: 'Text', 2: 'Voice', 4: 'Category', 5: 'Announcement', 15: 'Forum' };
        const channels = guild.channels.cache
            .filter(c => c.type !== 4) // exclude categories from flat list
            .sort((a, b) => a.position - b.position)
            .map(c => ({
                id: c.id,
                name: c.name,
                type: typeNames[c.type] || 'Unknown',
                typeId: c.type,
                parentId: c.parentId,
                position: c.position,
                topic: c.topic ? c.topic.slice(0, 80) : null,
                nsfw: c.nsfw || false,
                memberCount: c.type === 2 ? (c.members?.size || 0) : null,
                bitrate: c.type === 2 ? c.bitrate : null,
            }));
        res.json(channels);
    });

    // ── Server Management: Audit Log ──
    app.get('/api/server/:id/audit', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const auditLog = await guild.fetchAuditLogs({ limit: 25 });
            const entries = auditLog.entries.map(e => ({
                id: e.id,
                action: e.action,
                actionType: e.actionType,
                targetType: e.target?.constructor?.name || 'Unknown',
                targetId: e.target?.id || e.targetId || null,
                executorId: e.executor?.id || null,
                executorTag: e.executor?.tag || 'Unknown',
                executorAvatar: e.executor?.displayAvatarURL({ size: 32 }) || null,
                reason: e.reason || null,
                changes: e.changes?.slice(0, 5).map(c => ({ key: c.key, old: String(c.old ?? '').slice(0, 100), new: String(c.new ?? '').slice(0, 100) })) || [],
                createdTimestamp: e.createdTimestamp,
            }));
            res.json(entries);
        } catch (err) {
            res.status(500).json({ error: 'Failed to fetch audit log: ' + err.message });
        }
    });

    // ── Server Management: Update logging config (single category) ──
    app.post('/api/server/:id/log/config', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { category, channelId, enabled, trackedChannel, trackedChannels } = req.body;
        updateGuildConfig(guild.id, (cfg) => {
            if (category) {
                if (channelId !== undefined) cfg.logChannels[category] = channelId || null;
                if (enabled !== undefined) cfg.logCategories[category] = enabled;
            }
            if (trackedChannel !== undefined) {
                if (trackedChannels === 'set') {
                    cfg.trackedChannels = Array.isArray(trackedChannel) ? trackedChannel : [trackedChannel];
                } else if (trackedChannels === 'add') {
                    if (!cfg.trackedChannels.includes(trackedChannel)) cfg.trackedChannels.push(trackedChannel);
                } else if (trackedChannels === 'remove') {
                    cfg.trackedChannels = cfg.trackedChannels.filter(id => id !== trackedChannel);
                } else if (trackedChannels === 'clear') {
                    cfg.trackedChannels = [];
                }
            }
            return cfg;
        });
        recordAuditTrail({ type: 'config', userId: getSessionUser(req), guildId: guild.id, action: 'log.config', details: { category: category || null, enabled, trackedChannels: trackedChannels || null } });
        res.json({ success: true });
    });

    // ── Server Management: Batch update logging config (save all at once) ──
    app.post('/api/server/:id/log/config/batch', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { categories } = req.body;
        if (Array.isArray(categories)) {
            updateGuildConfig(guild.id, (cfg) => {
                for (const cat of categories) {
                    if (cat.category) {
                        if (cat.channelId !== undefined) cfg.logChannels[cat.category] = cat.channelId || null;
                        if (cat.enabled !== undefined) cfg.logCategories[cat.category] = cat.enabled;
                    }
                }
                return cfg;
            });
            const savedCategories = categories.map(c => c && c.category).filter(Boolean);
            if (savedCategories.length) recordAuditTrail({ type: 'config', userId: getSessionUser(req), guildId: guild.id, action: 'log.config.batch', details: { categories: savedCategories } });
        }
        res.json({ success: true });
    });

    // ── Update prefix ──
    app.post('/api/server/:id/prefix', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { prefix } = req.body;
        if (!prefix || prefix.length > 5) return res.status(400).json({ error: 'Prefix must be 1-5 characters' });
        updateGuildConfig(guild.id, (cfg) => { cfg.prefix = prefix; return cfg; });
        recordAuditTrail({ type: 'config', userId: getSessionUser(req), guildId: guild.id, action: 'prefix.update', details: { prefix } });
        res.json({ success: true, prefix });
    });

    // ── Welcome/Goodbye Config ──
    app.get('/api/server/:id/greetings', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        res.json({
            welcome: getWelcomeConfig(guild.id),
            goodbye: getGoodbyeConfig(guild.id),
        });
    });

    app.post('/api/server/:id/greetings/:type', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const type = req.params.type;
        if (type !== 'welcome' && type !== 'goodbye') return res.status(400).json({ error: 'Type must be welcome or goodbye' });

        updateWelcomeConfig(guild.id, type, (cfg) => {
            // Update only the fields that were sent
            const allowedFields = ['enabled', 'channelId', 'content', 'embedTitle', 'embedDescription', 'embedColor', 'embedFooter', 'embedFooterIcon', 'embedThumbnail', 'embedImage', 'embedAuthor', 'embedAuthorIcon'];
            for (const field of allowedFields) {
                if (req.body[field] !== undefined) {
                    // Sanitize text fields
                    const textFields = ['content', 'embedTitle', 'embedDescription', 'embedFooter', 'embedAuthor'];
                    if (textFields.includes(field)) {
                        cfg[field] = sanitizeForDB(req.body[field]).slice(0, field === 'content' ? 2000 : 1024);
                    } else {
                        cfg[field] = req.body[field];
                    }
                }
            }
            return cfg;
        });

        const result = type === 'welcome' ? getWelcomeConfig(guild.id) : getGoodbyeConfig(guild.id);
        res.json({ success: true, config: result });
    });

    // ── Mod Actions: Member search ──
    app.get('/api/server/:id/members', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const q = (req.query.q || '').toLowerCase();
        const members = guild.members.cache.filter(m => {
            return !m.user.bot && (
                m.user.username.toLowerCase().includes(q) ||
                m.displayName.toLowerCase().includes(q) ||
                m.user.id === q
            );
        }).sort((a, b) => a.displayName.localeCompare(b.displayName))
        .map(m => ({
            id: m.user.id,
            tag: m.user.tag,
            username: m.user.username,
            displayName: m.displayName,
            avatar: m.user.displayAvatarURL({ size: 32 }),
            joinedTimestamp: m.joinedTimestamp,
        })).slice(0, 25);
        res.json(members);
    });

    // ── Webhook Management ──
    app.get('/api/server/:id/webhooks', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can manage webhooks' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const webhooks = await guild.fetchWebhooks();
            res.json(webhooks.map(w => ({
                id: w.id,
                name: w.name,
                avatar: w.avatarURL({ size: 64 }) || null,
                channelId: w.channelId,
                channelName: guild.channels.cache.get(w.channelId)?.name || 'Unknown',
                type: w.type,
                owner: w.owner ? w.owner.tag : 'Unknown',
                createdAt: w.createdTimestamp,
                url: w.url,
            })));
        } catch (err) {
            logError(err, 'dashboard', 'webhooks_fetch');
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/webhooks', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can create webhooks' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { name, channelId, avatar } = req.body;
        if (!name || !channelId) return res.status(400).json({ error: 'Missing name or channelId' });
        const channel = guild.channels.cache.get(channelId);
        if (!channel || !channel.isTextBased()) return res.status(400).json({ error: 'Invalid channel' });
        try {
            const webhook = await channel.createWebhook({ name: sanitizeName(name), avatar });
            res.json({ success: true, webhook: { id: webhook.id, name: webhook.name, url: webhook.url } });
        } catch (err) {
            logError(err, 'dashboard', 'webhook_create');
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/server/:id/webhooks/:webhookId', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can delete webhooks' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const webhook = await guild.fetchWebhook(req.params.webhookId);
            if (!webhook) return res.status(404).json({ error: 'Webhook not found' });
            await webhook.delete();
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'webhook_delete');
            res.status(500).json({ error: err.message });
        }
    });

    // ── Invite Stats API ──
    app.get('/api/server/:id/invites', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { getTopInviters } = require('../../invites');
        const top = getTopInviters(guild.id, 10);
        res.json(top.map(r => ({
            inviterId: r.inviter_id,
            count: r.count,
            tag: guild.members.cache.get(r.inviter_id)?.user?.tag || r.inviter_id,
        })));
    });

    // ── Server Detail ──
    app.get('/api/server/:id', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const guildConfig = getGuildConfig(guild.id) || {};
        const logConfig = guildConfig.logChannels || {};
        const logCats = guildConfig.logCategories || {};
        const tracked = guildConfig.trackedChannels || [];
        const gStats = getGuildStats(guild.id);
        res.json({
            id: guild.id, name: guild.name,
            icon: guild.iconURL({ size: 128 }) || '',
            memberCount: guild.memberCount,
            boostTier: guild.premiumTier,
            boostCount: guild.premiumSubscriptionCount || 0,
            created: guild.createdTimestamp,
            roles: guild.roles.cache.size,
            channels: {
                text: guild.channels.cache.filter(c => c.type === 0).size,
                voice: guild.channels.cache.filter(c => c.type === 2).size,
                categories: guild.channels.cache.filter(c => c.type === 4).size,
                forums: guild.channels.cache.filter(c => c.type === 15).size,
            },
            prefix: guildConfig.prefix || ';',
            embedColor: guildConfig.embedColor !== null && guildConfig.embedColor !== undefined
                ? intToHexString(guildConfig.embedColor)
                : null,
            logging: {
                defaultChannel: guildConfig.logChannelId || null,
                perCategory: Object.fromEntries(LOG_CATEGORIES.map(c => [c, {
                    channel: logConfig[c] || null,
                    enabled: logCats[c] !== false,
                }])),
                trackedChannels: tracked,
            },
            stats: {
                totalJoins: gStats.totalJoins || 0,
                totalLeaves: gStats.totalLeaves || 0,
                snapshots: (gStats.dailySnapshots || []).slice(-30),
            },
            reactionRoles: getReactionRoles(guild.id),
            permissions: getAllPermissions(guild.id),
            ownerId: guild.ownerId,
            raidMode: require('../../raidMode').getRaidConfig(guild.id),
            modDm: getModDmConfig(guild.id),
        });
    });

    // ── Member Lookup (Moderation section) ──
    app.get('/api/server/:id/members/search', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const q = (req.query.q || '').trim().toLowerCase();
        if (!q) return res.json({ members: [] });
        const members = [];
        for (const m of guild.members.cache.values()) {
            const tag = (m.user ? m.user.tag : '').toLowerCase();
            const name = (m.displayName || '').toLowerCase();
            if (m.id === q || tag.includes(q) || name.includes(q)) {
                members.push({
                    id: m.id,
                    tag: m.user ? m.user.tag : m.id,
                    displayName: m.displayName || (m.user ? m.user.username : ''),
                    avatar: m.user ? m.user.displayAvatarURL({ size: 64 }) : null,
                    isBot: !!(m.user && m.user.bot),
                    joinedAt: m.joinedTimestamp || null,
                });
                if (members.length >= 8) break;
            }
        }
        res.json({ members });
    });

    app.get('/api/server/:id/member/:userId/profile', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const userId = req.params.userId;
            const m = guild.members.cache.get(userId);
            const member = m ? {
                id: m.id,
                tag: m.user ? m.user.tag : m.id,
                displayName: m.displayName || (m.user ? m.user.username : ''),
                avatar: m.user ? m.user.displayAvatarURL({ size: 128 }) : null,
                isBot: !!(m.user && m.user.bot),
                joinedAt: m.joinedTimestamp || null,
                roles: m.roles ? m.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name, color: r.hexColor })).slice(0, 12) : [],
            } : null;
            // The member file reads every system once (src/memberFile.js) and
            // the three legacy fields below are the very lists it composed, so
            // this route cannot drift from the /memberfile view. The case limit
            // is the 30 this route has always sent, which keeps `cases`
            // byte-identical while `memberFile` adds the merged timeline and the
            // per-system summaries on top.
            const memberFile = getMemberFile(guild.id, userId, { limit: 30 });
            const invitations = getInviterStats(guild.id, userId);
            res.json({
                member,
                warnings: memberFile.sections.warnings,
                notes: memberFile.sections.notes,
                cases: memberFile.sections.cases,
                invites: invitations,
                memberFile,
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });
}

module.exports = { register };

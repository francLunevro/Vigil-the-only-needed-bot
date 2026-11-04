// ──────────────────── Part 05: Moderation ────────────────────
// Mod actions (warn/kick/ban/timeout), staff notes, warning thresholds,
// ban appeals, moderation stats, message search, and the unified audit
// log feed.

const { getDb, recordAuditTrail } = require('../../db');
const { getThresholds, addThreshold, removeThreshold, DEFAULT_ACTIONS } = require('../../warningThresholds');
const { createBanAppeal, getBanAppeal, getBanAppeals, updateBanAppealStatus, deleteBanAppeal, getBanAppealCount } = require('../../banAppeals');
const { getReports, getReport, updateReportStatus, deleteReport, getReportCount } = require('../../reports');
const { getCases } = require('../../modCases');
const { sendLog, modActionLogEmbed, userStatsValue } = require('../../logging');
const { logError } = require('../../logError');
const { sanitizeForDB, formatDuration } = require('../../helpers');
const { sendPunishmentDm } = require('../../modDm');
const { getClient } = require('../core');
const tempRoles = require('../../tempRoles');

function register(app, ctx) {
    const { requireAuth, checkOwner, getSessionUser } = ctx;

    // ── Mod Actions API ──
    app.post('/api/server/:id/mod/warn', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can perform mod actions' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { userId, reason } = req.body;
        if (!userId || !reason) return res.status(400).json({ error: 'Missing userId or reason' });
        const safeReason = sanitizeForDB(reason).slice(0, 1000);

        try {
            const { addWarning } = require('../../warnings');
            const { createCase } = require('../../modCases');
            const sessionUser = getSessionUser(req);
            const warnings = addWarning(guild.id, userId, 'Dashboard (' + sessionUser + ')', safeReason);
            const modCase = createCase(guild.id, userId, sessionUser, 'Dashboard', 'warn', safeReason);
            // The reason is user-authored text: it reaches Discord's own reason
            // field, never the audit row, which carries ids and counts only.
            recordAuditTrail({ type: 'mod', userId: sessionUser, guildId: guild.id, action: 'mod.warn', details: { targetUserId: String(userId), warnings: warnings.length } });
            // Same receipt the Discord command sends, from the same helper, so
            // the two surfaces can't drift.
            await sendPunishmentDm({
                guild, userId, action: 'warn', reason: safeReason,
                caseNumber: modCase ? modCase.case_number : null,
            });
            res.json({ success: true, warningCount: warnings.length });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/mod/kick', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can perform mod actions' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { userId, reason } = req.body;
        if (!userId || !reason) return res.status(400).json({ error: 'Missing userId or reason' });
        const safeReason = sanitizeForDB(reason).slice(0, 1000);

        try {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) return res.status(404).json({ error: 'Member not found in this server' });
            if (!member.kickable) return res.status(403).json({ error: 'Cannot kick this user - role hierarchy prevents it' });

            await member.kick('[Dashboard] ' + safeReason);
            const { createCase } = require('../../modCases');
            const sessionUser = getSessionUser(req);
            const modCase = createCase(guild.id, userId, sessionUser, 'Dashboard', 'kick', safeReason);
            recordAuditTrail({ type: 'mod', userId: sessionUser, guildId: guild.id, action: 'mod.kick', details: { targetUserId: String(userId) } });
            await sendPunishmentDm({
                guild, user: member.user, userId, action: 'kick', reason: safeReason,
                caseNumber: modCase ? modCase.case_number : null,
            });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/mod/ban', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can perform mod actions' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { userId, reason, deleteMessages } = req.body;
        if (!userId || !reason) return res.status(400).json({ error: 'Missing userId or reason' });
        const safeReason = sanitizeForDB(reason).slice(0, 1000);

        try {
            const deleteSeconds = deleteMessages === '24hours' ? 86400 : (deleteMessages === '6hours' ? 21600 : (deleteMessages === 'hour' ? 3600 : 0));
            await guild.bans.create(userId, { reason: '[Dashboard] ' + safeReason, deleteMessageSeconds: deleteSeconds });
            const { createCase } = require('../../modCases');
            const sessionUser = getSessionUser(req);
            const modCase = createCase(guild.id, userId, sessionUser, 'Dashboard', 'ban', safeReason);
            recordAuditTrail({ type: 'mod', userId: sessionUser, guildId: guild.id, action: 'mod.ban', details: { targetUserId: String(userId) } });
            await sendPunishmentDm({
                guild, userId, action: 'ban', reason: safeReason,
                caseNumber: modCase ? modCase.case_number : null,
            });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/mod/timeout', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can perform mod actions' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { userId, duration, reason } = req.body;
        if (!userId || !duration || !reason) return res.status(400).json({ error: 'Missing userId, duration, or reason' });
        const safeReason = sanitizeForDB(reason).slice(0, 1000);

        try {
            const member = await guild.members.fetch(userId).catch(() => null);
            if (!member) return res.status(404).json({ error: 'Member not found in this server' });
            if (!member.moderatable) return res.status(403).json({ error: 'Cannot timeout this user' });

            const durationMap = { '60s': 60000, '5m': 300000, '10m': 600000, '1h': 3600000, '6h': 21600000, '24h': 86400000, '3d': 259200000, '7d': 604800000 };
            // Accept a named key ('10m', '1h', ...) or a raw number of minutes (the dashboard sends minutes)
            const minutes = typeof duration === 'number' ? duration : parseInt(duration, 10);
            const ms = durationMap[duration] || (Number.isInteger(minutes) && minutes > 0 ? minutes * 60000 : null);
            if (!ms) return res.status(400).json({ error: 'Invalid duration' });
            // Discord caps timeout length at 28 days
            if (ms > 28 * 24 * 60 * 60000) return res.status(400).json({ error: 'Timeout cannot exceed 28 days' });

            await member.timeout(ms, '[Dashboard] ' + safeReason);
            const { createCase } = require('../../modCases');
            const sessionUser = getSessionUser(req);
            const modCase = createCase(guild.id, userId, sessionUser, 'Dashboard', 'timeout', safeReason);
            recordAuditTrail({ type: 'mod', userId: sessionUser, guildId: guild.id, action: 'mod.timeout', details: { targetUserId: String(userId), durationMs: ms } });
            await sendPunishmentDm({
                guild, user: member.user, userId, action: 'timeout', reason: safeReason,
                caseNumber: modCase ? modCase.case_number : null,
                durationLabel: formatDuration(ms),
                expiresAt: Date.now() + ms,
            });
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Temporary Roles API ──
    // The grant/revoke routes are owner-only, same as every other mod action.
    app.get('/api/server/:id/temp-roles', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const roles = guild.roles.cache
                .filter(r => r.name !== '@everyone' && !r.managed)
                .sort((a, b) => b.position - a.position)
                .map(r => ({ id: r.id, name: r.name }));
            res.json({ entries: tempRoles.listTempRoles(guild.id), roles });
        } catch (err) {
            logError(err, 'dashboard', 'temp_roles_list');
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/temp-roles', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can perform mod actions' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { userId, roleId, durationMs, reason } = req.body || {};
        if (!userId || !roleId || !durationMs) return res.status(400).json({ error: 'Missing userId, roleId or durationMs' });
        const role = guild.roles.cache.get(String(roleId));
        try {
            const sessionUser = getSessionUser(req);
            const result = await tempRoles.grantTempRole({
                guild, role, userId: String(userId), durationMs: Number(durationMs), grantedBy: sessionUser,
            });
            if (result.error) return res.status(400).json({ error: result.error });
            const { createCase } = require('../../modCases');
            createCase(guild.id, String(userId), sessionUser, 'Dashboard', 'temprole',
                (role ? role.name : roleId) + ' until ' + new Date(result.entry.expiresAt).toISOString() +
                (reason ? ' — ' + sanitizeForDB(reason).slice(0, 500) : ''));
            res.json({ success: true, entry: result.entry, extended: result.extended });
        } catch (err) {
            logError(err, 'dashboard', 'temp_role_grant');
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/server/:id/temp-roles', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        if (!checkOwner(req)) return res.status(403).json({ error: 'Only the bot owner can perform mod actions' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { userId, roleId } = req.body || {};
        if (!userId || !roleId) return res.status(400).json({ error: 'Missing userId or roleId' });
        try {
            const result = await tempRoles.revokeTempRole({
                guild, userId: String(userId), roleId: String(roleId), reason: 'Removed from dashboard by ' + getSessionUser(req),
            });
            if (result.error) return res.status(400).json({ error: result.error });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'temp_role_revoke');
            res.status(500).json({ error: err.message });
        }
    });

    // ── Staff Notes API ──
    app.get('/api/server/:id/notes', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { getNotesForUser, getGuildNotesForDashboard } = require('../../staffNotes');
        // ?userId= filters to a specific user (dashboard search); otherwise return recent guild notes
        const userId = req.query.userId || null;
        const notes = userId ? getNotesForUser(guild.id, userId) : getGuildNotesForDashboard(guild.id);
        res.json({ notes: notes.map(n => ({
            id: n.id,
            targetUserId: n.target_user_id,
            targetTag: guild.members.cache.get(n.target_user_id)?.user?.tag || n.target_user_id,
            authorTag: n.author_tag,
            note: n.note,
            createdAt: n.created_at,
            updatedAt: n.updated_at,
        })) });
    });

    app.post('/api/server/:id/notes', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { targetUserId, note } = req.body;
        if (!targetUserId || !note) return res.status(400).json({ error: 'Missing targetUserId or note' });
        const safeNote = sanitizeForDB(note).slice(0, 2000);
        const { addNote } = require('../../staffNotes');
        const created = addNote(guild.id, targetUserId, getSessionUser(req), 'Dashboard', safeNote);
        res.json({ success: true, note: created });
    });

    app.delete('/api/server/:id/notes/:noteId', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const { removeNote } = require('../../staffNotes');
        const removed = removeNote(req.params.id, req.params.noteId);
        if (!removed) return res.status(404).json({ error: 'Note not found' });
        res.json({ success: true });
    });

    // ── Warning Thresholds API ──
    app.get('/api/server/:id/warning-thresholds', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const thresholds = getThresholds(guild.id);
            res.json({ thresholds });
        } catch { res.json({ thresholds: [] }); }
    });

    app.post('/api/server/:id/warning-thresholds', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { warnCount, action, duration } = req.body;
        if (!warnCount || !action) return res.status(400).json({ error: 'Missing warnCount or action' });
        if (!DEFAULT_ACTIONS.includes(action)) return res.status(400).json({ error: 'Invalid action' });
        if (warnCount <= 0) return res.status(400).json({ error: 'warnCount must be positive' });
        try {
            const result = addThreshold(guild.id, warnCount, action, duration || null);
            res.json({ success: true, thresholds: result });
        } catch (err) {
            logError(err, 'dashboard', 'warning_thresholds_add');
            res.status(500).json({ error: err.message });
        }
    });

    app.delete('/api/server/:id/warning-thresholds', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { warnCount } = req.body;
        if (!warnCount) return res.status(400).json({ error: 'Missing warnCount' });
        try {
            const result = removeThreshold(guild.id, warnCount);
            res.json({ success: true, thresholds: result });
        } catch (err) {
            logError(err, 'dashboard', 'warning_thresholds_remove');
            res.status(500).json({ error: err.message });
        }
    });

    // ── Ban Appeals API ──
    app.get('/api/server/:id/ban-appeals', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const status = req.query.status || null;
        try {
            const appeals = getBanAppeals(guild.id, status);
            res.json({ appeals });
        } catch { res.json({ appeals: [] }); }
    });

    app.get('/api/server/:id/ban-appeals/stats', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const stats = {
                pending: getBanAppealCount(guild.id, 'pending'),
                approved: getBanAppealCount(guild.id, 'approved'),
                denied: getBanAppealCount(guild.id, 'denied'),
                total: getBanAppealCount(guild.id),
            };
            res.json(stats);
        } catch { res.json({ pending: 0, approved: 0, denied: 0, total: 0 }); }
    });

    app.post('/api/server/:id/ban-appeals', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { userId, userTag, reason, message } = req.body;
        if (!userId || !userTag || !reason || !message) return res.status(400).json({ error: 'Missing required fields' });
        try {
            const appeal = createBanAppeal(guild.id, userId, userTag, reason, message);
            res.json({ success: true, appeal });
        } catch (err) {
            logError(err, 'dashboard', 'ban_appeal_create');
            res.status(500).json({ error: err.message });
        }
    });

    app.put('/api/server/:id/ban-appeals/:appealId', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { status, reviewNote } = req.body;
        if (!['pending', 'approved', 'denied'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
        try {
            const appeal = getBanAppeal(guild.id, req.params.appealId);
            if (!appeal) {
                return res.status(404).json({ error: 'Appeal not found' });
            }
            const result = updateBanAppealStatus(guild.id, req.params.appealId, status, getSessionUser(req), reviewNote);
            if (!result) return res.status(404).json({ error: 'Appeal not found' });
            recordAuditTrail({ type: 'staff', userId: getSessionUser(req), guildId: guild.id, action: 'appeal.review', details: { id: req.params.appealId, status } });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'ban_appeal_update');
            res.status(500).json({ error: 'Could not complete request' });
        }
    });

    app.delete('/api/server/:id/ban-appeals/:appealId', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const appeal = getBanAppeal(guild.id, req.params.appealId);
            if (!appeal) {
                return res.status(404).json({ error: 'Appeal not found' });
            }
            const result = deleteBanAppeal(guild.id, req.params.appealId);
            if (!result) return res.status(404).json({ error: 'Appeal not found' });
            recordAuditTrail({ type: 'staff', userId: getSessionUser(req), guildId: guild.id, action: 'appeal.delete', details: { id: req.params.appealId } });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'ban_appeal_delete');
            res.status(500).json({ error: 'Could not complete request' });
        }
    });

    // ── Member Reports API ──
    app.get('/api/server/:id/reports', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const status = req.query.status || null;
        try {
            const reports = getReports(guild.id, status);
            res.json({ reports });
        } catch { res.json({ reports: [] }); }
    });

    app.get('/api/server/:id/reports/stats', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const stats = {
                pending: getReportCount(guild.id, 'pending'),
                approved: getReportCount(guild.id, 'approved'),
                dismissed: getReportCount(guild.id, 'dismissed'),
                total: getReportCount(guild.id),
            };
            res.json(stats);
        } catch { res.json({ pending: 0, approved: 0, dismissed: 0, total: 0 }); }
    });

    app.put('/api/server/:id/reports/:reportId', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const { status, reviewNote, caseId } = req.body;
        if (!['pending', 'approved', 'dismissed'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
        try {
            const report = getReport(guild.id, req.params.reportId);
            if (!report) {
                return res.status(404).json({ error: 'Report not found' });
            }
            if (caseId !== undefined && caseId !== null && (typeof caseId !== 'string' ||
                !getDb().prepare('SELECT 1 FROM mod_cases WHERE guild_id = ? AND id = ?').get(guild.id, caseId))) {
                return res.status(404).json({ error: 'Case not found' });
            }
            const result = updateReportStatus(guild.id, req.params.reportId, status, getSessionUser(req), reviewNote, caseId);
            if (!result) return res.status(404).json({ error: 'Report not found' });
            // Wick-style log entry announcing the review outcome (best-effort).
            // Sent before the response so a failure here can still answer 500 —
            // answering first and logging after left the outer catch writing
            // headers that had already gone out.
            try {
                const approved = status === 'approved';
                const target = await client.users.fetch(report.target_id).catch(() => null);
                const member = await guild.members.fetch(report.target_id).catch(() => null);
                const lastCase = getCases(guild.id, report.target_id, 1)[0] || null;
                const embed = modActionLogEmbed({
                    title: approved ? '✅ Report accepted' : '🔕 Report dismissed',
                    color: approved ? 0x2ECC71 : 0x95A5A6,
                    target,
                    footerText: getSessionUser(req) + (approved ? ' accepted this report' : ' dismissed this report'),
                    fields: [
                        { name: 'User', value: userStatsValue({ user: target, member, lastCase }) },
                        { name: 'Reason(s)', value: (report.reason || '—').slice(0, 1000) },
                        ...(report.message_content ? [{ name: 'Highlighted message(s)', value: report.message_content.slice(0, 1000) }] : []),
                        { name: 'Reported by', value: report.reporter_tag + ' (<@' + report.reporter_id + '>)' },
                    ],
                });
                await sendLog(embed, 'moderation', null, guild.id);
            } catch (logErr) {
                logError(logErr, 'dashboard', 'report_update_log');
            }
            recordAuditTrail({ type: 'staff', userId: getSessionUser(req), guildId: guild.id, action: 'report.review', details: { id: req.params.reportId, status } });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'report_update');
            res.status(500).json({ error: 'Could not complete request' });
        }
    });

    app.delete('/api/server/:id/reports/:reportId', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const report = getReport(guild.id, req.params.reportId);
            if (!report) {
                return res.status(404).json({ error: 'Report not found' });
            }
            const result = deleteReport(guild.id, req.params.reportId);
            if (!result) return res.status(404).json({ error: 'Report not found' });
            recordAuditTrail({ type: 'staff', userId: getSessionUser(req), guildId: guild.id, action: 'report.delete', details: { id: req.params.reportId } });
            res.json({ success: true });
        } catch (err) {
            logError(err, 'dashboard', 'report_delete');
            res.status(500).json({ error: 'Could not complete request' });
        }
    });

    // ── Server Insights: Moderation Stats ──
    app.get('/api/server/:id/modstats', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const db = getDb();
            const totalCases = db.prepare('SELECT COUNT(*) as total FROM mod_cases WHERE guild_id = ?').get(guild.id);
            const activeCases = db.prepare('SELECT COUNT(*) as total FROM mod_cases WHERE guild_id = ? AND active = 1').get(guild.id);
            const byType = db.prepare('SELECT action_type, COUNT(*) as count FROM mod_cases WHERE guild_id = ? GROUP BY action_type ORDER BY count DESC').all(guild.id);
            const recent = db.prepare('SELECT * FROM mod_cases WHERE guild_id = ? ORDER BY created_at DESC LIMIT 15').all(guild.id);
            const topWarned = db.prepare('SELECT user_id, COUNT(*) as count FROM mod_cases WHERE guild_id = ? AND action_type = \'warn\' GROUP BY user_id ORDER BY count DESC LIMIT 5').all(guild.id);
            res.json({
                total: totalCases?.total || 0,
                active: activeCases?.total || 0,
                byType: byType.map(t => ({ action: t.action_type, count: t.count })),
                recent: recent.map(c => ({
                    id: c.id,
                    caseNumber: c.case_number,
                    userId: c.user_id,
                    moderatorTag: c.moderator_tag,
                    actionType: c.action_type,
                    reason: c.reason?.slice(0, 100) || '',
                    active: !!c.active,
                    createdAt: c.created_at,
                })),
                topWarned: topWarned.map(u => ({ userId: u.user_id, count: u.count, tag: guild.members.cache.get(u.user_id)?.user?.tag || u.user_id })),
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── Message Search ──
    app.get('/api/server/:id/messages', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        const action = req.query.action || null;
        const search = req.query.q || null;
        let rows;
        if (search) {
            rows = db.prepare('SELECT * FROM message_log WHERE guild_id = ? AND content LIKE ? ORDER BY logged_at DESC LIMIT ?').all(guild.id, '%' + search + '%', limit);
        } else if (action) {
            rows = db.prepare('SELECT * FROM message_log WHERE guild_id = ? AND action = ? ORDER BY logged_at DESC LIMIT ?').all(guild.id, action, limit);
        } else {
            rows = db.prepare('SELECT * FROM message_log WHERE guild_id = ? ORDER BY logged_at DESC LIMIT ?').all(guild.id, limit);
        }
        res.json(rows.map(r => ({
            id: r.id,
            messageId: r.message_id,
            channelId: r.channel_id,
            channelName: guild.channels.cache.get(r.channel_id)?.name || r.channel_id,
            authorId: r.author_id,
            authorTag: r.author_tag,
            content: r.content,
            action: r.action,
            attachments: r.attachments ? JSON.parse(r.attachments) : null,
            loggedAt: r.logged_at,
        })));
    });

    // ── Message Log CSV Export ──
    app.get('/api/server/:id/messages/export', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit) || 1000, 5000);
        const search = req.query.q || null;
        const action = req.query.action || null;
        const channel = req.query.channel || null;
        const userId = req.query.userId || null;

        const clauses = ['guild_id = ?'];
        const params = [guild.id];
        if (search) { clauses.push('content LIKE ?'); params.push('%' + search + '%'); }
        if (action) { clauses.push('action = ?'); params.push(action); }
        if (channel) { clauses.push('channel_id = ?'); params.push(channel); }
        if (userId) { clauses.push('author_id = ?'); params.push(userId); }

        let rows;
        try {
            rows = db.prepare('SELECT * FROM message_log WHERE ' + clauses.join(' AND ') + ' ORDER BY logged_at DESC LIMIT ?').all(...params, limit);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }

        const csv = messageLogToCsv(rows, guild);
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="message-log-' + guild.id + '-' + stamp + '.csv"');
        res.send(csv);
    });

    // ── Raid / Lockdown Mode ──
    app.get('/api/server/:id/raidmode', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const raid = require('../../raidMode');
            res.json({ raidMode: raid.getRaidConfig(guild.id) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    app.post('/api/server/:id/raidmode', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        try {
            const raid = require('../../raidMode');
            const { enabled, durationMinutes, noticeChannel } = req.body;
            if (enabled === undefined) return res.status(400).json({ error: 'Missing enabled flag' });
            const cfg = enabled
                ? await raid.enableRaidMode(guild, { durationMinutes, noticeChannel })
                : await raid.disableRaidMode(guild);
            res.json({ success: true, raidMode: cfg });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Helper for audit log icons
    function getAuditIcon(action) {
        const iconMap = {
            MEMBER_KICK: '\uD83D\uDC22',
            MEMBER_BAN: '\uD83D\uDD28',
            MEMBER_UNBAN: '\uD83D\uDD13',
            MEMBER_UPDATE: '\uD83D\uDC64',
            MEMBER_ROLE_UPDATE: '\uD83D\uDCCB',
            MEMBER_MOVE: '\uD83D\uDCE6',
            MEMBER_DISCONNECT: '\u274C',
            CHANNEL_CREATE: '\u2795',
            CHANNEL_DELETE: '\u2796',
            CHANNEL_UPDATE: '\u270F\uFE0F',
            ROLE_CREATE: '\uD83C\uDFF7\uFE0F',
            ROLE_DELETE: '\u274C',
            ROLE_UPDATE: '\u270F\uFE0F',
            MESSAGE_DELETE: '\uD83D\uDDD1\uFE0F',
            MESSAGE_BULK_DELETE: '\uD83E\uDDF9',
            OVERWRITE_UPDATE: '\uD83D\uDD12',
            GUILD_UPDATE: '\u270F\uFE0F',
            EMOJI_CREATE: '\uD83D\uDE0E',
            EMOJI_DELETE: '\u274C',
            EMOJI_UPDATE: '\u270F\uFE0F',
            STAGE_INSTANCE_CREATE: '\uD83C\uDFAD',
            THREAD_CREATE: '\uD83E\uDD9C',
            THREAD_DELETE: '\u274C',
            WEBHOOK_CREATE: '\uD83D\uDD17',
            BOT_ADD: '\uD83E\uDD16',
        };
        return iconMap[action] || '\uD83D\uDD35';
    }

    // ── Audit Log (Unified Feed) ──
    app.get('/api/server/:id/auditlog', requireAuth, async (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });

        const db = getDb();
        const limit = Math.min(parseInt(req.query.limit) || 50, 100);
        const type = req.query.type || 'all';

        const entries = [];

        // 1. Discord's native audit log
        if (type === 'all' || type === 'discord') {
            try {
                const auditLog = await guild.fetchAuditLogs({ limit: 25 });
                for (const e of auditLog.entries) {
                    entries.push({
                        id: 'discord_' + e.id,
                        source: 'discord',
                        type: (function(ea){

                            if (ea === null || ea === undefined) return 'Audit Event';
                            // Discord.js v14 uses numeric enum values (e.g. 22 for MemberKick)
                            if(typeof ea === 'number'){
                                try {
                                    const name = require('discord.js').AuditLogEvent[ea];
                                    if(name) return name.replace(/([A-Z])/g, ' $1').trim();
                                } catch {}
                                return 'Audit Action ' + ea;
                            }
                            return String(ea).replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                        })(e.action),
                        icon: (function(ea){
                            if (ea === null || ea === undefined) return '\uD83D\uDD35';
                            if(typeof ea === 'number'){
                                try {
                                    const name = require('discord.js').AuditLogEvent[ea];
                                    if(name) {
                                        // Convert 'MemberKick' to 'MEMBER_KICK' for icon lookup
                                        const iconKey = name.replace(/([A-Z])/g, '_$1').toUpperCase().replace(/^_/, '');
                                        return getAuditIcon(iconKey);
                                    }
                                } catch {}
                            }
                            return getAuditIcon(ea);
                        })(e.action),
                        executorTag: e.executor?.tag || 'Unknown',
                        executorAvatar: e.executor?.displayAvatarURL({ size: 32 }) || null,
                        targetTag: e.target?.tag || e.target?.name || e.targetId || null,
                        reason: e.reason || null,
                        changes: e.changes?.slice(0, 3).map(c => ({ key: c.key, old: String(c.old ?? '').slice(0, 100), new: String(c.new ?? '').slice(0, 100) })) || [],
                        timestamp: e.createdTimestamp,
                    });
                }
            } catch {}
        }

        // 2. Bot's mod cases
        if (type === 'all' || type === 'moderation') {
            const cases = db.prepare('SELECT * FROM mod_cases WHERE guild_id = ? ORDER BY created_at DESC LIMIT ?').all(guild.id, Math.min(limit, 30));
            const actionIcons = { warn: '\u26A0\uFE0F', kick: '\uD83D\uDC22', ban: '\uD83D\uDD28', unban: '\uD83D\uDD13', timeout: '\u23F1\uFE0F', untimeout: '\u25B6\uFE0F', tempban: '\uD83D\uDD28', lock: '\uD83D\uDD12', unlock: '\uD83D\uDD13', purge: '\uD83E\uDDF9' };
            for (const c of cases) {
                entries.push({
                    id: 'case_' + c.id,
                    source: 'moderation',
                    type: c.action_type.charAt(0).toUpperCase() + c.action_type.slice(1),
                    icon: actionIcons[c.action_type] || '\uD83D\uDCCB',
                    executorTag: c.moderator_tag,
                    executorAvatar: null,
                    targetTag: '<@' + c.user_id + '>',
                    reason: c.reason || null,
                    changes: [{ key: 'Case #' + c.case_number, old: '', new: c.active ? 'Active' : 'Closed' }],
                    timestamp: c.created_at,
                });
            }
        }

        // 3. Message log (deleted/edited messages)
        if (type === 'all' || type === 'messages') {
            const msgs = db.prepare('SELECT * FROM message_log WHERE guild_id = ? ORDER BY logged_at DESC LIMIT ?').all(guild.id, Math.min(limit, 30));
            for (const m of msgs) {
                entries.push({
                    id: 'msg_' + m.id,
                    source: 'messages',
                    type: m.action === 'deleted' ? 'Message Deleted' : 'Message Edited',
                    icon: m.action === 'deleted' ? '\uD83D\uDDD1\uFE0F' : '\u270F\uFE0F',
                    executorTag: m.author_tag,
                    executorAvatar: null,
                    targetTag: guild.channels.cache.get(m.channel_id)?.name || m.channel_id,
                    reason: null,
                    changes: [{ key: 'Content', old: '', new: (m.content || '').slice(0, 200) }],
                    timestamp: m.logged_at,
                });
            }
        }

        // 4. Recent member activity from stats
        if (type === 'all' || type === 'members') {
            const { getGuildStats } = require('../../stats');
            const stats = getGuildStats(guild.id);
            const snapshots = stats.dailySnapshots || [];
            const recent = snapshots.slice(-14);
            for (const snap of recent) {
                if (snap.joins > 0) {
                    entries.push({
                        id: 'join_' + snap.date,
                        source: 'members',
                        type: 'Members Joined',
                        icon: '\uD83D\uDC65',
                        executorTag: 'System',
                        executorAvatar: null,
                        targetTag: null,
                        reason: null,
                        changes: [{ key: 'Count', old: '', new: String(snap.joins) }],
                        timestamp: new Date(snap.date).getTime(),
                    });
                }
                if (snap.leaves > 0) {
                    entries.push({
                        id: 'leave_' + snap.date,
                        source: 'members',
                        type: 'Members Left',
                        icon: '\uD83D\uDEAA',
                        executorTag: 'System',
                        executorAvatar: null,
                        targetTag: null,
                        reason: null,
                        changes: [{ key: 'Count', old: '', new: String(snap.leaves) }],
                        timestamp: new Date(snap.date).getTime(),
                    });
                }
            }
        }

        // Sort by timestamp descending, limit results
        entries.sort((a, b) => b.timestamp - a.timestamp);
        res.json(entries.slice(0, limit));
    });
}

// RFC 4180-style CSV escaping: wrap a field in quotes if it contains a comma,
// quote, or newline, and double any embedded quotes.
function csvEscape(value) {
    const s = value === null || value === undefined ? '' : String(value);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function messageLogToCsv(rows, guild) {
    const header = ['id', 'timestamp', 'channel', 'author_tag', 'author_id', 'action', 'content', 'attachments'];
    const lines = [header.join(',')];
    for (const r of rows) {
        const channelName = guild.channels.cache.get(r.channel_id)?.name || r.channel_id;
        let attachments = '';
        if (r.attachments) {
            try {
                const list = JSON.parse(r.attachments);
                attachments = Array.isArray(list) ? list.map(a => (typeof a === 'string' ? a : a.url || '')).join(' ') : String(list);
            } catch { attachments = String(r.attachments); }
        }
        const cells = [
            r.id,
            new Date(r.logged_at).toISOString(),
            channelName,
            r.author_tag,
            r.author_id,
            r.action,
            r.content,
            attachments,
        ];
        lines.push(cells.map(csvEscape).join(','));
    }
    return lines.join('\r\n') + '\r\n';
}

module.exports = { register };

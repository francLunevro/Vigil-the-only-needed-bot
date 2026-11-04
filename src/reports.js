const { getDb } = require('./db');

// ─── Member Reports Module ───
// Members report others; staff review pending reports in the dashboard and
// either approve or dismiss them. A review records the decision, the reviewer
// and an optional note — and, when the dashboard passes one, the mod case that
// was opened for it. It does not open a case on its own.

const VALID_STATUSES = ['pending', 'approved', 'dismissed'];

function createReport(guildId, reporterId, reporterTag, targetId, targetTag, reason, messageContent = null, messageId = null) {
    const db = getDb();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    db.prepare('INSERT INTO reports (id, guild_id, reporter_id, reporter_tag, target_id, target_tag, reason, message_content, message_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, guildId, reporterId, reporterTag, targetId, targetTag, reason, messageContent, messageId, 'pending', now);
    return getReport(guildId, id);
}

function getReport(guildId, reportId) {
    const db = getDb();
    return db.prepare('SELECT * FROM reports WHERE guild_id = ? AND id = ?').get(guildId, reportId);
}

function getReports(guildId, status = null) {
    const db = getDb();
    if (status) {
        return db.prepare('SELECT * FROM reports WHERE guild_id = ? AND status = ? ORDER BY created_at DESC').all(guildId, status);
    }
    return db.prepare('SELECT * FROM reports WHERE guild_id = ? ORDER BY created_at DESC').all(guildId);
}

// Reports filed against one member — the member file's view (src/memberFile.js).
// Guild-scoped like every other accessor here, so an id from another server
// matches nothing.
function getReportsForTarget(guildId, targetId, limit = 25) {
    const db = getDb();
    const safeLimit = Math.min(limit || 25, 100);
    return db.prepare('SELECT * FROM reports WHERE guild_id = ? AND target_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(guildId, targetId, safeLimit);
}

function updateReportStatus(guildId, reportId, newStatus, reviewedBy = null, reviewNote = null, caseId = null) {
    if (!VALID_STATUSES.includes(newStatus)) {
        throw new Error('Invalid status');
    }
    const db = getDb();
    let query = 'UPDATE reports SET status = ?';
    const params = [newStatus];
    if (reviewedBy) {
        query += ', reviewed_by = ?, reviewed_at = ?';
        params.push(reviewedBy, Date.now());
    }
    if (reviewNote) {
        query += ', review_note = ?';
        params.push(reviewNote);
    }
    if (caseId) {
        query += ', case_id = ?';
        params.push(caseId);
    }
    query += ' WHERE guild_id = ? AND id = ?';
    params.push(guildId, reportId);
    if (caseId) {
        query += ' AND EXISTS (SELECT 1 FROM mod_cases WHERE guild_id = ? AND id = ?)';
        params.push(guildId, caseId);
    }
    const result = db.prepare(query).run(...params);
    return result.changes > 0;
}

function deleteReport(guildId, reportId) {
    const db = getDb();
    const result = db.prepare('DELETE FROM reports WHERE guild_id = ? AND id = ?').run(guildId, reportId);
    return result.changes > 0;
}

function getReportCount(guildId, status = null) {
    const db = getDb();
    if (status) {
        const row = db.prepare('SELECT COUNT(*) as count FROM reports WHERE guild_id = ? AND status = ?').get(guildId, status);
        return row ? row.count : 0;
    }
    const row = db.prepare('SELECT COUNT(*) as count FROM reports WHERE guild_id = ?').get(guildId);
    return row ? row.count : 0;
}

module.exports = {
    createReport,
    getReport,
    getReports,
    getReportsForTarget,
    updateReportStatus,
    deleteReport,
    getReportCount,
};
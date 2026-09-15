const { getDb } = require('./db');

// ─── Member Reports Module ───
// Members report others; staff review pending reports in the dashboard and
// either approve (opening a mod case) or dismiss them.

const VALID_STATUSES = ['pending', 'approved', 'dismissed'];

function createReport(guildId, reporterId, reporterTag, targetId, targetTag, reason, messageContent = null, messageId = null) {
    const db = getDb();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const now = Date.now();
    db.prepare('INSERT INTO reports (id, guild_id, reporter_id, reporter_tag, target_id, target_tag, reason, message_content, message_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, guildId, reporterId, reporterTag, targetId, targetTag, reason, messageContent, messageId, 'pending', now);
    return getReport(id);
}

function getReport(reportId) {
    const db = getDb();
    return db.prepare('SELECT * FROM reports WHERE id = ?').get(reportId);
}

function getReports(guildId, status = null) {
    const db = getDb();
    if (status) {
        return db.prepare('SELECT * FROM reports WHERE guild_id = ? AND status = ? ORDER BY created_at DESC').all(guildId, status);
    }
    return db.prepare('SELECT * FROM reports WHERE guild_id = ? ORDER BY created_at DESC').all(guildId);
}

function updateReportStatus(reportId, newStatus, reviewedBy = null, reviewNote = null, caseId = null) {
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
    query += ' WHERE id = ?';
    params.push(reportId);
    const result = db.prepare(query).run(...params);
    return result.changes > 0;
}

function deleteReport(reportId) {
    const db = getDb();
    const result = db.prepare('DELETE FROM reports WHERE id = ?').run(reportId);
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
    updateReportStatus,
    deleteReport,
    getReportCount,
};
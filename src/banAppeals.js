const { getDb } = require('./db');

// ─── Ban Appeals Module ───

function createBanAppeal(guildId, userId, userTag, reason, message) {
    const db = getDb();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const now = Date.now();

    db.prepare('INSERT INTO ban_appeals (id, guild_id, user_id, user_tag, reason, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, guildId, userId, userTag, reason, message, 'pending', now);

    return getBanAppeal(guildId, id);
}

function getBanAppeal(guildId, appealId) {
    const db = getDb();
    return db.prepare('SELECT * FROM ban_appeals WHERE guild_id = ? AND id = ?').get(guildId, appealId);
}

function getBanAppeals(guildId, status = null) {
    const db = getDb();
    if (status) {
        return db.prepare('SELECT * FROM ban_appeals WHERE guild_id = ? AND status = ? ORDER BY created_at DESC').all(guildId, status);
    }
    return db.prepare('SELECT * FROM ban_appeals WHERE guild_id = ? ORDER BY created_at DESC').all(guildId);
}

// One member's appeals — the member file's view (src/memberFile.js), newest
// first. Guild-scoped like getBanAppeals, so another server's id matches
// nothing.
function getBanAppealsForUser(guildId, userId, limit = 25) {
    const db = getDb();
    const safeLimit = Math.min(limit || 25, 100);
    return db.prepare('SELECT * FROM ban_appeals WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(guildId, userId, safeLimit);
}

function updateBanAppealStatus(guildId, appealId, newStatus, reviewedBy = null, reviewNote = null) {
    const db = getDb();
    const validStatuses = ['pending', 'approved', 'denied'];
    if (!validStatuses.includes(newStatus)) {
        throw new Error('Invalid status');
    }

    let query = 'UPDATE ban_appeals SET status = ?';
    const params = [newStatus];

    if (reviewedBy) {
        query += ', reviewed_by = ?, reviewed_at = ?';
        params.push(reviewedBy, Date.now());
    }
    if (reviewNote) {
        query += ', review_note = ?';
        params.push(reviewNote);
    }

    query += ' WHERE guild_id = ? AND id = ?';
    params.push(guildId, appealId);

    const result = db.prepare(query).run(...params);
    return result.changes > 0;
}

function deleteBanAppeal(guildId, appealId) {
    const db = getDb();
    const result = db.prepare('DELETE FROM ban_appeals WHERE guild_id = ? AND id = ?').run(guildId, appealId);
    return result.changes > 0;
}

function getBanAppealCount(guildId, status = null) {
    const db = getDb();
    if (status) {
        const row = db.prepare('SELECT COUNT(*) as count FROM ban_appeals WHERE guild_id = ? AND status = ?').get(guildId, status);
        return row ? row.count : 0;
    }
    const row = db.prepare('SELECT COUNT(*) as count FROM ban_appeals WHERE guild_id = ?').get(guildId);
    return row ? row.count : 0;
}

module.exports = {
    createBanAppeal,
    getBanAppeal,
    getBanAppeals,
    getBanAppealsForUser,
    updateBanAppealStatus,
    deleteBanAppeal,
    getBanAppealCount,
};
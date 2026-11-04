const { getDb } = require('./db');

// ──────────────────── Role Menu CRUD ────────────────────

// Discord message IDs are global. Fail closed on ambiguous legacy rows.
function getRoleMenu(guildId, messageId) {
    return getDb().prepare(`
        SELECT * FROM role_menus WHERE guild_id = ? AND message_id = ?
        AND NOT EXISTS (SELECT 1 FROM role_menus other WHERE other.message_id = role_menus.message_id
            AND other.guild_id <> role_menus.guild_id)
    `).get(guildId, messageId);
}

function createRoleMenu(guildId, messageId, channelId, title) {
    const db = getDb();
    return db.prepare(`
        INSERT OR REPLACE INTO role_menus (guild_id, message_id, channel_id, title, created_at)
        SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (
            SELECT 1 FROM role_menus WHERE message_id = ? AND guild_id <> ?
        )
    `).run(guildId, messageId, channelId, title || null, Date.now(), messageId, guildId).changes > 0;
}

function getRoleMenus(guildId) {
    return getDb().prepare('SELECT * FROM role_menus WHERE guild_id = ? ORDER BY created_at DESC').all(guildId);
}

function removeRoleMenu(guildId, messageId) {
    const db = getDb();
    return db.transaction(() => {
        if (!getRoleMenu(guildId, messageId)) return false;
        db.prepare('DELETE FROM role_menu_options WHERE message_id = ?').run(messageId);
        return db.prepare('DELETE FROM role_menus WHERE guild_id = ? AND message_id = ?').run(guildId, messageId).changes > 0;
    }).immediate();
}

function addRoleMenuOption(guildId, messageId, roleId, label, emoji, description) {
    const db = getDb();
    return db.transaction(() => {
        if (!getRoleMenu(guildId, messageId)) return false;
        const { nextOrder } = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS nextOrder FROM role_menu_options WHERE message_id = ?').get(messageId);
        db.prepare('INSERT OR REPLACE INTO role_menu_options (message_id, role_id, label, emoji, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)')
            .run(messageId, roleId, label, emoji || null, description || null, nextOrder);
        return true;
    }).immediate();
}

function getRoleMenuOptions(guildId, messageId) {
    return getDb().transaction(() => {
        if (!getRoleMenu(guildId, messageId)) return [];
        return getDb().prepare('SELECT * FROM role_menu_options WHERE message_id = ? ORDER BY sort_order').all(messageId);
    })();
}

function removeRoleMenuOption(guildId, messageId, roleId) {
    const db = getDb();
    return db.transaction(() => {
        if (!getRoleMenu(guildId, messageId)) return false;
        return db.prepare('DELETE FROM role_menu_options WHERE message_id = ? AND role_id = ?').run(messageId, roleId).changes > 0;
    }).immediate();
}

module.exports = { createRoleMenu, getRoleMenu, getRoleMenus, removeRoleMenu, addRoleMenuOption, getRoleMenuOptions, removeRoleMenuOption };

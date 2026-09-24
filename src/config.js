const { LOG_CATEGORIES } = require('./constants');
const { getDb } = require('./db');
const { logWarn } = require('./logError');

// ──────────────────── Default Config ────────────────────

const WELCOME_DEFAULTS = {
    enabled: false,
    channelId: null,
    content: null,
    embedTitle: '👋 Welcome!',
    embedDescription: 'Welcome {user} to **{server}**!',
    embedColor: '#5865F2',
    embedFooter: 'Member #{membercount}',
    embedFooterIcon: null,
    embedThumbnail: null,
    embedImage: null,
    embedAuthor: null,
    embedAuthorIcon: null,
};

const GOODBYE_DEFAULTS = {
    enabled: false,
    channelId: null,
    content: null,
    embedTitle: '👋 Goodbye!',
    embedDescription: '{user} has left **{server}**.',
    embedColor: '#E74C3C',
    embedFooter: 'Member #{membercount}',
    embedFooterIcon: null,
    embedThumbnail: null,
    embedImage: null,
    embedAuthor: null,
    embedAuthorIcon: null,
};

function getWelcomeConfig(guildId) {
    const g = getGuildConfig(guildId);
    return { ...WELCOME_DEFAULTS, ...(g.welcomeConfig?.welcome || {}) };
}

function getGoodbyeConfig(guildId) {
    const g = getGuildConfig(guildId);
    return { ...GOODBYE_DEFAULTS, ...(g.welcomeConfig?.goodbye || {}) };
}

function updateWelcomeConfig(guildId, type, updater) {
    return updateGuildConfig(guildId, (g) => {
        const wc = g.welcomeConfig || {};
        const cfg = type === 'welcome' ? { ...WELCOME_DEFAULTS, ...(wc.welcome || {}) } : { ...GOODBYE_DEFAULTS, ...(wc.goodbye || {}) };
        const updated = updater(cfg);
        wc[type] = updated;
        g.welcomeConfig = wc;
        return g;
    });
}

function createDefaultConfig() {
    const cats = {};
    const channels = {};
    for (const c of LOG_CATEGORIES) {
        cats[c] = true;
        channels[c] = null;
    }
    return {
        logChannelId: null,
        logChannels: channels,
        trackedChannels: [],
        logCategories: cats,
        prefix: ';',
        embedColor: null,
        welcomeConfig: {},
    };
}

// ──────────────────── Embed color helpers ────────────────────
// guild_config.embed_color is stored as the decimal string of the color int
// (e.g. "5815782" for #58B9F2). Historic rows/dashboard saves may hold legacy
// "#58B9F2"-style strings or garbage; normalize everything on the way in/out
// so consumers always receive an int (0-0xFFFFFF) or null.
// Bare pure-digit strings are parsed as DECIMAL (the canonical storage
// format — a 24-bit color is up to 8 decimal digits, more than 6 hex ones);
// strings with a # prefix or hex letters are parsed as hex, with 3-digit
// shorthand expanded CSS-style ('#abc' → 0xAABBCC).
function hexColorToInt(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
        return (Number.isInteger(value) && value >= 0 && value <= 0xFFFFFF) ? value : null;
    }
    const s = String(value).trim();
    if (s === '') return null;
    const hexBody = s.startsWith('#') ? s.slice(1) : s;
    const isHexForm = s.startsWith('#') || /[a-fA-F]/.test(hexBody);
    if (!isHexForm) {
        if (!/^\d+$/.test(s)) return null;
        const n = Number(s);
        return (n >= 0 && n <= 0xFFFFFF) ? n : null;
    }
    if (!/^[0-9a-fA-F]{3}$/.test(hexBody) && !/^[0-9a-fA-F]{6}$/.test(hexBody)) return null;
    const expanded = hexBody.length === 3
        ? hexBody[0] + hexBody[0] + hexBody[1] + hexBody[1] + hexBody[2] + hexBody[2]
        : hexBody;
    const n = parseInt(expanded, 16);
    return (isNaN(n) || n < 0 || n > 0xFFFFFF) ? null : n;
}

function intToHexString(n) {
    return (typeof n === 'number' && n >= 0 && n <= 0xFFFFFF)
        ? '#' + n.toString(16).padStart(6, '0')
        : null;
}

// Strict hex-form parser for the colors that commands, the dashboard and the
// DB all store as display strings ('#RRGGBB' / 'RRGGBB') — ticket panel
// colors, greeting embed colors. Unlike hexColorToInt() above it deliberately
// does NOT accept bare decimal strings, so a value like '5865F2' is parsed as
// hex (the intent) instead of decimal.
function displayColorToInt(value, fallback = null) {
    if (typeof value !== 'string') return fallback;
    const body = value.trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(body)) return fallback;
    const n = parseInt(body, 16);
    return (isNaN(n) || n < 0 || n > 0xFFFFFF) ? fallback : n;
}

function parseGuildRow(row) {
    if (!row) return null;
    return {
        logChannelId: row.default_channel,
        logChannels: JSON.parse(row.log_channels || '{}'),
        logCategories: JSON.parse(row.log_categories || '{}'),
        trackedChannels: JSON.parse(row.tracked_channels || '[]'),
        prefix: row.prefix || ';',
        embedColor: hexColorToInt(row.embed_color),
        welcomeConfig: JSON.parse(row.welcome_config || '{}'),
    };
}

// ──────────────────── Guild Config ────────────────────

function getGuildConfig(guildId) {
    const db = getDb();
    const row = db.prepare('SELECT * FROM guild_config WHERE guild_id = ?').get(guildId);
    if (row) {
        const g = parseGuildRow(row);
        // Auto-migrate missing fields
        let migrated = false;
        for (const cat of LOG_CATEGORIES) {
            if (g.logCategories[cat] === undefined) {
                g.logCategories[cat] = true;
                migrated = true;
            }
            if (g.logChannels[cat] === undefined) {
                g.logChannels[cat] = null;
                migrated = true;
            }
        }
        if (migrated) {
            updateGuildConfigRaw(guildId, g);
        }
        return g;
    }
    // Create default
    const def = createDefaultConfig();
    db.prepare(`
        INSERT INTO guild_config (guild_id, default_channel, tracked_channels, log_channels, log_categories, prefix, embed_color, welcome_config)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(guildId, null, '[]', JSON.stringify(def.logChannels), JSON.stringify(def.logCategories), ';', null, '{}');
    return def;
}

function updateGuildConfigRaw(guildId, g) {
    const db = getDb();
    const colorInt = hexColorToInt(g.embedColor);
    db.prepare(`
        UPDATE guild_config SET
            default_channel = ?,
            tracked_channels = ?,
            log_channels = ?,
            log_categories = ?,
            prefix = ?,
            embed_color = ?,
            welcome_config = ?
        WHERE guild_id = ?
    `).run(
        g.logChannelId || null,
        JSON.stringify(g.trackedChannels || []),
        JSON.stringify(g.logChannels || {}),
        JSON.stringify(g.logCategories || {}),
        g.prefix || ';',
        colorInt !== null ? String(colorInt) : null,
        JSON.stringify(g.welcomeConfig || {}),
        guildId
    );
}

// Every key updateGuildConfigRaw() persists. Updaters mutate a plain object,
// so a typo (cfg.embed_color = x instead of cfg.embedColor = x) used to
// persist nothing and say nothing — that exact bug shipped once. Warn loudly
// on unknown keys so the next one shows up in the logs instead of silently
// doing nothing.
const GUILD_CONFIG_KEYS = new Set([
    'logChannelId', 'logChannels', 'logCategories', 'trackedChannels',
    'prefix', 'embedColor', 'welcomeConfig',
]);

function warnUnknownGuildConfigKeys(guildId, cfg) {
    for (const key of Object.keys(cfg || {})) {
        if (GUILD_CONFIG_KEYS.has(key)) continue;
        logWarn(`Unknown guild_config key "${key}" was set and will not be persisted`, 'config', `guild=${guildId}`);
    }
}

function updateGuildConfig(guildId, updater) {
    const g = getGuildConfig(guildId);
    const updated = updater(g);
    warnUnknownGuildConfigKeys(guildId, updated);
    updateGuildConfigRaw(guildId, updated);
    return updated;
}

// ──────────────────── Load / Save (legacy — kept for external tooling compatibility) ────────────────────

function loadConfig() {
    // Returns the old nested format for compatibility with dashboard
    const db = getDb();
    const rows = db.prepare('SELECT * FROM guild_config').all();
    const config = {};
    for (const row of rows) {
        const g = parseGuildRow(row);
        config[row.guild_id] = {
            logChannelId: g.logChannelId,
            logChannels: g.logChannels,
            trackedChannels: g.trackedChannels,
            logCategories: g.logCategories,
            prefix: g.prefix,
        };
    }
    // Add bot config under _bot key
    const botCfg = getBotConfig();
    config._bot = botCfg;
    return config;
}

function saveConfig(config) {
    // Save from the old nested format back into SQLite
    const db = getDb();
    const upsert = db.prepare(`
        INSERT OR REPLACE INTO guild_config (guild_id, default_channel, tracked_channels, log_channels, log_categories, prefix, embed_color, welcome_config)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
        for (const [key, val] of Object.entries(config)) {
            if (key.startsWith('_')) {
                if (key === '_bot' && typeof val === 'object') {
                    saveBotConfig(val);
                }
                continue;
            }
            if (typeof val === 'object' && val !== null) {
                const colorInt = hexColorToInt(val.embedColor);
                upsert.run(
                    key,
                    val.logChannelId || null,
                    JSON.stringify(val.trackedChannels || []),
                    JSON.stringify(val.logChannels || {}),
                    JSON.stringify(val.logCategories || {}),
                    val.prefix || ';',
                    colorInt !== null ? String(colorInt) : null,
                    JSON.stringify(val.welcomeConfig || {})
                );
            }
        }
    });
    tx();
    return true;
}

// ──────────────────── Bot Config ────────────────────

const BOT_DEFAULTS = {
    embedFooterText: null,
    embedFooterIcon: null,
    embedColor: null,
};

function getBotConfig() {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM bot_config').all();
    const cfg = { ...BOT_DEFAULTS };
    for (const row of rows) {
        const key = row.key.replace(/^bot_/, '');
        try { cfg[key] = JSON.parse(row.value); } catch { cfg[key] = row.value; }
    }
    return cfg;
}

function saveBotConfig(partial) {
    const db = getDb();
    const upsert = db.prepare('INSERT OR REPLACE INTO bot_config (key, value) VALUES (?, ?)');
    const tx = db.transaction(() => {
        for (const [key, val] of Object.entries(partial)) {
            upsert.run('bot_' + key, JSON.stringify(val));
        }
    });
    tx();
    return { ...getBotConfig(), ...partial };
}

module.exports = {
    loadConfig,
    saveConfig,
    getGuildConfig,
    updateGuildConfig,
    getBotConfig,
    saveBotConfig,
    createDefaultConfig,
    getWelcomeConfig,
    getGoodbyeConfig,
    updateWelcomeConfig,
    hexColorToInt,
    intToHexString,
    displayColorToInt,
};

require('dotenv').config();

const {
    Client, GatewayIntentBits, Events, Partials,
} = require('discord.js');

// ─── Utilities & Data Layers ───
// Config is loaded on first access via getGuildConfig()
const { recordJoin, recordLeave } = require('./src/stats');
const { truncate, formatUptime, emojiToString, fetchAuditLogExecutor } = require('./src/helpers');
const { logError } = require('./src/logError');
const { deployCommands } = require('./src/deploy');
const { setLoggerClient, sendLog } = require('./src/logging');
const { findReactionRole } = require('./src/reactionRoles');
const { setInviteClient, handleInviteCreate, handleInviteDelete } = require('./src/invites');
const { setTicketClient, startInactivityCheck, stopInactivityCheck } = require('./src/tickets');
const { startTicketSlaSweeper, stopTicketSlaSweeper } = require('./src/ticketSla');
const { setGiveawayClient, startGiveawayCheck, stopGiveawayCheck } = require('./src/giveaways');
const { startServerStats, stopServerStats, scheduleGuildStatsRefresh } = require('./src/serverStats');
const { setVoiceClient, enableDiscordJsVoice, handleBotVoiceUpdate, stopVoicePresence } = require('./src/voicePresence');
const { handleVoiceStateUpdate: handleTempVoiceUpdate, stopTempVoice } = require('./src/tempVoice');
const { setTempBanClient, startTempBanSweeper, stopTempBanSweeper } = require('./src/tempBans');
const { setTempRoleClient, startTempRoleSweeper, stopTempRoleSweeper } = require('./src/tempRoles');

// ─── Command Registry ───
const { runCommand } = require('./src/commandPipeline');

// ─── Event Handlers ───
const readyEvent = require('./src/events/ready');
const messageEvents = require('./src/events/messages');
const reactionEvents = require('./src/events/reactions');
const memberEvents = require('./src/events/members');
const roleEvents = require('./src/events/roles');
const serverEvents = require('./src/events/server');
const voiceEvents = require('./src/events/voice');
const extraEvents = require('./src/events/extras');
const automodEvents = require('./src/events/automod');

// ──────────────────── Bot Setup ────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildScheduledEvents,
        GatewayIntentBits.GuildModeration,
        GatewayIntentBits.GuildExpressions,
    ],
    partials: [
        Partials.Message,
        Partials.Channel,
        Partials.Reaction,
        Partials.GuildMember,
    ],
});

setLoggerClient(client);
setInviteClient(client);
setVoiceClient(client);
setTempBanClient(client);
setTempRoleClient(client);
// @discordjs/voice — lets the bot join a VC from an idle state (the REST
// move endpoint can only move a bot that is already connected).
if (!enableDiscordJsVoice()) {
    console.warn('[WARN] @discordjs/voice is not available — /vc join will only work to MOVE the bot between VCs, not connect from idle. Run `npm install`.');
}

// ──────────────────── Event Dependencies ────────────────────

const eventDeps = {
    client,
    sendLog,
    truncate,
    formatUptime,
    emojiToString,
    deployCommands,
    recordJoin,
    recordLeave,
    rrFind: findReactionRole,
    fetchAuditLogExecutor,
    handleInviteCreate,
    handleInviteDelete,
};

// ──────────────────── Register Events ────────────────────

const allEvents = [
    readyEvent,
    ...messageEvents,
    ...reactionEvents,
    ...memberEvents,
    ...roleEvents,
    ...serverEvents,
    ...voiceEvents,
    ...extraEvents,
    ...automodEvents,
];

for (const event of allEvents) {
    // Wrap every event handler so a rejected promise can never crash the bot.
    // Each handler is an async fn — without this guard, one throw becomes an
    // unhandledRejection that takes the whole process down.
    const rawHandler = event.execute(eventDeps);
    const safeHandler = async (...args) => {
        try {
            await rawHandler(...args);
        } catch (err) {
            logError(err, 'event', String(event.name));
        }
    };
    if (event.once) {
        client.once(event.name, safeHandler);
    } else {
        client.on(event.name, safeHandler);
    }
}

// ── Live server-stats refresh (join / leave / boost changes) ──
// Fires on top of the registered events so stat channels update promptly
// instead of waiting for the 10-minute sweep. Scheduling is debounced per
// guild (and paced per channel) inside serverStats, so a join raid becomes one
// refresh instead of hundreds of rate-limited channel renames. Never throws —
// failures are logged by the scheduler itself.
client.on(Events.GuildMemberAdd, (member) => { scheduleGuildStatsRefresh(member.guild); });
client.on(Events.GuildMemberRemove, (member) => { scheduleGuildStatsRefresh(member.guild); });
client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if ((oldMember.premiumSince || null) !== (newMember.premiumSince || null)) {
        scheduleGuildStatsRefresh(newMember.guild);
    }
});

// ── Voice presence self-heal ──
// If the bot is moved manually it follows; if it gets disconnected while a
// presence is saved (kicked / channel deleted / blip) it rejoins with
// bounded backoff. Never throws.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    try { handleBotVoiceUpdate(oldState, newState); } catch { /* never crash on voice state */ }
});

// ── Temp voice channels ──
// Joining a trigger VC spawns a per-user channel; leaving an empty spawned
// channel schedules its deletion. Never throws.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    try { handleTempVoiceUpdate(oldState, newState); } catch { /* never crash on voice state */ }
});// ──────────────────── Cooldown cleanup on startup ────────────────────
// (The cooldown system itself lives in src/commandPipeline.js, shared
// with the prefix dispatcher.)

// Cleanup expired DB cooldowns on startup
function cleanupExpiredCooldowns() {
    try {
        const { getDb } = require('./src/db');
        const db = getDb();
        db.prepare('DELETE FROM command_cooldowns WHERE expires_at <= ?').run(Date.now());
    } catch (err) {
        console.error('[Cooldown] Cleanup failed:', err.message);
    }
}
cleanupExpiredCooldowns();

// ──────────────────── Interaction Handler ────────────────────

const { handleInteraction } = require('./src/interactions');

client.on(Events.InteractionCreate, async (interaction) => {
    try {
        // Handle components (buttons, modals, select menus) separately
        if (interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu() || interaction.isUserSelectMenu()) {
            return await handleInteraction(interaction);
        }

        // Handle slash commands — shared pipeline (cooldown, owner guard,
        // registry, usage tracking, friendly errors). The prefix dispatcher
        // runs the exact same pipeline via the interaction shim.
        if (!interaction.isChatInputCommand()) return;
        if (!interaction.guild) {
            return interaction.reply({ content: '❌ This bot only works in servers.', ephemeral: true });
        }

        const handled = await runCommand(interaction);
        if (!handled) {
            return interaction.reply({ content: '❌ Unknown command. Use `/help` to see available commands.', ephemeral: true });
        }
    } catch (err) {
        // Top-level catch — prevents crashes from reaching Discord's generic "Interaction failed"
        console.error('[Interaction Fatal]', err);
        logError(err, 'interaction', 'fatal');
        try {
            const reply = interaction.deferred || interaction.replied
                ? interaction.editReply.bind(interaction)
                : interaction.reply.bind(interaction);
            await reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true });
        } catch { /* ignore double-fail */ }
    }
});

// ──────────────────── Reminder Client (checker starts post-login) ────────────────────

const { setReminderClient, startReminderChecker, stopReminderChecker } = require('./src/reminders');
setReminderClient(client);

// ──────────────────── Scheduled Post Client (poster starts post-login) ────────────────────
const { setScheduledPostClient, startScheduledPoster, stopScheduledPoster } = require('./src/scheduledPosts');
setScheduledPostClient(client);

// ──────────────────── Start Web Dashboard ────────────────────

const { createDashboard, setDashboardClient } = require('./src/dashboard');
setDashboardClient(client, process.env.DASHBOARD_PASSWORD);
setTicketClient(client);
const app = createDashboard();
const PORT = process.env.PORT || 3000;
// Kept as a handle so shutdown can stop accepting connections and let the
// requests already in flight finish (see src/shutdown.js).
const httpServer = app.listen(PORT, () => {
    console.log('Dashboard running on port ' + PORT);
});

// ──────────────────── Login ────────────────────

// ──────────────────── Graceful Shutdown ────────────────────

const { closeDb, getDb, backupDatabase, startDataRetentionSweeper, stopDataRetentionSweeper } = require('./src/db');

const { createShutdown } = require('./src/shutdown');
const shutdown = createShutdown({
    server: httpServer,
    client,
    closeDb,
    stopTimers: [
        app.locals.stopEventStreams,
        stopInactivityCheck,
        stopTicketSlaSweeper,
        stopGiveawayCheck,
        stopServerStats,
        stopVoicePresence,
        stopTempVoice,
        stopTempBanSweeper,
        stopTempRoleSweeper,
        stopReminderChecker,
        stopScheduledPoster,
        stopDataRetentionSweeper,
    ],
    log: console.log,
});
// /shutdown (Discord) uses the same path, so it stops the same work and waits
// for in-flight requests instead of calling process.exit() from the handler.
global.gracefulShutdown = shutdown;

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGQUIT', () => shutdown('SIGQUIT'));

// ──────────────────── Global Crash Safety Nets ────────────────────
// A single unhandled rejection or uncaught exception must never take the bot
// down silently. Log full context so failures are visible in the logs.
process.on('unhandledRejection', (reason) => {
    // Keep running: most rejections are transient API hiccups / network errors.
    logError(reason instanceof Error ? reason : new Error(String(reason)), 'unhandledRejection');
});

process.on('uncaughtException', (err) => {
    // Unrecoverable — log loudly, then exit so the host restarts us cleanly.
    logError(err, 'uncaughtException');
    try { closeDb(); } catch {}
    try { client.destroy(); } catch {}
    process.exit(1);
});

// ──────────────────── Scheduled Database Backups ────────────────────
// Snapshot bot.db shortly after boot, then once per day. The dashboard can
// also trigger backups manually and download/delete them.
async function runScheduledBackup() {
    try {
        const r = await backupDatabase();
        if (r) console.log('[Backup] Created ' + r.name + ' (' + (r.size / 1024).toFixed(1) + ' KB)');
    } catch (err) {
        logError(err, 'backup');
    }
}
setTimeout(runScheduledBackup, 10 * 1000);
setInterval(runScheduledBackup, 24 * 60 * 60 * 1000);

// ──────────────────── Error Alert Notifier ────────────────────
// If an alert channel is configured from the dashboard, surface critical
// errors there. Rate-limited to 1 message / 60s to avoid spam storms.
const { setErrorListener } = require('./src/logError');
let lastErrorAlertAt = 0;
const CRITICAL_ERROR_TAGS = new Set(['uncaughtException', 'unhandledRejection']);
setErrorListener((entry) => {
    try {
        if (!entry || !CRITICAL_ERROR_TAGS.has(entry.tag)) return;
        const now = Date.now();
        if (now - lastErrorAlertAt < 60 * 1000) return;
        const row = getDb().prepare('SELECT value FROM bot_config WHERE key = ?').get('bot_error_alert_channel');
        if (!row || !row.value) return;
        const channel = client.channels.cache.get(row.value);
        if (!channel || !channel.isTextBased || !channel.isTextBased()) return;
        lastErrorAlertAt = now;
        channel.send({
            embeds: [{
                color: 0xED4245,
                author: { name: '⚠️ Critical Bot Error' },
                title: entry.tag,
                description: '```\n' + String(entry.message || 'Unknown error').slice(0, 1500) + '\n```',
                fields: entry.stack ? [{ name: 'Stack (first lines)', value: '```\n' + String(entry.stack).slice(0, 900) + '\n```' }] : [],
                timestamp: entry.timestamp || new Date().toISOString(),
            }],
        }).catch((err) => logError(err, 'event', 'error_alert_send'));
    } catch { /* alerting must never crash the bot */ }
});

// ──────────────────── Login ────────────────────

client.login(process.env.BOT_TOKEN).then(() => {
    startInactivityCheck(client);
    // Ticket SLA: boot sweep first, so tickets that passed their threshold while
    // the bot was offline are alerted rather than silently forgotten.
    startTicketSlaSweeper(client);
    setGiveawayClient(client);
    startGiveawayCheck();
    startServerStats(client);
    startTempBanSweeper();
    startTempRoleSweeper();
    startReminderChecker();
    startScheduledPoster();
    startDataRetentionSweeper();
    console.log('[Bot] Ticket inactivity, giveaway + server stats checks started.');
}).catch(err => {
    console.error('[Bot] Failed to login:', err.message || err);
    process.exit(1);
});

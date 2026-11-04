// ──────────────────── Command Registry ────────────────────
// Maps command names to their handler functions.
// Add new commands here instead of wiring them into index.js.

// ── Info ──
const { executePing, executeStatus, executeBotInfo, executeUserInfo, executeAvatar, executeStats } = require('./info');
const { executeHelp } = require('./help');



// ── Fun ──
const { executeWorldCup, execute8Ball, executeCoinflip, executeDice, executeRPS, executeJoke, executeFact, executeAdvice, executeQuote, executeReverse, executeMock, executeRandom } = require('./fun');

// ── Reminders ──
const { executeRemindMe, executeReminders } = require('./reminder');

// ── Giveaways ──
const { executeGiveaway } = require('./giveaways');

// ── Scheduled Posts ──
const { executeSchedule } = require('./schedule');

// ── Raid Mode ──
const { executeRaidMode } = require('./raidMode');

// ── Member Reports ──
const { executeReport } = require('./report');

// ── Server Stats ──
const { executeServerStats } = require('./serverStats');

// ── Voice Presence ──
const { executeVoicePresence } = require('./voicePresence');

// ── Temp Voice Channels ──
const { executeTempVoice } = require('./tempVoice');

// ── Admin ──
const { executeRole, executePurge, executeSlowmode, executeNickname, executeSay, executeEmbed, executeDeploy, executeTrack, executePoll, executeAnnounce } = require('./admin');

// ── Moderation ──
const { executeKick, executeBan, executeTempBan, executeUnban, executeTimeout, executeUntimeout, executeWarn, executeWarnings, executeClearWarnings, executeLock, executeUnlock } = require('./moderation');
const { executeHistory, executeCase: executeCaseCmd, executeReason } = require('./modCases');



// ── Config ──
const { executeLog, executeEmbedConfig, executePresence, executeBotAvatar, executeBotName, executePrefix } = require('./config');

// ── Permissions ──
const { executePerm } = require('./permissions');

// ── Reaction Roles ──
const { executeReactionRole } = require('./reactionRoles');

// ── Owner ──
const { executeDashboard, executeDashAccess, executeServerLeave, executeShutdown } = require('./owner');

// ── Welcome/Goodbye ──
const { executeWelcome, executeGoodbye } = require('./greetings');

// ── Role Menus ──
const { executeRoleMenu } = require('./roleMenu');

// ── Auto-Mod ──
const { executeAutoMod } = require('./automod');

// ── Invites ──
const { executeInvites } = require('./invites');

// ── Custom Commands & Autoresponders ──
const { executeCustomCommand, executeAutoresponder } = require('./customCommands');

// ── Temporary Roles ──
const { executeTempRole } = require('./tempRole');

// ── Staff Notes ──
const { executeNote } = require('./note');

// ── Member File ──
const { executeMemberFile } = require('./memberFile');

// ── Log Search ──
const { executeLogs } = require('./logs');

// ── Warning Thresholds ──
const { executeThresholds } = require('./thresholds');

// ── Tickets ──
const { executeTicket } = require('./tickets');

// ──────────────────── Registry Map ────────────────────

const commandRegistry = {
    // Info
    help: executeHelp,
    ping: executePing,
    status: executeStatus,
    botinfo: executeBotInfo,
    userinfo: executeUserInfo,
    avatar: executeAvatar,
    stats: executeStats,

    // Fun (public)
    worldcup: executeWorldCup,
    '8ball': execute8Ball,
    coinflip: executeCoinflip,
    dice: executeDice,
    rps: executeRPS,
    joke: executeJoke,
    fact: executeFact,
    advice: executeAdvice,
    quote: executeQuote,
    reverse: executeReverse,
    mock: executeMock,
    random: executeRandom,

    // Reminders (public)
    remindme: executeRemindMe,
    reminders: executeReminders,

    // Giveaways (owner)
    giveaway: executeGiveaway,

    // Admin
    role: executeRole,
    purge: executePurge,
    slowmode: executeSlowmode,
    nickname: executeNickname,
    say: executeSay,
    embed: executeEmbed,
    deploy: executeDeploy,
    track: executeTrack,
    poll: executePoll,
    announce: executeAnnounce,
    schedule: executeSchedule,
    raidmode: executeRaidMode,
    report: executeReport,

    // Moderation
    kick: executeKick,
    ban: executeBan,
    tempban: executeTempBan,
    unban: executeUnban,
    timeout: executeTimeout,
    untimeout: executeUntimeout,
    warn: executeWarn,
    warnings: executeWarnings,
    clearwarnings: executeClearWarnings,
    lock: executeLock,
    unlock: executeUnlock,
    history: executeHistory,
    case: executeCaseCmd,
    reason: executeReason,

    // Config
    log: executeLog,
    embedconfig: executeEmbedConfig,
    presence: executePresence,
    botavatar: executeBotAvatar,
    botname: executeBotName,
    prefix: executePrefix,

    // Permissions
    perm: executePerm,

    // Reaction Roles
    reactionrole: executeReactionRole,

    // Welcome/Goodbye
    welcome: executeWelcome,
    goodbye: executeGoodbye,

    // Owner
    dashboard: executeDashboard,
    dashaccess: executeDashAccess,
    server_leave: executeServerLeave,
    shutdown: executeShutdown,

    // Role Menus
    rolemenu: executeRoleMenu,

    // Auto-Mod
    automod: executeAutoMod,

    // Invites
    invites: executeInvites,

    // Custom Commands & Autoresponders
    customcommand: executeCustomCommand,
    autoresponder: executeAutoresponder,

    // Temporary Roles
    temprole: executeTempRole,

    // Staff Notes
    note: executeNote,

    // Member File (warnings, cases, notes, reports, appeals, tickets in one view)
    memberfile: executeMemberFile,

    // Log Search
    logs: executeLogs,

    // Warning Thresholds
    thresholds: executeThresholds,

    // Server Stats
    serverstats: executeServerStats,

    // Voice Presence
    vc: executeVoicePresence,

    // Temp Voice Channels
    tempvc: executeTempVoice,

    // Tickets
    ticket: executeTicket,
};

// Commands that anyone can use (no owner guard)
const publicCommands = [
    'help', 'ping', 'status', 'botinfo', 'userinfo', 'avatar', 'stats',
    'worldcup', '8ball', 'coinflip', 'dice', 'rps',
    'joke', 'fact', 'advice', 'quote', 'reverse', 'mock', 'random',
    'remindme', 'reminders',
    // /report is filed BY members about other members — the handler already
    // rejects self-reports and bots, and reports land in a staff-reviewed
    // queue, so gating it behind owner/perm made the feature unusable.
    'report',
    // tempvc enforces owner/owner-of-channel permissions inside its handler
    'tempvc',
    // /prefix with no args only VIEWS the prefix; the change path is
    // re-checked with ownerGuard inside the handler.
    'prefix',
];

module.exports = { commandRegistry, publicCommands };

// ──────────────────── Command visibility policy ────────────────────
// `default_member_permissions` decides who sees a command in Discord's picker
// and who may run it. Discord enforces it server-side: an invocation from
// someone without the permission never reaches the bot, and holders of
// Administrator always bypass it. Until this existed not one of the ~50
// non-public commands set it, so every moderation and configuration command was
// listed for every member of every server.
//
// Two bars, picked to match what these commands already imply in Discord:
//   ModerateMembers — day-to-day moderation of members and messages
//   ManageGuild     — server-wide configuration and bot plumbing
//
// The bot's `/perm` grants are the reason this needs care: Discord can only gate
// on a real permission, so a grant now only reaches members who already hold the
// mapped permission. Anything in the registry's `publicCommands` is deliberately
// left unrestricted — those handlers do their own checks.
//
// The lists below are asserted against the registry by
// test/commandPolicy.test.js, so a new command has to be classified.

const { PermissionFlagsBits, InteractionContextType } = require('discord.js');

// Member-facing moderation: kicking, banning, muting, watching, and the
// staff-facing tools that go with it.
const MODERATION_COMMANDS = new Set([
    'kick', 'ban', 'tempban', 'unban',
    'timeout', 'untimeout',
    'warn', 'warnings', 'clearwarnings',
    'history', 'case', 'reason', 'note', 'memberfile',
    'purge', 'slowmode', 'lock', 'unlock',
    'nickname', 'role', 'temprole',
    'rolemenu', 'reactionrole',
]);

// `/report` is deliberately absent from both sets: it is member-facing, so it
// is listed in the registry's publicCommands and must stay unrestricted here.
// Restricting it made Discord refuse the invocation before the bot ever saw it,
// which left the reports queue empty in every server whose members are not
// moderators.

// Server-wide configuration, content posted as the bot, and troubleshooting.
const ADMIN_COMMANDS = new Set([
    'log', 'embedconfig', 'presence', 'botavatar', 'botname', 'perm',
    'welcome', 'goodbye',
    'dashboard', 'dashaccess', 'server_leave', 'shutdown',
    'deploy', 'automod', 'customcommand', 'autoresponder', 'thresholds',
    'serverstats', 'vc', 'ticket', 'giveaway', 'schedule', 'raidmode',
    'invites', 'say', 'embed', 'track', 'poll', 'announce', 'logs',
]);

// Every command needs a guild — cooldowns and config are per-guild, and the
// pipeline reads `interaction.guild.id` before it does anything else, which
// throws in a DM. Registering them as guild-only keeps them out of DMs.
const GUILD_ONLY = [InteractionContextType.Guild];

// The permission a command requires, or null when it is public.
function permissionFor(commandName) {
    if (MODERATION_COMMANDS.has(commandName)) return PermissionFlagsBits.ModerateMembers;
    if (ADMIN_COMMANDS.has(commandName)) return PermissionFlagsBits.ManageGuild;
    return null;
}

// Applies the policy to one deployed command definition (plain REST JSON).
function applyCommandPolicy(def) {
    if (!def || !def.name) return def;
    def.contexts = GUILD_ONLY.slice();
    const permission = permissionFor(def.name);
    if (permission !== null) def.default_member_permissions = permission.toString();
    return def;
}

module.exports = {
    MODERATION_COMMANDS,
    ADMIN_COMMANDS,
    GUILD_ONLY,
    permissionFor,
    applyCommandPolicy,
};

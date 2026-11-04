// ──────────────────── Actor role hierarchy ────────────────────
// Discord refuses to let you kick, ban, time out, rename or edit the roles of a
// member whose highest role is at or above your own. The bot is the account
// making the API call though, so every check in this codebase was about the
// *bot's* position — `member.kickable`, `member.moderatable`, "that role is
// higher than my highest role", "than me". None of them look at the person who
// typed the command, so a moderator granted a command with `/perm` could kick,
// ban or time out an administrator who outranks them, and hand out roles above
// their own rank.
//
// This module is the missing half of that rule: it compares the invoker against
// the target member (and against a role being managed) so a grant only lets
// someone act on members they actually outrank.

const { isOwner } = require('./helpers');

// A member's top role position, or null when there is no role data to read
// (test doubles and legacy shims). An unknown position is never used to block:
// in production both sides are cached GuildMembers, so this only ever lets
// stand-ins through.
function topPosition(member) {
    const pos = member && member.roles && member.roles.highest ? member.roles.highest.position : null;
    return typeof pos === 'number' && Number.isFinite(pos) ? pos : null;
}

function resolveMember(guild, actorId) {
    const cache = guild && guild.members && guild.members.cache;
    if (!cache || typeof cache.get !== 'function') return null;
    return cache.get(actorId) || null;
}

// null when the action is allowed, otherwise a reason to show the invoker.
//   guild    — the guild the action runs in
//   actorId  — the invoking user
//   actor    — that user's member object, when the caller already has it
//   target   — the member being acted on (null when they aren't in the guild)
//   role     — a role being handed out or configured, when there is one
function checkHierarchy({ guild, actorId, actor, target, role }) {
    if (!guild || !actorId) return null;

    // The bot owner runs the bot, and the server owner outranks everyone in
    // their own guild — neither is limited by role position.
    if (isOwner(actorId) || (guild.ownerId && actorId === guild.ownerId)) return null;

    const actorMember = topPosition(actor) === null ? resolveMember(guild, actorId) : actor;
    const actorTop = topPosition(actorMember);
    if (actorTop === null) return null; // nothing to compare — see topPosition

    if (role && typeof role.position === 'number' && actorTop <= role.position) {
        return 'That role is not below your highest role, so you cannot manage it.';
    }

    // Acting on yourself isn't a hierarchy question — Discord allows changing
    // your own nickname or roles.
    if (!target || target.id === actorId) return null;

    const targetTop = topPosition(target);
    if (targetTop !== null && actorTop <= targetTop) {
        return 'Their highest role is at or above yours, so you cannot act on them.';
    }
    return null;
}

// Convenience for slash/prefix handlers: resolves the invoker from the
// interaction (the prefix dispatcher's shim carries the real `member` too).
function hierarchyBlock(interaction, target, role) {
    if (!interaction) return null;
    return checkHierarchy({
        guild: interaction.guild,
        actorId: interaction.user && interaction.user.id,
        actor: interaction.member,
        target,
        role,
    });
}

module.exports = { checkHierarchy, hierarchyBlock, topPosition };

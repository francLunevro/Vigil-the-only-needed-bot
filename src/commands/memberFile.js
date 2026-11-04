// ──────────────────── /memberfile <user> ────────────────────
// The staff-side view of everything on a member: warnings, mod cases, staff
// notes, reports against them, ban appeals and ticket history, merged into one
// timeline (src/memberFile.js does the composing).
//
// Ephemeral, deliberately. /history replies in the channel with the case list;
// this includes staff notes, which src/staffNotes.js defines as "private notes
// on users (not visible to the user)". Posting them into a channel the subject
// can read would break that promise, so the whole file is visible only to the
// staff member who asked for it. Access is the normal command gate — the
// pipeline's ownerGuard plus Discord's ModerateMembers permission from
// src/commandPolicy.js — so no new permission system exists here.
//
// Nothing is created or changed by looking: every number comes from the
// read-only accessors the owning modules already expose.

const { EmbedBuilder } = require('discord.js');
const { getMemberFile } = require('../memberFile');
const { sanitizeForEmbed, truncate } = require('../helpers');

const FIELD_MAX = 1024;
const TIMELINE_ROWS = 12;

const KIND_EMOJI = {
    case: '📋',
    warning: '⚠️',
    note: '📝',
    report: '🚩',
    appeal: '⚖️',
    ticket: '🎫',
    tempban: '🔨',
};

function relative(at) {
    return at > 0 ? '<t:' + Math.floor(at / 1000) + ':R>' : 'date unknown';
}

// One line per event, newest first. The reason is shortened here rather than in
// memberFile, because the embed's budget is the embed's business.
function timelineLines(timeline) {
    return timeline.slice(0, TIMELINE_ROWS).map((entry) => {
        const emoji = KIND_EMOJI[entry.kind] || '•';
        const detail = truncate(sanitizeForEmbed(String(entry.detail || '').replace(/\s+/g, ' '), 140), 140);
        const meta = [entry.actor ? 'by ' + entry.actor : null, relative(entry.at)]
            .filter(Boolean).join(' · ');
        return emoji + ' **' + entry.title + '** — ' + detail + '\n└ ' + meta;
    }).join('\n\n');
}

function summaryLine(s) {
    const parts = [
        '**' + s.warnings.total + '** warning' + (s.warnings.total === 1 ? '' : 's'),
        '**' + s.cases.total + '** case' + (s.cases.total === 1 ? '' : 's')
            + (s.cases.active ? ' (' + s.cases.active + ' active)' : ''),
        '**' + s.notes.total + '** note' + (s.notes.total === 1 ? '' : 's'),
        '**' + s.reports.total + '** report' + (s.reports.total === 1 ? '' : 's'),
        '**' + s.appeals.total + '** appeal' + (s.appeals.total === 1 ? '' : 's'),
        '**' + s.tickets.total + '** ticket' + (s.tickets.total === 1 ? '' : 's'),
    ];
    return parts.join(' · ');
}

function openItemsLine(file) {
    const s = file.summaries;
    const bits = [];
    if (file.activePunishments.length) {
        bits.push(file.activePunishments.map((p) => {
            const until = p.until ? ' until ' + relative(p.until) : '';
            return '**' + p.type + '**' + (p.caseNumber ? ' (case #' + p.caseNumber + ')' : '') + until;
        }).join('\n'));
    }
    if (s.reports.pending) bits.push('**' + s.reports.pending + '** report(s) pending review');
    if (s.appeals.pending) bits.push('**' + s.appeals.pending + '** ban appeal(s) pending');
    if (s.tickets.open) bits.push('**' + s.tickets.open + '** ticket(s) still open');
    return bits.join('\n');
}

async function executeMemberFile(interaction) {
    const target = interaction.options.getUser('user');
    const guild = interaction.guild;

    if (!target) {
        return interaction.reply({ content: '❌ Pick a member to open the file for.', ephemeral: true });
    }

    const file = getMemberFile(guild.id, target.id, { limit: 25 });
    const empty = file.timeline.length === 0;

    const embed = new EmbedBuilder()
        .setColor(empty ? 0x3BA55C : 0x5865F2)
        .setTitle('🗂️ Member file — ' + target.tag)
        .setDescription(
            '<@' + target.id + '>\n' + summaryLine(file.summaries)
        )
        .setFooter({ text: 'Staff only · ' + guild.name })
        .setTimestamp();

    if (empty) {
        embed.addFields({ name: 'Nothing on file', value: 'No warnings, cases, notes, reports, appeals or tickets for this member.' });
    } else {
        const open = openItemsLine(file);
        if (open) embed.addFields({ name: 'Open items', value: truncate(open, FIELD_MAX) });

        embed.addFields({
            name: 'Recent activity' + (file.truncated ? ' (newest first, older entries on the dashboard)' : ''),
            value: truncate(timelineLines(file.timeline), FIELD_MAX),
        });
    }

    // A source that failed to read is named rather than hidden behind an
    // incomplete-looking file.
    if (file.errors.length) {
        embed.addFields({
            name: '⚠️ Incomplete',
            value: 'Could not read: ' + file.errors.join(', ') + '. Retry shortly; the failure is in the dashboard error log.',
        });
    }

    await interaction.reply({ embeds: [embed], ephemeral: true });
}

module.exports = { executeMemberFile };

const { EmbedBuilder } = require('discord.js');
const { logError } = require('../logError');
const { getWelcomeConfig, getGoodbyeConfig } = require('../config');
const { buildGreetingEmbed } = require('../commands/greetings');
const { replacePlaceholders } = require('../helpers');
const { handleRaidModeJoin } = require('../raidMode');
const { modActionLogEmbed, membershipField } = require('../logging');

// ─── Send custom welcome/goodbye message ───

async function sendGreeting(member, type) {
    if (member.user.bot) return;
    const guild = member.guild;
    
    const cfg = type === 'welcome' ? getWelcomeConfig(guild.id) : getGoodbyeConfig(guild.id);
    if (!cfg.enabled || !cfg.channelId) return;

    const channel = guild.channels.cache.get(cfg.channelId);
    if (!channel) return;

    try {
        const messageContent = cfg.content ? replacePlaceholders(cfg.content, member, type) : '';
        const embed = buildGreetingEmbed(cfg, member, type);
        await channel.send({ content: messageContent || undefined, embeds: [embed] });
    } catch (err) {
        logError(err, 'events', 'sendGreeting/' + type);
    }
}

    module.exports = [
        {
            name: 'guildMemberAdd',
            once: false,
            execute: (deps) => async (member) => {
                const isBot = member.user.bot;
                
                if (!isBot) deps.recordJoin(member.guild.id);

                // ── Send welcome message ──
                if (!isBot) {
                    await sendGreeting(member, 'welcome');
                    // ── Raid mode: lockdown new joins ──
                    await handleRaidModeJoin(member);
                }

                const daysSinceCreation = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
                const isNewAccount = daysSinceCreation < 7;
                const ageWarning = isNewAccount
                    ? '\n\u26A0\uFE0F **Warning: Account is only ' + daysSinceCreation + ' day' + (daysSinceCreation === 1 ? '' : 's') + ' old**'
                    : '';

                const titleIcon = '\uD83D\uDC4B';
                const titleText = 'Member Joined';
                const description = member.user + ' joined the server';
                const embedColor = 0x3498DB;

                // Detect which invite was used (only for humans)
                if (!isBot) {
                    try {
                        const { detectUsedInvite } = require('../invites');
                        const used = await detectUsedInvite(member);
                        if (used && used.inviterId) {
                            const inviter = await member.guild.members.fetch(used.inviterId).catch(() => null);
                            if (inviter) {
                                const extraField = { name: '\uD83D\uDD17 Invited By', value: String(inviter) + ' (code: `' + used.code + '`)', inline: true };
                                // We'll add this field to the embed later
                                member._inviteInfo = extraField;
                            }
                        }
                    } catch (err) {
                        logError(err, 'events', 'guildMemberAdd/invite_detect');
                    }
                }

                // Bots get their own Wick-style application log in the
                // applications category (who added it, bot ID, account age).
                if (isBot) {
                    let addedByUser = null;
                    if (member.guild.fetchAuditLogs) {
                        try {
                            const audit = await member.guild.fetchAuditLogs({ type: 28, limit: 3 }); // BOT_ADD
                            const entry = audit?.entries?.first();
                            if (entry && (entry.target?.id === member.user.id || entry.targetId === member.user.id)) {
                                addedByUser = entry.executor || null;
                            }
                        } catch (err) {
                            logError(err, 'events', 'guildMemberAdd/bot_audit');
                        }
                    }

                    const botEmbed = new EmbedBuilder()
                        .setColor(0x9B59B6)
                        .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
                        .setTitle('\uD83E\uDDE9 Application Added')
                        .setDescription(member.user + ' (**' + member.user.tag + '**) was added to the server')
                        .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
                        .addFields(
                            {
                                name: 'Application',
                                value: '**' + member.user.tag + '**\nID: ' + member.user.id,
                            },
                            {
                                name: 'Added By',
                                value: addedByUser
                                    ? '**' + addedByUser.tag + '** (' + String(addedByUser) + ')\nID: ' + addedByUser.id
                                    : 'Unknown (audit log unavailable)',
                            },
                            {
                                name: '\uD83D\uDD10 Account Info',
                                value: 'Created: <t:' + Math.floor(member.user.createdTimestamp / 1000) + ':R>'
                                    + '\nAge: ' + daysSinceCreation + ' day' + (daysSinceCreation === 1 ? '' : 's'),
                            },
                            { name: '\uD83D\uDC65 Member Count', value: String(member.guild.memberCount), inline: true },
                        )
                        .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() })
                        .setTimestamp();

                    deps.sendLog(botEmbed, 'applications', null, member.guild.id);
                    return;
                }

                const embed = new EmbedBuilder()
                    .setColor(embedColor)
                    .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
                    .setTitle(titleIcon + ' ' + titleText)
                    .setDescription(description)
                    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
                    .addFields(
                        {
                            name: '\uD83D\uDD10 Account Info',
                            value: 'Created: <t:' + Math.floor(member.user.createdTimestamp / 1000) + ':R>'
                                + '\nAge: ' + daysSinceCreation + ' day' + (daysSinceCreation === 1 ? '' : 's')
                                + (isBot ? '\n\uD83E\uDD16 **Bot account**' : ageWarning),
                        },
                        { name: '\uD83D\uDCC5 Joined Server', value: '<t:' + Math.floor(Date.now() / 1000) + ':R>', inline: true },
                        { name: '\uD83D\uDC65 Member Count', value: String(member.guild.memberCount), inline: true },
                        { name: '\uD83D\uDC64 ID', value: member.user.id, inline: true },
                    )
                    .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() })
                    .setTimestamp();

                // Add invite info if detected
                if (member._inviteInfo) {
                    try { embed.addFields(member._inviteInfo); } catch {}
                }

                deps.sendLog(embed, 'members', null, member.guild.id);
            },
        },
        {
            name: 'guildMemberRemove',
            once: false,
            execute: (deps) => async (member) => {
                if (member.user.bot) return;

                deps.recordLeave(member.guild.id);

                // ── Send goodbye message ──
                await sendGreeting(member, 'goodbye');

                // ── Auto-close tickets if configured ──
                try {
                    const { handleMemberLeave } = require('../tickets');
                    await handleMemberLeave(member);
                } catch (err) {
                    logError(err, 'events', 'members/ticketAutoClose');
                }

                // ── Detect whether this removal was a kick or ban (audit logs) ──
                let removal = null;
                try {
                    // Check audit log for kick (20) or ban (22)
                    for (const actionType of [20, 22]) {
                        const audit = await member.guild.fetchAuditLogs({ type: actionType, limit: 5 }).catch(() => null);
                        if (!audit?.entries?.size) continue;
                        const entry = audit.entries.find(e => {
                            const tId = e.target?.id || e.targetId;
                            return tId === member.user.id;
                        });
                        if (entry && entry.executor) {
                            const ago = Date.now() - entry.createdTimestamp;
                            if (ago < 15000) { // fresh enough to be THIS removal
                                removal = {
                                    type: actionType === 20 ? 'kick' : 'ban',
                                    executor: entry.executor,
                                    reason: entry.reason || null,
                                };
                                break;
                            }
                        }
                    }
                } catch (err) {
                    logError(err, 'events', 'guildMemberRemove/audit');
                }

                // Logging policy:
                //   · our own kick/ban commands already posted their Wick-style
                //     log entries → skip here (no duplicates)
                //   · manual bans are logged by the guildBanAdd event (extras.js)
                //   · manual kicks (by a human, outside the bot) → Wick-style
                //     Kick log with the audit executor as moderator
                //   · plain leave → the generic "Member Left" embed below
                const selfRemoval = removal && member.client?.user && removal.executor?.id === member.client.user.id;
                if (removal && (selfRemoval || removal.type === 'ban')) return;

                if (removal && removal.type === 'kick') {
                    const kickEmbed = modActionLogEmbed({
                        verb: 'Kick', color: 0xE74C3C,
                        target: member.user,
                        moderator: removal.executor,
                        reason: removal.reason,
                        extraFields: [membershipField(member)],
                    });
                    deps.sendLog(kickEmbed, 'moderation', null, member.guild.id);
                    return;
                }

                const daysSinceCreation = Math.floor((Date.now() - member.user.createdTimestamp) / 86400000);
                const membershipDuration = member.joinedAt
                    ? deps.formatUptime(Date.now() - member.joinedAt.getTime())
                    : '*Unknown*';

                const embed = new EmbedBuilder()
                    .setColor(0xE67E22)
                    .setAuthor({ name: member.user.tag, iconURL: member.user.displayAvatarURL() })
                    .setTitle('\uD83D\uDEAA Member Left')
                    .setDescription(member.user + ' left the server')
                    .setThumbnail(member.user.displayAvatarURL({ size: 128 }))
                    .addFields(
                        {
                            name: '\uD83D\uDD10 Account Info',
                            value: 'Created: <t:' + Math.floor(member.user.createdTimestamp / 1000) + ':R>'
                                + '\nAge: ' + daysSinceCreation + ' day' + (daysSinceCreation === 1 ? '' : 's'),
                        },
                        {
                            name: '\uD83D\uDC4B Membership',
                            value: 'Joined: ' + (member.joinedAt ? '<t:' + Math.floor(member.joinedAt.getTime() / 1000) + ':R>' : '*Unknown*')
                                + '\nWas here: ' + membershipDuration,
                            inline: true,
                        },
                        { name: '\uD83D\uDC65 Member Count', value: String(member.guild.memberCount), inline: true },
                        { name: '\uD83D\uDC64 User ID', value: member.user.id, inline: true },
                    )
                    .setFooter({ text: member.guild.name, iconURL: member.guild.iconURL() })
                    .setTimestamp();

                const roles = member.roles.cache
                    .filter(r => r.id !== r.guild.id)
                    .map(r => r.name);
                if (roles.length > 0) {
                    embed.addFields({ name: '\uD83C\uDFF7\uFE0F Roles (' + roles.length + ')', value: deps.truncate(roles.join(', '), 1024) });
                }

                deps.sendLog(embed, 'members', null, member.guild.id);
            },
        },
    ];



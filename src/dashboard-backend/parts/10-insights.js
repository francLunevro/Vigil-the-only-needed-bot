// ──────────────────── Part 10: Insights & real-time events ────────────────
// SSE event stream, activity timeline, multi-server analytics, aggregate
// stats, system info, the commands explorer, and per-server insights.

const os = require('os');
const { getDb } = require('../../db');
const { logError } = require('../../logError');
const { getGuildStats } = require('../../stats');
const { formatUptime } = require('../../helpers');
const { getClient } = require('../core');
const { logActivity, getActivity } = require('../../botActivity');

function register(app, ctx) {
    const { requireAuth, requireOwner, getScopedGuildIds, getLiveGuildScope } = ctx;

    // ── Bot Activity Timeline ──
    app.get('/api/activity/timeline', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.json([]);
        const days = Math.min(parseInt(req.query.days) || 7, 30);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const db = getDb();
        const events = db.prepare('SELECT * FROM bot_activity WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 1000').all(cutoff);
        // Activity rows carry their guild in the JSON payload. Scoped callers
        // only receive rows they can prove belong to a granted guild; rows with
        // no guild id are withheld (fail closed), the same rule the SSE stream
        // uses for scoped clients.
        const scoped = getScopedGuildIds(req);
        if (scoped === null) return res.json(events);
        res.json(events.filter((event) => {
            try {
                const data = JSON.parse(event.data || '{}');
                return data && data.guildId !== undefined && scoped.has(String(data.guildId));
            } catch {
                return false;
            }
        }));
    });

    // Kept for callers that reach the logger through the global (the writer
    // itself lives in src/botActivity.js so event handlers can require it).
    global.logBotActivity = logActivity;

    // ── Server Comparison / Multi-server Analytics ──
    app.get('/api/analytics/servers/compare', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.json([]);
        const metric = req.query.metric || 'members'; // members, joins, leaves, boosts, channels
        const limit = Math.min(parseInt(req.query.limit) || 10, 50);
        const scoped = getScopedGuildIds(req);
        const servers = client.guilds.cache.filter(g => scoped === null || scoped.has(String(g.id))).map(g => {
            const stats = getGuildStats(g.id);
            let value = g.memberCount;
            if (metric === 'joins') value = stats.totalJoins || 0;
            else if (metric === 'leaves') value = stats.totalLeaves || 0;
            else if (metric === 'boosts') value = g.premiumSubscriptionCount || 0;
            else if (metric === 'channels') value = g.channels.cache.size;
            else if (metric === 'growth') value = (stats.totalJoins || 0) - (stats.totalLeaves || 0);
            return { id: g.id, name: g.name, icon: g.iconURL({ size: 32 }), value };
        }).sort((a, b) => b.value - a.value).slice(0, limit);
        res.json({ metric, servers });
    });

    // ── Command Usage Heatmap ──
    app.get('/api/stats/commands/heatmap', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.json({});
        const days = Math.min(parseInt(req.query.days) || 7, 30);
        const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
        const db = getDb();
        const allRows = db.prepare('SELECT command, guild_id, COUNT(*) as count FROM command_usage WHERE used_at > ? GROUP BY command, guild_id ORDER BY count DESC LIMIT 500').all(cutoff);
        const scoped = getScopedGuildIds(req);
        const rows = scoped === null
            ? allRows
            : allRows.filter(r => scoped.has(String(r.guild_id)));
        const heatmap = {};
        for (const r of rows) {
            if (!heatmap[r.command]) heatmap[r.command] = {};
            heatmap[r.command][r.guild_id] = r.count;
        }
        res.json(heatmap);
    });

    // ── Aggregate Stats ──
    app.get('/api/stats/aggregate', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.json({});
        const scoped = getScopedGuildIds(req);
        const guilds = [...client.guilds.cache.values()]
            .filter(g => scoped === null || scoped.has(String(g.id)));
        const totalJoins = guilds.reduce((a, g) => a + (getGuildStats(g.id).totalJoins || 0), 0);
        const totalLeaves = guilds.reduce((a, g) => a + (getGuildStats(g.id).totalLeaves || 0), 0);
        const allSnapshots = [];
        guilds.forEach(g => {
            const s = getGuildStats(g.id);
            if (s.dailySnapshots) allSnapshots.push(...s.dailySnapshots);
        });
        const byDate = {};
        allSnapshots.forEach(s => {
            if (!byDate[s.date]) byDate[s.date] = { joins: 0, leaves: 0 };
            byDate[s.date].joins += s.joins;
            byDate[s.date].leaves += s.leaves;
        });
        const timeline = Object.entries(byDate)
            .sort(([a], [b]) => a.localeCompare(b))
            .slice(-30)
            .map(([date, d]) => ({ date, joins: d.joins, leaves: d.leaves, net: d.joins - d.leaves }));
        res.json({
            totalJoins, totalLeaves,
            netGrowth: totalJoins - totalLeaves,
            timeline,
            serverCount: guilds.length,
            totalMembers: guilds.reduce((a, g) => a + g.memberCount, 0),
        });
    });

    // ── Command Usage Stats ──
    app.get('/api/stats/commands', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.json({ top: [], total: 0, users: 0 });
        const db = getDb();
        try {
            const scoped = getScopedGuildIds(req);
            // The aggregate queries carry the same tenant boundary as the
            // per-server breakdown. An empty grant list must not fall through
            // to "no WHERE clause" and reveal every guild's usage.
            let where = '';
            let params = [];
            if (scoped !== null) {
                const ids = [...scoped].map(String);
                if (ids.length === 0) {
                    return res.json({ top: [], perServer: [], total: 0, users: 0 });
                }
                where = ' WHERE guild_id IN (' + ids.map(() => '?').join(',') + ')';
                params = ids;
            }
            // Overall top commands across the caller's servers
            const top = db.prepare('SELECT command, COUNT(*) as count, COUNT(DISTINCT guild_id) as servers FROM command_usage' + where + ' GROUP BY command ORDER BY count DESC LIMIT 20').all(...params);
            const total = db.prepare('SELECT COUNT(*) as total FROM command_usage' + where).get(...params);
            const users = db.prepare('SELECT COUNT(DISTINCT user_id) as users FROM command_usage' + where).get(...params);
            // Per-server breakdown for the top servers by usage. The scope goes
            // into the SQL, not a post-filter: slicing the global top 30 first
            // would let other guilds crowd a scoped caller's rows out entirely.
            const perServer = db.prepare('SELECT guild_id, command, COUNT(*) as count FROM command_usage' + where + ' GROUP BY guild_id, command ORDER BY count DESC LIMIT 30').all(...params);
            const enriched = perServer.map(r => ({
                guildName: client.guilds.cache.get(r.guild_id)?.name || r.guild_id,
                command: r.command, count: r.count,
            }));
            res.json({
                top: top.map(r => ({ command: r.command, count: r.count, servers: r.servers })),
                perServer: enriched,
                total: total ? total.total : 0,
                users: users ? users.users : 0,
            });
        } catch { res.json({ top: [], total: 0, users: 0 }); }
    });

    // ── Export Stats ──
    app.get('/api/stats/export', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.json({});
        const scoped = getScopedGuildIds(req);
        const exportData = {};
        client.guilds.cache.forEach(g => {
            if (scoped && !scoped.has(String(g.id))) return;
            const s = getGuildStats(g.id);
            exportData[g.id] = {
                name: g.name, memberCount: g.memberCount,
                totalJoins: s.totalJoins || 0, totalLeaves: s.totalLeaves || 0,
                dailySnapshots: (s.dailySnapshots || []).slice(-90),
            };
        });
        res.json({
            exportedAt: new Date().toISOString(),
            botName: client.user?.tag || 'Unknown',
            data: exportData,
        });
    });

    // ── Activity Feed ──
    // One row per recorded event, newest first. This used to invent a row per
    // guild from the all-time join counter with `time: Date.now()`, so a server
    // that had never recorded a join showed nothing at all, every row claimed to
    // have just happened, and leaves could never appear.
    app.get('/api/activity', requireAuth, (req, res) => {
        const limit = Math.min(parseInt(req.query.limit) || 50, 200);
        res.json(getActivity({ scopedGuildIds: getScopedGuildIds(req), limit }));
    });

    // ── System Info ──
    // Host vitals are not guild-scoped, so there is no safe way to show them to
    // a scoped dashboard user. Keep them behind the owner gate.
    app.get('/api/system', requireAuth, requireOwner, (req, res) => {
        const mem = process.memoryUsage();
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        res.json({
            platform: os.platform(), release: os.release(), hostname: os.hostname(),
            cpuModel: os.cpus()[0]?.model || 'Unknown', cpuCores: os.cpus().length,
            cpuLoad: os.loadavg(),
            memoryTotal: (totalMem / 1024 / 1024 / 1024).toFixed(2),
            memoryFree: (freeMem / 1024 / 1024 / 1024).toFixed(2),
            memoryUsed: ((totalMem - freeMem) / 1024 / 1024 / 1024).toFixed(2),
            memoryUsage: ((totalMem - freeMem) / totalMem * 100).toFixed(1),
            rss: (mem.rss / 1024 / 1024).toFixed(1),
            heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(1),
            heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(1),
            nodeVersion: process.version,
            uptime: formatUptime(process.uptime() * 1000),
        });
    });

    // ── Commands Explorer ──
    const COMMANDS_DATA = [
        { category:'Info', owner:false, commands:[
            { name:'help', description:'Show all available commands or get help with a specific one', usage:'/help [command] [category]' },
            { name:'ping', description:"Check the bot's latency", usage:'/ping' },
            { name:'status', description:"Show the bot's status, resources, and stats", usage:'/status' },
            { name:'botinfo', description:'Show information about this bot', usage:'/botinfo' },
            { name:'userinfo', description:"Get info about a user", usage:'/userinfo [user]' },
            { name:'avatar', description:"Get a user's avatar", usage:'/avatar [user]' },
            { name:'stats', description:'View server, growth, or command usage statistics', usage:'/stats server|growth|commands' },
        ]},
        { category:'Fun', owner:false, commands:[
            { name:'worldcup', description:'Predict a World Cup match score between two countries', usage:'/worldcup <team1> <team2>' },
            { name:'8ball', description:'Ask the magic 8-ball a question', usage:'/8ball <question>' },
            { name:'coinflip', description:'Flip a coin', usage:'/coinflip' },
            { name:'dice', description:'Roll a dice', usage:'/dice [sides]' },
            { name:'rps', description:'Play rock-paper-scissors', usage:'/rps <rock|paper|scissors>' },
            { name:'joke', description:'Get a random joke', usage:'/joke' },
            { name:'fact', description:'Get a random interesting fact', usage:'/fact' },
            { name:'advice', description:'Get a random piece of advice', usage:'/advice' },
            { name:'quote', description:'Get a random inspirational quote', usage:'/quote' },
            { name:'reverse', description:'Reverse some text', usage:'/reverse <text>' },
            { name:'mock', description:'Mock some text (Spongebob case)', usage:'/mock <text>' },
            { name:'random', description:'Generate a random number', usage:'/random <min> <max>' },
        ]},
        { category:'Reminders', owner:false, commands:[
            { name:'remindme', description:'Set a reminder (you will be DMed)', usage:'/remindme <time> <text>' },
            { name:'reminders', description:'Manage your reminders (list/cancel)', usage:'/reminders list|cancel' },
        ]},
        { category:'Admin', owner:true, commands:[
            { name:'role', description:'Manage roles (add/remove/list)', usage:'/role add|remove|list <user> [role]' },
            { name:'purge', description:'Bulk delete messages (1-100)', usage:'/purge <amount>' },
            { name:'slowmode', description:'Set channel slowmode (0-21600s)', usage:'/slowmode <seconds> [channel]' },
            { name:'nickname', description:"Change a user's nickname", usage:'/nickname <user> <nickname>' },
            { name:'say', description:'Make the bot say something', usage:'/say <channel> <message>' },
            { name:'embed', description:'Send an embedded message', usage:'/embed <channel> <title> [description] [color]' },
            { name:'deploy', description:'Re-register all slash commands', usage:'/deploy' },
            { name:'track', description:'Manage tracked channels (add/remove/list)', usage:'/track add|remove|list [channel]' },
            { name:'poll', description:'Create a poll', usage:'/poll <question> <opt1> <opt2> [opt3] [opt4]' },
            { name:'announce', description:'Send an announcement to a channel', usage:'/announce <channel> <title> <message>' },
        ]},
        { category:'Moderation', owner:true, commands:[
            { name:'kick', description:'Kick a member from the server', usage:'/kick <user> [reason]' },
            { name:'ban', description:'Ban a member from the server', usage:'/ban <user> [reason]' },
            { name:'unban', description:'Unban a user by their ID', usage:'/unban <user_id>' },
            { name:'timeout', description:'Timeout a member (60s-7d)', usage:'/timeout <user> <duration> [reason]' },
            { name:'untimeout', description:'Remove a timeout from a member', usage:'/untimeout <user>' },
            { name:'warn', description:'Warn a member', usage:'/warn <user> [reason]' },
            { name:'warnings', description:'View warnings for a member', usage:'/warnings <user>' },
            { name:'clearwarnings', description:'Clear all warnings for a member', usage:'/clearwarnings <user>' },
            { name:'lock', description:'Lock a channel', usage:'/lock [channel]' },
            { name:'unlock', description:'Unlock a channel', usage:'/unlock [channel]' },
            { name:'history', description:'View moderation history for a user', usage:'/history <user>' },
            { name:'case', description:'View details of a specific moderation case', usage:'/case <id>' },
            { name:'reason', description:'Update the reason for a moderation case', usage:'/reason <id> <text>' },
        ]},
        { category:'Config', owner:true, commands:[
            { name:'log', description:'Configure logging (channel/toggle/list)', usage:'/log channel|toggle|list' },
            { name:'embedconfig', description:'Configure embed appearance (footer/color/show)', usage:'/embedconfig footer|color|show' },
            { name:'presence', description:"Set the bot's activity status", usage:'/presence <type> <text>' },
            { name:'botavatar', description:"Change the bot's avatar", usage:'/botavatar <url>' },
            { name:'botname', description:"Change the bot's username", usage:'/botname <name>' },
            { name:'prefix', description:'View or change the command prefix', usage:'/prefix [new_prefix]' },
        ]},
        { category:'Permissions', owner:true, commands:[
            { name:'perm', description:'Manage user permissions for commands (grant/revoke/list/user)', usage:'/perm grant|revoke|list|user' },
        ]},
        { category:'Role Menus', owner:true, commands:[
            { name:'rolemenu', description:'Manage self-assignable role menus with dropdown select menus', usage:'/rolemenu create|add|remove|publish|list' },
        ]},
        { category:'Reaction Roles', owner:true, commands:[
            { name:'reactionrole', description:'Manage self-assignable reaction roles (add/remove/list)', usage:'/reactionrole add|remove|list' },
        ]},
        { category:'Auto-Mod', owner:true, commands:[
            { name:'automod', description:'Configure auto-moderation rules (spam/mentions/words/links/caps)', usage:'/automod config|list|filter|filters' },
        ]},
        { category:'Welcome / Goodbye', owner:true, commands:[
            { name:'welcome', description:'Configure welcome messages (channel/toggle/message/title/description/color/footer/thumbnail/image/author/show/test/reset)', usage:'/welcome <subcommand> [options]' },
            { name:'goodbye', description:'Configure goodbye messages (same subcommands as welcome)', usage:'/goodbye <subcommand> [options]' },
        ]},
        { category:'Invite Tracking', owner:true, commands:[
            { name:'invites', description:'Track invite codes and view who invited whom', usage:'/invites check [user] | top [limit] | stats' },
        ]},
        { category:'Staff Notes', owner:true, commands:[
            { name:'note', description:'Private staff notes on users (add/list/edit/remove)', usage:'/note add|list|edit|remove' },
        ]},
        { category:'Log Search', owner:true, commands:[
            { name:'logs', description:'Search stored deleted/edited messages, paged 5 at a time', usage:'/logs search [query] [user] [channel] [action] [limit]' },
        ]},
        { category:'Owner', owner:true, commands:[
            { name:'dashboard', description:'Get the link to the web dashboard', usage:'/dashboard' },
            { name:'dashaccess', description:'Manage who can access the dashboard (add/remove/list)', usage:'/dashaccess add|remove|list <user>' },
            { name:'server_leave', description:'Force the bot to leave a server by ID', usage:'/server_leave <server_id>' },
            { name:'shutdown', description:'Turn off the bot gracefully', usage:'/shutdown' },
        ]},
    ];

    app.get('/api/commands', requireAuth, (req, res) => {
        res.json(COMMANDS_DATA);
    });

    // ── SSE: Real-time events ──
    const sseClients = new Map();
    let acceptingStreams = true;

    function closeStream(res, destroy = false) {
        sseClients.delete(res);
        if (destroy) res.destroy();
        else res.end();
    }

    app.get('/api/events', requireAuth, (req, res) => {
        if (!acceptingStreams) return res.status(503).json({ error: 'Dashboard is shutting down' });
        const token = req.sessionToken;
        if (sseClients.size >= 128 || [...sseClients.values()].filter(value => value === token).length >= 8) {
            return res.status(429).json({ error: 'Too many event streams' });
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'X-Accel-Buffering': 'no',
        });
        res.on('close', () => sseClients.delete(res));
        sseClients.set(res, token);
        if (!res.write('data: {"type":"connected"}\n\n')) closeStream(res, true);
    });

    function sendToStreams(message, allowsDelivery) {
        const scopes = new Map();
        for (const [res, token] of sseClients) {
            try {
                if (!scopes.has(token)) scopes.set(token, getLiveGuildScope(token));
                const scope = scopes.get(token);
                if (scope === undefined) closeStream(res);
                else if (allowsDelivery(scope) && !res.write(message)) closeStream(res, true);
            } catch (err) {
                scopes.set(token, undefined);
                closeStream(res, true);
                logError(err, 'dashboard', 'event_stream');
            }
        }
    }

    const heartbeat = setInterval(() => sendToStreams(': heartbeat\n\n', () => true), 15000);
    heartbeat.unref();
    app.locals.stopEventStreams = () => {
        acceptingStreams = false;
        clearInterval(heartbeat);
        for (const res of sseClients.keys()) closeStream(res);
    };

    global.broadcastDashboard = function broadcastDashboard(type, data) {
        if (!sseClients.size) return;
        const guildId = data?.guildId === undefined || data.guildId === null ? null : String(data.guildId);
        const message = 'data: ' + JSON.stringify({ type, data, time: Date.now() }) + '\n\n';
        sendToStreams(message, scope => scope === null || (guildId !== null && scope.has(guildId)));
    };

    // ── Server Insights: Message activity ──
    app.get('/api/insights/:id', requireAuth, (req, res) => {
        const client = getClient();
        if (!client) return res.status(503).json({ error: 'Bot not ready' });
        const guild = client.guilds.cache.get(req.params.id);
        if (!guild) return res.status(404).json({ error: 'Server not found' });
        if (!ctx.canAccessGuild(req, req.params.id)) return res.status(403).json({ error: 'You do not have access to this server' });
        const db = getDb();
        // Top users by message count
        const topUsers = db.prepare('SELECT user_id, SUM(message_count) as total FROM activity_counts WHERE guild_id = ? GROUP BY user_id ORDER BY total DESC LIMIT 10').all(guild.id);
        // Top channels by message count
        const topChannels = db.prepare('SELECT channel_id, SUM(message_count) as total FROM activity_counts WHERE guild_id = ? GROUP BY channel_id ORDER BY total DESC LIMIT 10').all(guild.id);
        // Total tracked messages
        const totalTracked = db.prepare('SELECT SUM(message_count) as total FROM activity_counts WHERE guild_id = ?').get(guild.id);
        res.json({
            guildId: guild.id,
            guildName: guild.name,
            topUsers: topUsers.map(u => ({
                userId: u.user_id,
                total: u.total,
                tag: guild.members.cache.get(u.user_id)?.user?.tag || u.user_id,
                avatar: guild.members.cache.get(u.user_id)?.user?.displayAvatarURL({ size: 32 }) || null,
            })),
            topChannels: topChannels.map(c => ({
                channelId: c.channel_id,
                total: c.total,
                name: guild.channels.cache.get(c.channel_id)?.name || c.channel_id,
            })),
            totalTracked: totalTracked?.total || 0,
        });
    });
}

module.exports = { register };

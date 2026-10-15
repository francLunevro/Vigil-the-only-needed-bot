import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num } from '../lib.js';
import { Card, Grid, StatCard, PageHeader, ServerSelect, Skeleton, Empty } from '../components/ui.jsx';

export default function Insights() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/insights/' + serverId) : Promise.resolve(null)),
        [serverId]
    );

    const header = <PageHeader title="Insights" sub="Message activity per server" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Insights are tracked per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={5} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load insights" hint={error && error.message} />
            </>
        );
    }

    const topUsers = data.topUsers || [];
    const topChannels = data.topChannels || [];

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Grid cols={3}>
                <StatCard label="Messages Tracked" value={num(data.totalTracked)} sub={data.guildName} />
                <StatCard label="Active Chatters" value={num(topUsers.length)} sub="In the top list" />
                <StatCard label="Active Channels" value={num(topChannels.length)} sub="In the top list" />
            </Grid>

            <Grid cols={2} className="mt">
                <Card title="Top Chatters" icon="users">
                    {topUsers.length === 0
                        ? <Empty title="No activity data yet" hint="Messages must be tracked first." />
                        : (
                            <div className="rows">
                                {topUsers.map((u, i) => (
                                    <div className="dist" key={u.userId}>
                                        <span className="dist-rank">{['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
                                        {u.avatar
                                            ? <img className="dist-avatar" src={u.avatar} alt="" />
                                            : <span className="dist-avatar dist-avatar-fallback">{(u.tag || '?')[0]}</span>}
                                        <span className="dist-name">{u.tag || u.userId}</span>
                                        <span className="dist-count">{num(u.total)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>

                <Card title="Top Channels" icon="server">
                    {topChannels.length === 0
                        ? <Empty title="No channel data" />
                        : (
                            <div className="rows">
                                {topChannels.map((c, i) => (
                                    <div className="dist" key={c.channelId}>
                                        <span className="dist-rank">{i + 1}</span>
                                        <span className="dist-name">#{c.name}</span>
                                        <span className="dist-count">{num(c.total)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </Grid>
        </>
    );
}

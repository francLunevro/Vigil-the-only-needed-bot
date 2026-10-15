import { useMemo } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num, timeAgo } from '../lib.js';
import { Card, Grid, StatCard, PageHeader, ServerSelect, Skeleton, Empty, Badge } from '../components/ui.jsx';

// One colour per case type, matching the vanilla dashboard's palette.
const ACTION_COLORS = {
    warn: '#f1c40f', kick: '#e67e22', ban: '#ed4245', timeout: '#9b59b6',
    unban: '#3ba55c', tempban: '#e74c3c', lock: '#3498db', unlock: '#2ecc71',
    purge: '#95a5a6', temprole: '#5865f2', note: '#5865f2',
};
const actionColor = (action) => ACTION_COLORS[action] || '#5865f2';

export default function Moderation() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/modstats') : Promise.resolve(null)),
        [serverId]
    );

    const serverName = useMemo(() => {
        const s = (servers || []).find((x) => x.id === serverId);
        return s ? s.name : serverId;
    }, [servers, serverId]);

    const header = (
        <PageHeader title="Moderation" sub="Cases and stats across servers" onRefresh={reload} refreshing={loading} />
    );

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar">
                    <ServerSelect servers={servers} value={serverId} onChange={choose} />
                </div>
                <Empty title="Select a server" hint="Moderation stats are per-server." />
            </>
        );
    }

    if (loading && !data) {
        return <>{header}<Skeleton rows={5} /></>;
    }

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar">
                    <ServerSelect servers={servers} value={serverId} onChange={choose} />
                </div>
                <Empty title="Could not load moderation data" hint={error && error.message} />
            </>
        );
    }

    const byType = data.byType || [];
    const recent = data.recent || [];
    const topWarned = data.topWarned || [];

    return (
        <>
            {header}
            <div className="toolbar">
                <ServerSelect servers={servers} value={serverId} onChange={choose} />
            </div>

            <Grid cols={4}>
                <StatCard label="Total Cases" value={num(data.total)} sub={(data.active || 0) + ' active'} />
                <StatCard label="Case Types" value={num(byType.length)} sub="Unique action types" />
                <StatCard label="Server" value={<span className="stat-truncate">{serverName}</span>} sub="Selected" />
                <StatCard label="Recent" value={num(recent.length)} sub="Last 15 cases" />
            </Grid>

            <Grid cols={2} className="mt">
                <Card title="By Type" icon="shield">
                    {byType.length === 0
                        ? <Empty title="No actions recorded" />
                        : (
                            <div className="rows">
                                {byType.map((t) => (
                                    <div className="dist" key={t.action}>
                                        <span className="dist-dot" style={{ background: actionColor(t.action) }} />
                                        <span className="dist-name">{t.action}</span>
                                        <span className="dist-count">{num(t.count)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>

                <Card title="Most Warned Users" icon="alert">
                    {topWarned.length === 0
                        ? <Empty title="No warnings yet" />
                        : (
                            <div className="rows">
                                {topWarned.map((u, i) => (
                                    <div className="dist" key={u.userId}>
                                        <span className="dist-rank">{['🥇', '🥈', '🥉'][i] || (i + 1)}</span>
                                        <span className="dist-name">{u.tag || u.userId}</span>
                                        <span className="dist-count">{num(u.count)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </Grid>

            <div className="mt">
                <Card title="Recent Cases" icon="shield">
                    {recent.length === 0
                        ? <Empty title="No recent cases" hint="Moderation actions will appear here." />
                        : (
                            <div className="rows">
                                {recent.map((c) => (
                                    <div className="dist" key={c.id}>
                                        <Badge tone="default">{c.actionType}</Badge>
                                        <span className="dist-name">
                                            #{c.caseNumber} · {c.reason || 'No reason'}
                                        </span>
                                        <span className="dist-meta">
                                            {c.active ? 'Active' : 'Closed'} · by {(c.moderatorTag || 'unknown').split('#')[0]} · {timeAgo(c.createdAt)}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>
        </>
    );
}

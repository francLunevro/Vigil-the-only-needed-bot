import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num } from '../lib.js';
import { Card, PageHeader, ServerSelect, Empty, StatCard, Grid, Loaded } from '../components/ui.jsx';

// Invites mirrors the vanilla loadInvites(): a per-server leaderboard from
// GET /api/server/:id/invites — top inviters with join counts and bars.
const MEDALS = ['🥇', '🥈', '🥉'];

export default function Invites() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/invites') : Promise.resolve(null)),
        [serverId]
    );

    const header = <PageHeader title="Invites" sub="Invite tracking leaderboard" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Invite tracking must be enabled for the server." />
            </>
        );
    }

    const top = Array.isArray(data) ? data : [];
    const totalJoins = top.reduce((a, r) => a + (Number(r.count) || 0), 0);
    const maxCount = top.length ? Math.max(...top.map((r) => Number(r.count) || 0)) : 0;

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            {top.length > 0 && (
                <Grid cols={3}>
                    <StatCard label="Tracked inviters" value={num(top.length)} sub="With at least one join" />
                    <StatCard label="Tracked joins" value={num(totalJoins)} sub="Attributed via invites" tone="good" />
                    <StatCard label="Top inviter" value={String(top[0].count)} sub={(top[0].tag || top[0].inviterId || 'Unknown').slice(0, 30)} />
                </Grid>
            )}

            <Card title="Leaderboard" icon="users" className={top.length ? 'mt' : ''}>
                <Loaded error={error} loading={loading && !data} empty={top.length === 0} rows={6}
                    errorTitle="Could not load invites"
                    emptyHint="No invite data yet — invite tracking must be enabled. Use “track add” in a channel to start tracking.">
                    <div className="rows">
                        {top.map((inv, i) => {
                            const name = (inv.tag || inv.inviterId || 'Unknown').slice(0, 30);
                            const pct = Math.max(4, ((Number(inv.count) || 0) / maxCount) * 100);
                            return (
                                <div className="rank-row" key={inv.inviterId || i}>
                                    <span className="rank-medal">{MEDALS[i] || (i + 1) + '.'}</span>
                                    <span className="rank-name">{name}</span>
                                    <span className="rank-count">{num(inv.count)} joins</span>
                                    <div className="rank-track">
                                        <div className="rank-fill" style={{ width: pct + '%' }} />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </Loaded>
            </Card>
        </>
    );
}

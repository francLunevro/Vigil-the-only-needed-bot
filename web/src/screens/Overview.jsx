import { useCallback, useEffect } from 'react';
import { api } from '../api.js';
import { useAsync, num, mb, signed } from '../lib.js';
import { useLiveReload } from '../live.jsx';
import { Card, Grid, StatCard, PageHeader, Skeleton, Empty, Loaded } from '../components/ui.jsx';

// Overview mirrors the vanilla `loadOv()`: status, reminders and aggregate,
// refreshed together on one cadence. Each source fails on its own: only
// /api/status decides whether the whole page renders, while a broken reminders
// or aggregate read blanks just the cards that read it.
//
// Two saved dashboard settings are consumed here (Customize → Save):
//   • refreshInterval — poll cadence for the live cards
//   • showWidgets     — which of the overview cards render at all
// The config endpoint is owner-only, so non-owners get the defaults
// (5 seconds, every widget visible) by treating a failed fetch as null.
export default function Overview() {
    const { data: config } = useAsync(() => api.get('/api/dash/config').catch(() => null), []);
    const statusReq = useAsync(() => api.get('/api/status'), []);
    const remindersReq = useAsync(() => api.get('/api/reminders'), []);
    const aggregateReq = useAsync(() => api.get('/api/stats/aggregate'), []);

    const reloadAll = useCallback(() => {
        statusReq.reload();
        remindersReq.reload();
        aggregateReq.reload();
    }, [statusReq.reload, remindersReq.reload, aggregateReq.reload]);

    // Poll on the configured cadence. reload keeps previous data while a poll
    // is in flight, so the header spinner is limited to the initial load.
    const interval = Math.max(3, (config && parseInt(config.refreshInterval)) || 5);
    useEffect(() => {
        const t = setInterval(reloadAll, interval * 1000);
        return () => clearInterval(t);
    }, [interval, reloadAll]);

    // Live events (joins/leaves etc.) trigger an immediate refresh on top of
    // the poll — same pair vanilla ran (loadOv + loadAn per event).
    useLiveReload(reloadAll);

    if (statusReq.loading && !statusReq.data) return <Skeleton rows={6} />;

    if (statusReq.error) {
        return (
            <>
                <PageHeader title="Overview" onRefresh={reloadAll} />
                <Empty title="Overview data unavailable" hint="The bot may be reconnecting. Try refreshing in a moment." />
            </>
        );
    }

    const status = statusReq.data;
    const reminders = remindersReq.data;
    const agg = aggregateReq.data;
    const totals = agg || {};
    const online = status && status.online;
    const pendingReminders = Array.isArray(reminders) ? reminders.length : null;
    const net = totals.netGrowth || 0;

    // Widget visibility (vanilla's Visible Sections toggles). quickActions
    // and activity have no React counterpart yet, so they are not consulted.
    const widgets = (config && config.showWidgets) || {};
    const show = (k) => widgets[k] !== false;
    const showSummary = show('reminders') || show('analytics') || show('servers');

    return (
        <>
            <PageHeader
                title="Overview"
                sub={online ? status.username + ' · ' + status.status : 'Bot offline'}
                onRefresh={reloadAll}
                refreshing={statusReq.loading && !status}
            />

            {show('status') && (
                <Grid cols={4}>
                    <StatCard
                        label="Connection"
                        value={online ? (status.ping + ' ms') : 'Offline'}
                        sub={online ? status.status : 'Waiting for gateway'}
                        tone={online ? 'good' : 'bad'}
                    />
                    <StatCard label="Uptime" value={online ? status.uptime : '—'} sub="Since last restart" />
                    {show('servers') && <StatCard label="Servers" value={online ? num(status.servers) : '—'} sub="Connected" />}
                    <StatCard label="Members" value={online ? num(status.users) : '—'} sub="Across all servers" />
                </Grid>
            )}

            {showSummary && (
                <Grid cols={3} className="mt">
                    {show('reminders') && (
                        <StatCard label="Pending Reminders" value={pendingReminders === null ? '—' : num(pendingReminders)}
                            sub={remindersReq.error ? 'Couldn’t load' : 'Across all users'} />
                    )}
                    {show('analytics') && (
                        <StatCard label="Total Growth" value={agg ? signed(net) : '—'}
                            sub={aggregateReq.error ? 'Couldn’t load' : 'Net member change'}
                            tone={agg ? (net >= 0 ? 'good' : 'bad') : undefined} />
                    )}
                    {show('servers') && <StatCard label="Active Servers" value={num(status && status.servers)} sub="Connected" />}
                </Grid>
            )}

            {(show('status') || show('analytics')) && (
                <Grid cols={2} className="mt">
                    {show('status') && (
                        <Card title="Process" icon="server">
                            <div className="kv">
                                <span>Memory (RSS)</span><strong>{online ? mb(status.memory) : '—'}</strong>
                            </div>
                            <div className="kv">
                                <span>Heap used</span><strong>{online ? mb(status.heapUsed) : '—'}</strong>
                            </div>
                            <div className="kv">
                                <span>Node</span><strong>{online ? status.nodeVersion : '—'}</strong>
                            </div>
                            <div className="kv">
                                <span>Version</span><strong>{online ? ('v' + status.version) : '—'}</strong>
                            </div>
                        </Card>
                    )}

                    {show('analytics') && (
                        <Card title="Growth totals" icon="chart">
                            <Loaded error={aggregateReq.error} loading={aggregateReq.loading && !agg} empty={false}
                                errorTitle="Growth totals unavailable">
                                <div className="kv"><span>Total joins</span><strong>{num(totals.totalJoins)}</strong></div>
                                <div className="kv"><span>Total leaves</span><strong>{num(totals.totalLeaves)}</strong></div>
                                <div className="kv"><span>Net growth</span><strong>{signed(net)}</strong></div>
                                <div className="kv"><span>Total members</span><strong>{num(totals.totalMembers)}</strong></div>
                            </Loaded>
                        </Card>
                    )}
                </Grid>
            )}
        </>
    );
}

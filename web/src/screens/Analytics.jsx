import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, num, signed, downloadJson, todayStamp } from '../lib.js';
import { Card, Grid, StatCard, PageHeader, Skeleton, Empty, Button } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// A smooth-ish SVG joins/leaves chart. Same data as the vanilla chart, rebuilt
// as a React component instead of an innerHTML string. Exported because the
// per-server view draws the identical chart from that server's own snapshots
// (same shape: { date, joins, leaves }).
export function GrowthChart({ timeline }) {
    if (!timeline || timeline.length < 2) {
        return <Empty title="Not enough history yet" hint="Growth snapshots accumulate daily." />;
    }

    const W = 640;
    const H = 200;
    const PAD = 24;
    const max = Math.max(1, ...timeline.map((d) => Math.max(d.joins || 0, d.leaves || 0)));
    const x = (i) => PAD + (i / (timeline.length - 1)) * (W - PAD * 2);
    const y = (v) => H - PAD - ((v || 0) / max) * (H - PAD * 2);

    const line = (key) => timeline.map((d, i) => x(i) + ',' + y(d[key])).join(' ');
    const area = (key) => line(key) + ' ' + x(timeline.length - 1) + ',' + (H - PAD) + ' ' + x(0) + ',' + (H - PAD);

    return (
        <svg viewBox={'0 0 ' + W + ' ' + H} className="chart" preserveAspectRatio="none">
            <defs>
                <linearGradient id="joinFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#30d158" stopOpacity="0.22" />
                    <stop offset="100%" stopColor="#30d158" stopOpacity="0.01" />
                </linearGradient>
                <linearGradient id="leaveFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ff453a" stopOpacity="0.14" />
                    <stop offset="100%" stopColor="#ff453a" stopOpacity="0.01" />
                </linearGradient>
            </defs>
            <polygon points={area('joins')} fill="url(#joinFill)" />
            <polygon points={area('leaves')} fill="url(#leaveFill)" />
            <polyline points={line('joins')} fill="none" stroke="#30d158" strokeWidth="2" />
            <polyline points={line('leaves')} fill="none" stroke="#ff453a" strokeWidth="1.5" opacity="0.7" />
        </svg>
    );
}

export default function Analytics() {
    const toast = useToast();
    const { data, loading, error, reload } = useAsync(
        () => Promise.all([
            api.get('/api/stats/aggregate').catch(() => ({})),
            api.get('/api/stats/commands').catch(() => ({ top: [] })),
        ]),
        []
    );
    const [exporting, setExporting] = useState(false);

    // The API answers with the growth payload itself; the file is built in the
    // browser, same as the vanilla exporter (growth-data-YYYY-MM-DD.json).
    async function exportStats() {
        setExporting(true);
        try {
            const payload = await api.get('/api/stats/export');
            downloadJson(payload, 'growth-data-' + todayStamp() + '.json');
            toast('Data exported!');
        } catch (err) {
            toast(err.message || 'Export failed', true);
        } finally {
            setExporting(false);
        }
    }

    if (loading && !data) return <Skeleton rows={6} />;
    if (error) {
        return (
            <>
                <PageHeader title="Analytics" onRefresh={reload} />
                <Empty title="Analytics unavailable" hint="The bot may still be starting up." />
            </>
        );
    }

    const [agg, usage] = data;
    const top = (usage && usage.top) || [];
    const maxCount = Math.max(1, ...top.map((c) => c.count || 0));

    return (
        <>
            <PageHeader title="Analytics" sub="Member growth and command usage" onRefresh={reload} refreshing={loading} />

            <Grid cols={3}>
                <StatCard label="Total Joins" value={num(agg.totalJoins)} tone="good" />
                <StatCard label="Total Leaves" value={num(agg.totalLeaves)} tone="bad" />
                <StatCard label="Net Growth" value={signed(agg.netGrowth)} tone={(agg.netGrowth || 0) >= 0 ? 'good' : 'bad'} />
            </Grid>

            <div className="row-actions mt">
                <Button variant="ghost" icon="download" onClick={exportStats} disabled={exporting}>
                    {exporting ? 'Exporting…' : 'Export data'}
                </Button>
                <span className="hint">Member growth and per-server totals as JSON.</span>
            </div>

            <div className="mt">
                <Card title="Member Growth (last 30 days)" icon="chart">
                    <GrowthChart timeline={agg.timeline} />
                </Card>
            </div>

            <div className="mt">
                <Card title={'Command Usage — top ' + top.length} icon="terminal">
                    {top.length === 0
                        ? <Empty title="No command usage recorded yet" hint="Usage is tracked as commands run." />
                        : (
                            <div className="bars">
                                {top.map((c) => (
                                    <div className="bar-row" key={c.command}>
                                        <span className="bar-name">/{c.command}</span>
                                        <span className="bar-track">
                                            <span className="bar-fill" style={{ width: (c.count / maxCount * 100) + '%' }} />
                                        </span>
                                        <span className="bar-count">{num(c.count)}</span>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>

            <Grid cols={2} className="mt">
                <StatCard label="Total Commands Run" value={num(usage && usage.total)} />
                <StatCard label="Unique Users" value={num(usage && usage.users)} />
            </Grid>
        </>
    );
}

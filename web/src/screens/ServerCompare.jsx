import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, num } from '../lib.js';
import { Card, PageHeader, Skeleton, Empty, Select, Badge } from '../components/ui.jsx';

const METRICS = [
    { value: 'members', label: 'Members' },
    { value: 'growth', label: 'Net growth' },
    { value: 'joins', label: 'Joins' },
    { value: 'leaves', label: 'Leaves' },
    { value: 'boosts', label: 'Boosts' },
    { value: 'channels', label: 'Channels' },
];

export default function ServerCompare() {
    const [metric, setMetric] = useState('members');
    const [limit, setLimit] = useState(10);

    const { data, loading, error, reload } = useAsync(
        () => api.get('/api/analytics/servers/compare?metric=' + metric + '&limit=' + limit),
        [metric, limit]
    );

    if (loading && !data) return <Skeleton rows={5} />;

    const servers = (data && data.servers) || [];
    const max = Math.max(1, ...servers.map((s) => Math.abs(s.value || 0)));

    return (
        <>
            <PageHeader title="Server Comparison" sub="Rank servers by a single metric" onRefresh={reload} refreshing={loading} />

            <div className="toolbar">
                <Select value={metric} onChange={(e) => setMetric(e.target.value)} style={{ maxWidth: 200 }}>
                    {METRICS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </Select>
                <Select value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ maxWidth: 150 }}>
                    <option value="5">Top 5</option>
                    <option value="10">Top 10</option>
                    <option value="25">Top 25</option>
                    <option value="50">Top 50</option>
                </Select>
            </div>

            {error && <Empty title="Couldn’t load comparison" />}
            {!error && servers.length === 0 && <Empty title="No servers to compare" />}

            {servers.length > 0 && (
                <Card title={'Ranked by ' + metric} icon="chart">
                    <div className="rows">
                        {servers.map((s, i) => (
                            <div className="dist" key={s.id}>
                                <span className="dist-rank">{i + 1}</span>
                                {s.icon
                                    ? <img className="dist-avatar" src={s.icon} alt="" />
                                    : <span className="dist-avatar dist-avatar-fallback">{(s.name || '?')[0]}</span>}
                                <span className="dist-name">
                                    {s.name}
                                    <span className="bar-track" style={{ display: 'block', marginTop: 6 }}>
                                        <span className="bar-fill" style={{ width: (Math.abs(s.value || 0) / max * 100) + '%' }} />
                                    </span>
                                </span>
                                <Badge>{num(s.value)}</Badge>
                            </div>
                        ))}
                    </div>
                </Card>
            )}
        </>
    );
}

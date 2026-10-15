import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, timeAgo } from '../lib.js';
import { Card, PageHeader, Skeleton, Empty, Select } from '../components/ui.jsx';

const ICONS = { command: '⌨️', event: '⚡', error: '⚠️', mod: '🛡️', join: '📥', leave: '📤' };

// The timeline stores a JSON `data` blob per row. Render a compact, readable
// summary of whichever keys the emitter included.
function summarize(data) {
    if (!data) return '';
    let parsed = data;
    if (typeof data === 'string') {
        try { parsed = JSON.parse(data); } catch { return data; }
    }
    if (!parsed || typeof parsed !== 'object') return String(parsed);
    return Object.entries(parsed)
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .slice(0, 4)
        .map(([k, v]) => k + ': ' + (typeof v === 'object' ? JSON.stringify(v) : v))
        .join(' · ');
}

export default function BotActivity() {
    const [days, setDays] = useState(7);
    const [type, setType] = useState('');
    const { data, loading, error, reload } = useAsync(
        () => api.get('/api/activity/timeline?days=' + days),
        [days]
    );

    const events = (Array.isArray(data) ? data : []).filter((e) => !type || e.type === type);
    const types = Array.from(new Set((Array.isArray(data) ? data : []).map((e) => e.type).filter(Boolean))).sort();

    if (loading && !data) return <Skeleton rows={6} />;

    return (
        <>
            <PageHeader title="Bot Activity" sub="Event-by-event history captured by the bot" onRefresh={reload} refreshing={loading} />

            <div className="toolbar">
                <Select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ maxWidth: 170 }}>
                    <option value="1">Last 24 hours</option>
                    <option value="7">Last 7 days</option>
                    <option value="30">Last 30 days</option>
                </Select>
                <Select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 190 }}>
                    <option value="">All types</option>
                    {types.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
            </div>

            {error && <Empty title="Couldn’t load activity" />}
            {!error && events.length === 0 && <Empty title="No activity found" hint="Events are recorded as the bot runs." />}

            {events.length > 0 && (
                <Card title={'Events (' + events.length + ')'} icon="pulse">
                    <div className="rows">
                        {events.map((e) => (
                            <div className="dist" key={e.id}>
                                <span className="dist-ico">{ICONS[e.type] || '📌'}</span>
                                <span className="dist-name">
                                    <strong>{e.type}</strong>
                                    {summarize(e.data) && <span className="sub"> · {summarize(e.data)}</span>}
                                </span>
                                <span className="dist-meta">{timeAgo(e.timestamp)}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            )}
        </>
    );
}

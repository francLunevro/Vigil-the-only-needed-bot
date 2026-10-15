import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, timeAgo } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Select, Badge, Button, Loaded } from '../components/ui.jsx';

const TYPES = [
    { value: 'all', label: 'All events' },
    { value: 'discord', label: 'Discord audit' },
    { value: 'moderation', label: 'Moderation' },
    { value: 'messages', label: 'Messages' },
    { value: 'members', label: 'Members' },
];

// ──────────────────── Dashboard activity (audit trail) ────────────────────
// The dashboard's OWN who-changed-what log — the audit_trail table behind
// /api/audit-trail. This is deliberately a different thing from the Discord
// audit feed above, which comes from Discord's own audit log.
//
// The route is owner-only server-side, so a scoped user just gets the API's
// refusal rendered in the empty state: nothing here decides permissions.
//
// Vanilla had this panel's markup nowhere in index.html and never called its
// loader, so this is the first reachable version of it — the glyph/colour per
// type and the details key/value chips follow the renderer vanilla wrote.

const TRAIL_LIMIT = 100;

function trailLook(type) {
    if (type === 'config') return { glyph: '⚙️', color: '#3ba55c' };
    if (type === 'mod') return { glyph: '🛡️', color: '#ed4245' };
    return { glyph: '⚙️', color: 'var(--accent)' };
}

// `details` is a JSON blob in the table. A malformed one must cost us the chips,
// not the whole row.
function detailPairs(raw) {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? Object.entries(parsed) : [];
    } catch {
        return [];
    }
}

function DashboardTrail() {
    const [type, setType] = useState('');
    const query = '/api/audit-trail?limit=' + TRAIL_LIMIT
        + (type ? '&type=' + encodeURIComponent(type) : '');
    const { data, loading, error, reload } = useAsync(() => api.get(query), [type]);

    // The filter's vocabulary is read off the unfiltered page instead of a
    // hard-coded list: no writer fills this table yet, so a fixed set of type
    // names would be a guess that silently hides anything new.
    const [types, setTypes] = useState([]);
    useEffect(() => {
        if (type || !data) return;
        setTypes([...new Set((data.trails || []).map((t) => t.type).filter(Boolean))]);
    }, [data, type]);

    const trails = (data && data.trails) || [];

    return (
        <Card title={'Dashboard activity' + (trails.length ? ' (' + trails.length + ')' : '')} icon="pulse"
            action={<Button variant="ghost" onClick={reload}>Refresh</Button>}>
            <div className="toolbar">
                <Select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 190 }}>
                    <option value="">All types</option>
                    {types.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
            </div>
            <p className="hint">
                Changes made through this dashboard, newest first. Separate from the Discord audit log above.
            </p>

            <Loaded error={error} loading={loading && !data} empty={trails.length === 0} rows={4}
                errorTitle="Dashboard activity unavailable"
                emptyHint="No audit trail entries found — entries appear here once the dashboard records a change.">
                <div className="rows">
                    {trails.map((t) => {
                        const look = trailLook(t.type);
                        const pairs = detailPairs(t.details);
                        return (
                            <div className="audit-row" key={t.id}>
                                <span className="audit-ico" style={{ color: look.color }}>{look.glyph}</span>
                                <div className="audit-body">
                                    <div className="audit-h">
                                        <strong>{t.action}</strong>
                                        {t.type && <Badge>{t.type}</Badge>}
                                        <span className="row-time">{timeAgo(t.created_at)}</span>
                                    </div>
                                    <div className="sub">
                                        {t.user_tag || ''}
                                        {t.user_tag && t.guild_id ? ' · ' : ''}
                                        {t.guild_id ? 'server ' + t.guild_id : ''}
                                    </div>
                                    {pairs.length > 0 && (
                                        <div className="chips mt">
                                            {pairs.map(([k, v]) => (
                                                <span className="chip" key={k}>
                                                    <span className="mono">{k}</span>{' '}
                                                    {typeof v === 'string' ? v : JSON.stringify(v)}
                                                </span>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            </Loaded>
        </Card>
    );
}

export default function AuditLog() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const [type, setType] = useState('all');

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/auditlog?type=' + type + '&limit=60') : Promise.resolve(null)),
        [serverId, type]
    );

    // The Discord feed is per-server; the dashboard trail below is bot-wide, so
    // the toolbar and the trail stay mounted in every state instead of the feed
    // short-circuiting the screen.
    let feed;
    if (!serverId) {
        feed = <Empty title="Select a server" hint="Audit entries are fetched per server." />;
    } else if (loading && !data) {
        feed = <Skeleton rows={6} />;
    } else if (error || !data) {
        feed = <Empty title="Could not load the audit log" hint={error && error.message} />;
    } else {
        const entries = (Array.isArray(data) ? data : []).filter((e) => e.type);
        feed = (
            <Card title={'Events (' + entries.length + ')'} icon="pulse">
                {entries.length === 0
                    ? <Empty title="No audit entries" hint="Events appear as moderation actions, message edits and member changes are recorded." />
                    : (
                        <div className="rows">
                            {entries.map((e) => (
                                <div className="audit-row" key={e.id}>
                                    <span className="audit-ico">{e.icon || '🔵'}</span>
                                    <div className="audit-body">
                                        <div className="audit-h">
                                            <strong>{e.type}</strong>
                                            {e.source && <Badge>{e.source}</Badge>}
                                            <span className="row-time">{timeAgo(e.timestamp)}</span>
                                        </div>
                                        <div className="sub">
                                            {e.executorTag ? 'by ' + e.executorTag : ''}
                                            {e.targetTag ? ' → ' + e.targetTag : ''}
                                            {e.reason ? ' · ' + e.reason : ''}
                                        </div>
                                        {e.changes && e.changes.length > 0 && (
                                            <div className="chips mt">
                                                {e.changes.map((c, i) => (
                                                    <span className="chip" key={i}>
                                                        <span className="mono">{c.key}</span>
                                                        {c.old ? ' ' + c.old + ' → ' : ' → '}{c.new}
                                                    </span>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
            </Card>
        );
    }

    return (
        <>
            <PageHeader title="Audit Log" sub="Unified feed from Discord, moderation, messages and members"
                onRefresh={reload} refreshing={loading} />
            <div className="toolbar">
                <ServerSelect servers={servers} value={serverId} onChange={choose} />
                <Select value={type} onChange={(e) => setType(e.target.value)} style={{ maxWidth: 190 }}>
                    {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </Select>
            </div>
            {feed}
            <div className="mt">
                <DashboardTrail />
            </div>
        </>
    );
}

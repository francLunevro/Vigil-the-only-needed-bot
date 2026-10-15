import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, useTextChannels, num, timeAgo } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Select, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

const ACTIONS = [
    { value: '', label: 'All actions' },
    { value: 'deleted', label: 'Deleted' },
    { value: 'edited', label: 'Edited' },
];

export default function Logging() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const detail = useAsync(() => (serverId ? api.get('/api/server/' + serverId) : Promise.resolve(null)), [serverId]);
    const { data: channels } = useTextChannels(serverId);
    const [draft, setDraft] = useState(null);

    // Message-log search state
    const [query, setQuery] = useState('');
    const [action, setAction] = useState('');
    const [results, setResults] = useState(null);
    const [searching, setSearching] = useState(false);

    // Re-seed the editable copy from every fresh detail. A failed load arrives
    // with no data, which clears the copy so stale categories can't outlive it.
    useEffect(() => {
        const logging = detail.data && detail.data.logging;
        setDraft(logging ? JSON.parse(JSON.stringify(logging)) : null);
    }, [detail.data]);

    const header = <PageHeader title="Logging" sub="Route the 18 log categories and search stored messages"
        onRefresh={() => { setDraft(null); detail.reload(); }} refreshing={detail.loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Log routing is per server." />
            </>
        );
    }

    if (detail.error) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load log settings" hint={detail.error.message} />
            </>
        );
    }

    if (detail.loading && !detail.data) return <>{header}<Skeleton rows={6} /></>;
    if (!draft) return <>{header}<Skeleton rows={6} /></>;

    const categories = Object.keys(draft.perCategory);

    function setCat(name, patch) {
        setDraft((prev) => ({ ...prev, perCategory: { ...prev.perCategory, [name]: { ...prev.perCategory[name], ...patch } } }));
    }

    async function saveAll() {
        const categories2 = categories.map((c) => ({
            category: c,
            channelId: draft.perCategory[c].channel || null,
            enabled: !!draft.perCategory[c].enabled,
        }));
        try {
            await api.post('/api/server/' + serverId + '/log/config/batch', { categories: categories2 });
            toast('Log settings saved');
            detail.reload();
        } catch (err) {
            toast(err.message || 'Could not save', true);
        }
    }

    async function track(channelId, mode) {
        try {
            await api.post('/api/server/' + serverId + '/log/config', { trackedChannel: channelId || null, trackedChannels: mode });
            toast('Tracked channels updated');
            setDraft(null);
            detail.reload();
        } catch (err) {
            toast(err.message || 'Could not update', true);
        }
    }

    async function search() {
        setSearching(true);
        try {
            const qs = new URLSearchParams();
            if (query.trim()) qs.set('q', query.trim());
            if (action) qs.set('action', action);
            qs.set('limit', '50');
            const rows = await api.get('/api/server/' + serverId + '/messages?' + qs.toString());
            setResults(Array.isArray(rows) ? rows : []);
        } catch (err) {
            toast(err.message || 'Search failed', true);
        } finally {
            setSearching(false);
        }
    }

    const tracked = draft.trackedChannels || [];

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Card title={'Log categories (' + categories.length + ')'} icon="pulse"
                action={<Button onClick={saveAll}>Save all</Button>}>
                <div className="rows">
                    {categories.map((c) => (
                        <div className="log-row" key={c}>
                            <input type="checkbox" checked={draft.perCategory[c].enabled !== false}
                                onChange={(e) => setCat(c, { enabled: e.target.checked })} title="Enabled" />
                            <span className="log-name">{c}</span>
                            <Select value={draft.perCategory[c].channel || ''}
                                onChange={(e) => setCat(c, { channel: e.target.value || null })}>
                                <option value="">Default channel</option>
                                {(channels || []).map((ch) => <option key={ch.id} value={ch.id}>#{ch.name}</option>)}
                            </Select>
                        </div>
                    ))}
                </div>
                <p className="hint">Uncheck to mute a category. Leave the channel on “Default” to use the server’s default log channel.</p>
            </Card>

            <div className="mt">
                <Card title={'Tracked channels (' + num(tracked.length) + ')'} icon="server">
                    <p className="hint" style={{ marginTop: 0 }}>Messages in tracked channels are indexed for the search below.</p>
                    {tracked.length === 0
                        ? <p className="hint">None tracked.</p>
                        : (
                            <div className="chips">
                                {tracked.map((id) => (
                                    <span className="chip" key={id}>
                                        #{(channels || []).find((c) => c.id === id)?.name || id}
                                        <button className="chip-x" onClick={() => track(id, 'remove')} title="Stop tracking">×</button>
                                    </span>
                                ))}
                            </div>
                        )}
                    <div className="form-row mt">
                        <Select defaultValue="" onChange={(e) => { if (e.target.value) track(e.target.value, 'add'); }}>
                            <option value="">Add a channel…</option>
                            {(channels || []).filter((c) => !tracked.includes(c.id)).map((c) => (
                                <option key={c.id} value={c.id}>#{c.name}</option>
                            ))}
                        </Select>
                        <Button variant="ghost" onClick={() => track(null, 'clear')} disabled={tracked.length === 0}>Clear all</Button>
                    </div>
                </Card>
            </div>

            <div className="mt">
                <Card title="Message log search" icon="terminal">
                    <div className="form-row">
                        <Input placeholder="Search deleted or edited message content…" value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
                        <Select value={action} onChange={(e) => setAction(e.target.value)} style={{ maxWidth: 170 }}>
                            {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                        </Select>
                        <Button onClick={search} disabled={searching}>{searching ? 'Searching…' : 'Search'}</Button>
                    </div>

                    {results && results.length === 0 && <Empty title="No matching messages" hint="Only tracked channels are indexed." />}
                    {results && results.length > 0 && (
                        <div className="rows mt">
                            {results.map((m) => (
                                <div className="dist" key={m.id}>
                                    <Badge tone={m.action === 'deleted' ? 'bad' : 'warn'}>{m.action}</Badge>
                                    <span className="dist-name">
                                        <strong>{m.authorTag}</strong> in #{m.channelName}
                                        <span className="sub"> · {m.content}</span>
                                    </span>
                                    <span className="dist-meta">{timeAgo(m.loggedAt)}</span>
                                </div>
                            ))}
                        </div>
                    )}
                </Card>
            </div>
        </>
    );
}

import { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServerSelection, num, signed } from '../lib.js';
import { Card, Grid, StatCard, Skeleton, Empty, Badge, Icon, Input } from '../components/ui.jsx';
import { GrowthChart } from './Analytics.jsx';
import ServerModTools from './ServerModTools.jsx';
import ServerSettings from './ServerSettings.jsx';

const TIERS = ['', 'Tier 1', 'Tier 2', 'Tier 3'];

// Tabs that render in place inside this view. Their data comes from the
// per-server endpoints the vanilla hub's management panes used.
const TABS = [
    { id: 'overview', label: 'Overview' },
    { id: 'roles', label: 'Roles' },
    { id: 'channels', label: 'Channels' },
    { id: 'modtools', label: 'Mod Tools' },
    { id: 'settings', label: 'Settings' },
];

// Capabilities that already have their own React screen. The tab bar links to
// them (carrying the server across) instead of re-implementing each one here,
// so there is exactly one implementation of log routing, the audit trail and
// greeting editors to keep working.
const LINK_TABS = [
    { id: 'logging', label: 'Logging' },
    { id: 'auditlog', label: 'Audit Log' },
    { id: 'greetings', label: 'Greetings' },
];

// camelCase permission flags out of the API ("ManageGuild") read as words.
function prettyPerm(name) {
    return String(name).replace(/([a-z])([A-Z])/g, '$1 $2');
}

// Small shared row-list behaviour: client-side filter over already-fetched
// rows, so neither tab needs a query parameter the API doesn't offer.
function matches(text, query) {
    return String(text || '').toLowerCase().includes(query);
}
// A failure has to carry the server it is about. useAsync keeps the previous
// error while the next request is in flight, so an untagged one would let the
// last server's message paint under the newly opened server's id.
function tagError(err, forId) {
    const tagged = (err && typeof err === 'object') ? err : new Error(String(err));
    tagged.forId = forId;
    return tagged;
}

// Failure body shared by the per-server tabs. The API's own message is shown
// as-is (it is the truthful account of what failed) and the permission guidance
// vanilla's panes always carried follows it — the server cannot know whether
// permissions are the cause, so both statements belong on screen rather than
// one silently replacing the other.
function TabError({ title, error, guidance, onRetry }) {
    const message = (error && error.message) || guidance;
    return (
        <>
            <Empty title={title} hint={message} />
            {message !== guidance && <p className="hint">{guidance}</p>}
            <div className="row-actions mt">
                <button className="btn btn-ghost" onClick={onRetry}>
                    <Icon name="refresh" size={14} /> Retry
                </button>
            </div>
        </>
    );
}

// Roles — the same payload vanilla's Roles pane rendered: colour, name,
// managed/integration flag, id, member count. The endpoint also returns each
// role's permission flags, which is what makes a role list actionable, so they
// are shown here rather than dropped.
function RolesTab({ serverId, reloadKey }) {
    const { data, loading, error, reload } = useAsync(
        () => api.get('/api/server/' + serverId + '/roles'),
        [serverId, reloadKey]
    );
    const [query, setQuery] = useState('');
    const roles = Array.isArray(data) ? data : [];
    const q = query.trim().toLowerCase();
    const visible = q ? roles.filter((r) => matches(r.name, q) || matches(r.id, q)) : roles;

    return (
        <Card title={'Roles (' + roles.length + ')'} icon="shield">
            {roles.length > 0 && (
                <div className="toolbar">
                    <Input placeholder="Search roles…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
            )}

            {error ? (
                <TabError title="Couldn’t load roles" error={error} onRetry={reload}
                    guidance="The bot may need the 'Manage Roles' permission." />
            ) : loading && !data ? (
                <Skeleton rows={4} />
            ) : roles.length === 0 ? (
                <Empty title="No roles" hint="This server has no roles besides @everyone." />
            ) : visible.length === 0 ? (
                <p className="hint">No roles match “{query}”.</p>
            ) : (
                <>
                    <div className="rows">
                        {visible.map((r) => {
                            const perms = (r.permissions || []).map(prettyPerm);
                            const shown = perms.slice(0, 3).join(', ');
                            return (
                                <div className="dist" key={r.id}>
                                    <span className="dist-dot" style={{ background: r.color || 'rgba(255,255,255,0.1)' }} />
                                    <span className="dist-name"><strong>{r.name}</strong></span>
                                    <span className="dist-meta">
                                        {r.managed ? 'Managed by an integration' : 'ID ' + r.id}
                                        {shown ? ' · ' + shown + (perms.length > 3 ? ' +' + (perms.length - 3) : '') : ''}
                                    </span>
                                    <span className="dist-count" title="members with this role">{num(r.memberCount)}</span>
                                </div>
                            );
                        })}
                    </div>
                    {q && <p className="hint">{visible.length} of {roles.length} roles match “{query}”.</p>}
                </>
            )}
        </Card>
    );
}

// Channels — the same payload vanilla's Channels pane rendered: type tag,
// name, topic, NSFW flag, and for voice channels the connected member count
// and bitrate. The API excludes categories from this list.
function ChannelsTab({ serverId, reloadKey }) {
    const { data, loading, error, reload } = useAsync(
        () => api.get('/api/server/' + serverId + '/channels'),
        [serverId, reloadKey]
    );
    const [query, setQuery] = useState('');
    const channels = Array.isArray(data) ? data : [];
    const q = query.trim().toLowerCase();
    const visible = q
        ? channels.filter((c) => matches(c.name, q) || matches(c.type, q) || matches(c.topic, q))
        : channels;

    return (
        <Card title={'Channels (' + channels.length + ')'} icon="grid">
            {channels.length > 0 && (
                <div className="toolbar">
                    <Input placeholder="Search channels…" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
            )}

            {error ? (
                <TabError title="Couldn’t load channels" error={error} onRetry={reload}
                    guidance="The bot may need the 'View Channels' permission." />
            ) : loading && !data ? (
                <Skeleton rows={4} />
            ) : channels.length === 0 ? (
                <Empty title="No channels" hint="The bot can’t see any text or voice channels in this server." />
            ) : visible.length === 0 ? (
                <p className="hint">No channels match “{query}”.</p>
            ) : (
                <>
                    <div className="rows">
                        {visible.map((c) => (
                            <div className="dist" key={c.id}>
                                <Badge tone={c.nsfw ? 'bad' : 'good'}>#{c.name}</Badge>
                                <span className="dist-name"><strong>{c.type}</strong>{c.topic ? ' — ' + c.topic : ''}</span>
                                <span className="dist-meta">
                                    {c.nsfw ? 'NSFW · ' : ''}
                                    {c.parentId ? 'in category' : 'no category'}
                                    {c.bitrate ? ' · ' + (c.bitrate / 1000) + ' kbps' : ''}
                                </span>
                                {c.memberCount !== null && c.memberCount !== undefined && (
                                    <span className="dist-count" title="members connected">{num(c.memberCount)}</span>
                                )}
                            </div>
                        ))}
                    </div>
                    {q && <p className="hint">{visible.length} of {channels.length} channels match “{query}”.</p>}
                </>
            )}
        </Card>
    );
}

export default function ServerDetail({ id, navigate }) {
    const { data, loading, error, reload } = useAsync(
        () => (id
            ? api.get('/api/server/' + id).catch((err) => { throw tagError(err, id); })
            : Promise.resolve(null)),
        [id]
    );
    const [, choose] = useServerSelection();
    const [tab, setTab] = useState('overview');
    // Bumped by the header Refresh so the open tab re-reads its own endpoint
    // too — one control refreshes the view the user is actually looking at.
    const [reloadKey, setReloadKey] = useState(0);

    // A different server opens on its Overview, the way vanilla's showSrv
    // rebuilt the hub with Overview active. A refresh keeps the current tab:
    // the id is unchanged.
    useEffect(() => { setTab('overview'); }, [id]);

    // Answers to a save or a refresh can arrive after the view has moved to
    // another server. `reload` is bound to the id its closure was created with,
    // so running a stale one writes that server's payload over this one's — and
    // because readiness is "loaded for THIS id", the view then sits on a
    // skeleton that never resolves. Callers that can outlive the server they
    // were made for pass the id they acted on; only the server on screen now is
    // reloaded.
    const currentId = useRef(id);
    currentId.current = id;

    function refresh(forId) {
        if (forId && forId !== currentId.current) return;
        setReloadKey((k) => k + 1);
        reload();
    }

    // The linked screens read the selection out of the shared store, so set it
    // before leaving — otherwise the tab opens on whatever server was last
    // picked there, which is the one thing this view exists to avoid.
    // Switching between the in-place tabs deliberately does NOT touch it: the
    // server id stays put (the route hash keeps it anyway).
    function openLinked(tabId) {
        choose(id);
        navigate(tabId);
    }

    const back = (
        <button className="back-link" onClick={() => navigate('servers')}>
            <Icon name="chevron" size={13} /> Back to servers
        </button>
    );

    if (!id) {
        return (
            <>
                {back}
                <Empty title="No server selected" hint="Open a server from the Servers list." />
            </>
        );
    }

    // useAsync keeps the previous payload while the next one loads, so on a
    // server change `data` is briefly the OLD server's. Readiness is therefore
    // "loaded for THIS id": without it a stale frame painted one server's
    // numbers under another server's URL, and the open tab fired roles/channels
    // requests for an id the detail had not resolved yet. The error is filtered
    // the same way — only a failure that names this server is this server's
    // failure; anything else falls through to the skeleton until the request
    // in flight settles.
    const ready = !!data && data.id === id;
    const errorFor = error && error.forId === id ? error : null;

    if (errorFor) {
        return (
            <>
                {back}
                <Empty title="Could not load this server"
                    hint={errorFor.message || 'The bot may be starting up.'} />
                <div className="row-actions mt">
                    <button className="btn btn-ghost" onClick={refresh}>
                        <Icon name="refresh" size={14} /> Retry
                    </button>
                </div>
            </>
        );
    }

    if (!ready) {
        return <>{back}<Skeleton rows={5} /></>;
    }

    const stats = data.stats || {};
    const snapshots = stats.snapshots || [];
    const net = (stats.totalJoins || 0) - (stats.totalLeaves || 0);
    const recent7 = snapshots.slice(-7).reduce((a, s) => a + (s.joins || 0) - (s.leaves || 0), 0);
    const channels = data.channels || {};
    const channelTotal = (channels.text || 0) + (channels.voice || 0);

    return (
        <>
            {back}

            <div className="srv-head">
                {data.icon
                    ? <img src={data.icon} alt="" className="srv-head-icon" />
                    : <span className="srv-head-icon srv-icon-fallback"><Icon name="server" size={22} /></span>}
                <div className="srv-head-meta">
                    <h2>{data.name}</h2>
                    <p>
                        {num(data.memberCount)} members
                        {data.boostTier > 0 && <> · <Badge tone="warn"><Icon name="star" size={11} /> {TIERS[data.boostTier] || ''}</Badge></>}
                    </p>
                </div>
                <button className="btn btn-ghost" onClick={() => refresh()} disabled={loading}>
                    <Icon name="refresh" size={14} /> {loading ? 'Refreshing…' : 'Refresh'}
                </button>
            </div>

            {/* Tab shell. Overview, Roles, Channels, Mod Tools and Settings
                render in place, in the order vanilla's hub listed them; the
                rest are entries into screens that already own that capability. */}
            <div className="tabs" role="tablist">
                {TABS.map((t) => (
                    <button className={'tab' + (tab === t.id ? ' active' : '')} key={t.id} role="tab"
                        aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                        {t.label}
                    </button>
                ))}
                {LINK_TABS.map((t) => (
                    <button className="tab tab-out" key={t.id} role="tab" aria-selected="false"
                        title={'Open the ' + t.label + ' screen for this server'}
                        onClick={() => openLinked(t.id)}>
                        {t.label} <Icon name="chevron" size={12} />
                    </button>
                ))}
            </div>

            {tab === 'roles' && <RolesTab serverId={id} reloadKey={reloadKey} />}
            {tab === 'channels' && <ChannelsTab serverId={id} reloadKey={reloadKey} />}
            {tab === 'modtools' && <ServerModTools serverId={id} reloadKey={reloadKey} />}
            {tab === 'settings' && <ServerSettings serverId={id} prefix={data.prefix}
                embedColor={data.embedColor} onSaved={refresh} />}

            {tab === 'overview' && (
                <>
                    <Grid cols={4}>
                        <StatCard label="Members" value={num(data.memberCount)} />
                        <StatCard label="Channels" value={num(channelTotal)}
                            sub={(channels.text || 0) + ' text / ' + (channels.voice || 0) + ' voice'} />
                        <StatCard label="Roles" value={num(data.roles)} />
                        <StatCard label="Growth" value={signed(net)}
                            tone={net >= 0 ? 'good' : 'bad'} sub={'7d: ' + signed(recent7)} />
                    </Grid>

                    <div className="mt">
                        <Card title="Member Growth (last 30 days)" icon="chart">
                            <GrowthChart timeline={snapshots} />
                        </Card>
                    </div>

                    <Grid cols={2} className="mt">
                        <Card title="Server" icon="server">
                            <div className="kv"><span>Server ID</span><strong className="mono">{data.id}</strong></div>
                            <div className="kv"><span>Created</span><strong>{data.created ? new Date(data.created).toLocaleDateString() : '—'}</strong></div>
                            <div className="kv"><span>Boosts</span><strong>{num(data.boostCount)}{data.boostTier ? ' · ' + (TIERS[data.boostTier] || '') : ''}</strong></div>
                        </Card>

                        <Card title="Growth totals" icon="chart">
                            <div className="kv"><span>Total joins</span><strong>{num(stats.totalJoins)}</strong></div>
                            <div className="kv"><span>Total leaves</span><strong>{num(stats.totalLeaves)}</strong></div>
                            <div className="kv"><span>Net growth</span><strong>{signed(net)}</strong></div>
                            <div className="kv"><span>Days recorded</span><strong>{num(snapshots.length)}</strong></div>
                        </Card>
                    </Grid>
                </>
            )}
        </>
    );
}

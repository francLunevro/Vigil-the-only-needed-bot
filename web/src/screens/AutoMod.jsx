import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num } from '../lib.js';
import { Card, Grid, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Select, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

const RULES = [
    { key: 'spam', label: 'Spam', desc: 'Too many messages in a short window', threshold: true, window: true },
    { key: 'mentions', label: 'Mass Mentions', desc: 'More than N mentions in one message', threshold: true },
    { key: 'words', label: 'Banned Words', desc: 'Messages matching the word filters' },
    { key: 'links', label: 'Links', desc: 'Messages containing disallowed links' },
    { key: 'caps', label: 'Excessive Caps', desc: 'Mostly-capitalised messages', threshold: true },
];
const ACTIONS = ['warn', 'delete', 'timeout', 'kick'];
const FILTER_TYPES = [
    { key: 'words', label: 'Banned words', placeholder: 'word or phrase' },
    { key: 'links', label: 'Blocked links', placeholder: 'example.com' },
    { key: 'regex', label: 'Regex filters', placeholder: '^spam.*' },
];

function FilterSection({ type, items, serverId, onChanged }) {
    const [value, setValue] = useState('');
    const toast = useToast();

    async function add() {
        const pattern = value.trim();
        if (!pattern) return;
        try {
            await api.post('/api/server/' + serverId + '/automod/filters', { filterType: type.key, pattern, action: 'delete' });
            setValue('');
            toast('Filter added');
            onChanged();
        } catch (err) {
            toast(err.message || 'Could not add filter', true);
        }
    }

    async function remove(pattern) {
        try {
            await api.del('/api/server/' + serverId + '/automod/filters', { filterType: type.key, pattern });
            toast('Filter removed');
            onChanged();
        } catch (err) {
            toast(err.message || 'Could not remove filter', true);
        }
    }

    return (
        <Card title={type.label} icon="shield" action={<Badge>{items.length}</Badge>}>
            <div className="toolbar">
                <Input placeholder={type.placeholder} value={value}
                    onChange={(e) => setValue(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
                <Button variant="ghost" onClick={add}>Add</Button>
            </div>
            {items.length === 0
                ? <p className="hint">Nothing configured.</p>
                : (
                    <div className="chips mt">
                        {items.map((f) => (
                            <span className="chip" key={f.pattern}>
                                <span className="mono">{f.pattern}</span>
                                <button className="chip-x" onClick={() => remove(f.pattern)} title="Remove">×</button>
                            </span>
                        ))}
                    </div>
                )}
        </Card>
    );
}

export default function AutoMod() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/automod') : Promise.resolve(null)),
        [serverId]
    );

    const header = <PageHeader title="Auto-Mod" sub="Rules, filters and exclusions" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Auto-mod is configured per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={6} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load auto-mod" hint={error && error.message} />
            </>
        );
    }

    const rules = data.rules || {};
    const filters = data.filters || { words: [], links: [], regex: [] };
    const channels = data.channels || [];
    const roles = data.roles || [];
    const settings = data.channelSettings || {};
    const channelName = (id) => (channels.find((c) => c.id === id) || {}).name || id;
    const roleName = (id) => (roles.find((r) => r.id === id) || {}).name || id;

    async function saveRule(ruleType, patch) {
        const current = rules[ruleType] || {};
        try {
            await api.post('/api/server/' + serverId + '/automod/rules', { ruleType, config: { ...current, ...patch } });
            toast(ruleType + ' rule updated');
            reload();
        } catch (err) {
            toast(err.message || 'Could not save rule', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Grid cols={2}>
                {RULES.map((meta) => {
                    const rule = rules[meta.key] || {};
                    return (
                        <Card key={meta.key} title={meta.label} icon="shield"
                            action={<Badge tone={rule.enabled ? 'good' : 'default'}>{rule.enabled ? 'On' : 'Off'}</Badge>}>
                            <p className="hint" style={{ marginTop: 0 }}>{meta.desc}</p>

                            <div className="field">
                                <label>Enabled</label>
                                <input type="checkbox" checked={!!rule.enabled}
                                    onChange={(e) => saveRule(meta.key, { enabled: e.target.checked })} />
                            </div>

                            <div className="field">
                                <label>Action</label>
                                <Select value={rule.action || 'warn'}
                                    onChange={(e) => saveRule(meta.key, { action: e.target.value })}>
                                    {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                                </Select>
                            </div>

                            {rule.action === 'timeout' && (
                                <div className="field">
                                    <label>Timeout (seconds)</label>
                                    <Input type="number" min="1" defaultValue={rule.duration || 300}
                                        onBlur={(e) => saveRule(meta.key, { duration: Number(e.target.value) })} />
                                </div>
                            )}

                            {meta.threshold && (
                                <div className="field">
                                    <label>Threshold</label>
                                    <Input type="number" min="1" defaultValue={rule.threshold || 5}
                                        onBlur={(e) => saveRule(meta.key, { threshold: Number(e.target.value) })} />
                                </div>
                            )}

                            {meta.window && (
                                <div className="field">
                                    <label>Window (seconds)</label>
                                    <Input type="number" min="1" defaultValue={rule.time_window || 10}
                                        onBlur={(e) => saveRule(meta.key, { time_window: Number(e.target.value) })} />
                                </div>
                            )}
                        </Card>
                    );
                })}
            </Grid>

            <div className="mt"><FilterSection type={FILTER_TYPES[0]} items={filters.words || []} serverId={serverId} onChanged={reload} /></div>
            <div className="mt"><FilterSection type={FILTER_TYPES[1]} items={filters.links || []} serverId={serverId} onChanged={reload} /></div>
            <div className="mt"><FilterSection type={FILTER_TYPES[2]} items={filters.regex || []} serverId={serverId} onChanged={reload} /></div>

            <Grid cols={2} className="mt">
                <Card title="Exempt Channels" icon="server" action={<Badge>{num((settings.excludedChannels || []).length)}</Badge>}>
                    <p className="hint" style={{ marginTop: 0 }}>Auto-mod never runs in these channels.</p>
                    {!(settings.excludedChannels || []).length
                        ? <p className="hint">None.</p>
                        : <div className="chips">{settings.excludedChannels.map((id) => <span className="chip" key={id}>#{channelName(id)}</span>)}</div>}
                </Card>
                <Card title="Exempt Roles" icon="users" action={<Badge>{num((settings.whitelistedRoles || []).length)}</Badge>}>
                    <p className="hint" style={{ marginTop: 0 }}>Members with these roles are never actioned.</p>
                    {!(settings.whitelistedRoles || []).length
                        ? <p className="hint">None.</p>
                        : <div className="chips">{settings.whitelistedRoles.map((id) => <span className="chip" key={id}>{roleName(id)}</span>)}</div>}
                </Card>
            </Grid>
        </>
    );
}

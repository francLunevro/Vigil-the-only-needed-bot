import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, useTextChannels, num, timeAgo } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Select, StatCard, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// Mirrors DEFAULT_TEMPLATE in src/tempVoice.js so the placeholder matches the
// server-side fallback.
const DEFAULT_TEMPLATE = "{name}'s channel";

export default function TempVoice() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/temp-voice') : Promise.resolve(null)),
        [serverId]
    );
    const { data: textChannels } = useTextChannels(serverId);

    const [template, setTemplate] = useState('');
    const [triggerChannel, setTriggerChannel] = useState('');
    const [triggerCategory, setTriggerCategory] = useState('');
    const [panelChannel, setPanelChannel] = useState('');
    const [busy, setBusy] = useState(false);

    // Re-seed the template editor whenever a different server's config loads.
    useEffect(() => {
        setTemplate((data && data.config && data.config.name_template) || '');
    }, [data]);

    const header = <PageHeader title="Temp Voice" sub="Join-to-create voice channels and control panels" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Temp voice is configured per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={5} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load temp voice" hint={error && error.message} />
            </>
        );
    }

    const triggers = data.triggers || [];
    const spawned = data.spawned || [];
    const panels = data.panels || [];
    const channels = data.channels || [];
    const voiceChannels = channels.filter((c) => c.type === 2);
    const categories = channels.filter((c) => c.type === 4);

    const channelName = (id) => (channels.find((c) => c.id === id) || {}).name || id;
    const textName = (id) => (textChannels || []).find((c) => c.id === id) || {};
    const templateValue = template;

    async function run(fn, message) {
        setBusy(true);
        try {
            await fn();
            toast(message);
            reload();
        } catch (err) {
            toast(err.message || 'Action failed', true);
        } finally {
            setBusy(false);
        }
    }

    const saveTemplate = () => run(
        () => api.post('/api/server/' + serverId + '/temp-voice/config', { nameTemplate: templateValue.trim() }),
        'Template saved'
    );

    const addTrigger = () => {
        if (!triggerChannel) { toast('Pick a voice channel first', true); return; }
        run(() => api.post('/api/server/' + serverId + '/temp-voice/triggers', { channelId: triggerChannel, categoryId: triggerCategory || null }), 'Trigger added')
            .then(() => { setTriggerChannel(''); setTriggerCategory(''); });
    };

    const removeTrigger = (channelId) => run(
        () => api.del('/api/server/' + serverId + '/temp-voice/triggers', { channelId }),
        'Trigger removed'
    );

    const addPanel = () => {
        if (!panelChannel) { toast('Pick a text channel first', true); return; }
        run(() => api.post('/api/server/' + serverId + '/temp-voice/panels', { channelId: panelChannel }), 'Panel posted')
            .then(() => setPanelChannel(''));
    };

    const removePanel = (channelId) => run(
        () => api.del('/api/server/' + serverId + '/temp-voice/panels', { channelId }),
        'Panel unregistered'
    );

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <div className="grid grid-3">
                <StatCard label="Triggers" value={num(triggers.length)} sub="Join-to-create channels" />
                <StatCard label="Active channels" value={num(spawned.length)} sub="Currently spawned" />
                <StatCard label="Panels" value={num(panels.length)} sub="Control messages" />
            </div>

            <Card title="Channel name template" icon="terminal"
                action={<Button onClick={saveTemplate} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>}>
                <Input value={templateValue} placeholder={DEFAULT_TEMPLATE}
                    onChange={(e) => setTemplate(e.target.value)} />
                <p className="hint">Use {'{name}'} for the member’s username and {'{number}'} for the spawn counter. Max 100 characters.</p>
            </Card>

            <div className="mt">
                <Card title={'Trigger channels (' + num(triggers.length) + ')'} icon="star">
                    <div className="form-row">
                        <Select value={triggerChannel} onChange={(e) => setTriggerChannel(e.target.value)}>
                            <option value="">Select voice channel…</option>
                            {voiceChannels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </Select>
                        <Select value={triggerCategory} onChange={(e) => setTriggerCategory(e.target.value)}>
                            <option value="">Category (optional)</option>
                            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </Select>
                        <Button onClick={addTrigger} disabled={busy}>Add trigger</Button>
                    </div>
                    {triggers.length === 0
                        ? <p className="hint">No triggers configured — joining a trigger channel spawns a private channel.</p>
                        : (
                            <div className="rows mt">
                                {triggers.map((t) => (
                                    <div className="dist" key={t.channel_id}>
                                        <span className="dist-name">🔊 {channelName(t.channel_id)}</span>
                                        <span className="hint">{t.category_id ? '→ ' + channelName(t.category_id) : 'no category'}</span>
                                        <Button variant="ghost" onClick={() => removeTrigger(t.channel_id)} disabled={busy}>Remove</Button>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>

            <div className="mt">
                <Card title={'Control panels (' + num(panels.length) + ')'} icon="grid"
                    action={<Button variant="ghost" onClick={() => run(() => api.post('/api/server/' + serverId + '/temp-voice/panels/refresh'), 'Panels refreshed')} disabled={busy}>Refresh all</Button>}>
                    <div className="form-row">
                        <Select value={panelChannel} onChange={(e) => setPanelChannel(e.target.value)}>
                            <option value="">Select text channel…</option>
                            {(textChannels || []).map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                        </Select>
                        <Button onClick={addPanel} disabled={busy}>Post panel</Button>
                    </div>
                    <p className="hint">Posts an embed with buttons (create / rename / limit / lock / unlock / claim / delete) and keeps it live as channels come and go.</p>
                    {panels.length === 0
                        ? <p className="hint">No panels registered.</p>
                        : (
                            <div className="rows mt">
                                {panels.map((p) => (
                                    <div className="dist" key={p.channel_id}>
                                        <span className="dist-name">#{textName(p.channel_id).name || p.channel_id}</span>
                                        <span className="hint mono">{p.message_id}</span>
                                        <Button variant="ghost" onClick={() => removePanel(p.channel_id)} disabled={busy}>Unregister</Button>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>

            <div className="mt">
                <Card title={'Active temp channels (' + num(spawned.length) + ')'} icon="users"
                    action={<Button variant="ghost" onClick={() => run(() => api.post('/api/server/' + serverId + '/temp-voice/cleanup'), 'Orphan cleanup ran')} disabled={busy}>Clean up orphans</Button>}>
                    {spawned.length === 0
                        ? <p className="hint">No temp channels are live right now. Channels delete themselves once everyone leaves.</p>
                        : (
                            <div className="rows">
                                {spawned.map((s) => (
                                    <div className="dist" key={s.channel_id}>
                                        <span className="dist-name">🔊 {channelName(s.channel_id)}</span>
                                        <span className="hint">Owner: <code className="mono">{s.owner_id}</code></span>
                                        <Badge>{timeAgo(s.created_at)}</Badge>
                                    </div>
                                ))}
                            </div>
                        )}
                    <p className="hint">Clean up orphans deletes spawned channels that are empty but still tracked (for example after a restart).</p>
                </Card>
            </div>
        </>
    );
}

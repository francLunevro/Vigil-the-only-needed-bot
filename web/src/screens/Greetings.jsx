import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, useTextChannels } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Textarea, Select, ChannelSelect } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

const FIELDS = ['enabled', 'channelId', 'content', 'embedTitle', 'embedDescription', 'embedColor', 'embedFooter'];

// The editor reads and saves every field, so it needs a value for each one even
// when the server omits it. Frozen and module-level so the fallback is also
// referentially stable: `data[tab] || {}` built a NEW object on every render,
// which re-fired the Editor's re-seed effect on each pass and was only harmless
// because the API happens to return both tabs.
const EMPTY = Object.freeze({
    enabled: false, channelId: '', content: '', embedTitle: '', embedDescription: '',
    embedColor: '#5865f2', embedFooter: '',
});

function Editor({ serverId, type, config, channels, onSaved }) {
    const toast = useToast();
    const [form, setForm] = useState(() => ({ ...EMPTY, ...config }));
    const [busy, setBusy] = useState(false);

    // Re-seed when a different server/type loads.
    useEffect(() => { setForm({ ...EMPTY, ...config }); }, [config]);

    function set(field, value) {
        setForm((prev) => ({ ...prev, [field]: value }));
    }

    async function save() {
        setBusy(true);
        try {
            const body = {};
            for (const f of FIELDS) body[f] = f === 'channelId' ? (form[f] || null) : form[f];
            await api.post('/api/server/' + serverId + '/greetings/' + type, body);
            toast(type + ' settings saved');
            onSaved();
        } catch (err) {
            toast(err.message || 'Could not save', true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Card title={type === 'welcome' ? 'Welcome message' : 'Goodbye message'} icon="heart"
            action={<Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>}>
            <div className="field">
                <label>Enabled</label>
                <input type="checkbox" checked={!!form.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            </div>
            <div className="field-block">
                <label>Channel</label>
                <ChannelSelect channels={channels} value={form.channelId || ''} onChange={(v) => set('channelId', v)} />
            </div>
            <div className="field-block">
                <label>Message content (plain text)</label>
                <Textarea rows={2} value={form.content || ''} onChange={(e) => set('content', e.target.value)} />
            </div>
            <div className="field-block">
                <label>Embed title</label>
                <Input value={form.embedTitle || ''} onChange={(e) => set('embedTitle', e.target.value)} />
            </div>
            <div className="field-block">
                <label>Embed description</label>
                <Textarea rows={3} value={form.embedDescription || ''} onChange={(e) => set('embedDescription', e.target.value)} />
            </div>
            <div className="form-row mt">
                <div className="field-block" style={{ flex: 1 }}>
                    <label>Embed colour</label>
                    <input type="color" className="color-input" value={form.embedColor || '#5865f2'}
                        onChange={(e) => set('embedColor', e.target.value)} />
                </div>
                <div className="field-block" style={{ flex: 2 }}>
                    <label>Footer</label>
                    <Input value={form.embedFooter || ''} onChange={(e) => set('embedFooter', e.target.value)} />
                </div>
            </div>
            <p className="hint">Placeholders: {'{user} {username} {userid} {server} {membercount} {members} {age} {created}'}</p>
        </Card>
    );
}

export default function Greetings() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const [tab, setTab] = useState('welcome');
    const { data: channels } = useTextChannels(serverId);

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/greetings') : Promise.resolve(null)),
        [serverId]
    );

    const header = <PageHeader title="Greetings" sub="Welcome and goodbye messages" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Greetings are per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={5} /></>;
    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load greetings" hint={error && error.message} />
            </>
        );
    }

    return (
        <>
            {header}
            <div className="toolbar">
                <ServerSelect servers={servers} value={serverId} onChange={choose} />
                <Select value={tab} onChange={(e) => setTab(e.target.value)} style={{ maxWidth: 180 }}>
                    <option value="welcome">Welcome</option>
                    <option value="goodbye">Goodbye</option>
                </Select>
            </div>

            <Editor serverId={serverId} type={tab} config={data[tab] || EMPTY} channels={channels} onSaved={reload} />
        </>
    );
}

import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Select, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

export default function VoicePresence() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/voice-presence') : Promise.resolve(null)),
        [serverId]
    );

    const [channelId, setChannelId] = useState('');
    const [status, setStatus] = useState('');

    const header = <PageHeader title="Voice Presence" sub="Keep the bot in a voice channel" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Voice presence is per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={4} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load voice presence" hint={error && error.message} />
            </>
        );
    }

    const presence = data.presence;
    const channels = data.channels || [];
    const current = presence ? channels.find((c) => c.id === presence.channel_id) : null;

    async function call(path, body, message) {
        try {
            await api.post('/api/server/' + serverId + '/voice-presence/' + path, body);
            toast(message);
            reload();
        } catch (err) {
            toast(err.message || message + ' failed', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Card title="Current presence" icon="bell"
                action={<Badge tone={presence ? 'good' : 'default'}>{presence ? 'Connected' : 'Not connected'}</Badge>}>
                {presence
                    ? (
                        <>
                            <div className="kv"><span>Channel</span><strong>{(current && current.name) || presence.channel_id}</strong></div>
                            <div className="kv"><span>Status</span><strong>{presence.status || '—'}</strong></div>
                        </>
                    )
                    : <p className="hint">The bot is not sitting in a voice channel.</p>}
                {presence && (
                    <div className="row-actions mt">
                        <Button variant="ghost" onClick={() => call('leave', {}, 'Left the channel')}>Leave</Button>
                    </div>
                )}
            </Card>

            <div className="mt">
                <Card title="Join a channel" icon="bell">
                    <div className="form-row">
                        <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                            <option value="">Select a voice channel…</option>
                            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </Select>
                        <Input placeholder="Listening to… (optional status)" value={status} onChange={(e) => setStatus(e.target.value)} />
                        <Button onClick={() => call('join', { channelId, status: status || null }, 'Joined the channel')}
                            disabled={!channelId}>Join</Button>
                        <Button variant="ghost" onClick={() => call('move', { channelId, status: status || null }, 'Moved the bot')}
                            disabled={!channelId || !presence}>Move here</Button>
                    </div>
                </Card>
            </div>

            <div className="mt">
                <Card title="Status text" icon="terminal">
                    <div className="form-row">
                        <Input placeholder="Listening to…" value={status} onChange={(e) => setStatus(e.target.value)} />
                        <Button onClick={() => call('status', { status }, 'Status updated')}>Set status</Button>
                        <Button variant="ghost" onClick={() => call('restore', {}, 'Presences restored')}>Restore all</Button>
                    </div>
                    <p className="hint">Status sets the bot’s “Listening to…” line. Restore re-joins every saved presence.</p>
                </Card>
            </div>
        </>
    );
}

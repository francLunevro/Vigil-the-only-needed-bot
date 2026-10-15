import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync, num, timeAgo, mb, downloadJson, todayStamp } from '../lib.js';
import { Card, Grid, PageHeader, Empty, Button, Select, Input, Loaded } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// ──────────────────── Backups card ────────────────────
// Owner-only server-side: the API refuses anyone else, so this just mirrors
// the responses (a non-owner sees the honest 403 message in an empty state).
function Backups() {
    const toast = useToast();
    const { data, loading, error, reload } = useAsync(() => api.get('/api/backups'), []);
    const [busy, setBusy] = useState(false);

    const backups = (data && data.backups) || [];

    async function create() {
        setBusy(true);
        try {
            await api.post('/api/backups');
            toast('Backup created');
            reload();
        } catch (err) {
            toast(err.message || 'Backup failed', true);
        } finally {
            setBusy(false);
        }
    }

    async function remove(name) {
        try {
            await api.del('/api/backups/' + encodeURIComponent(name));
            toast('Backup deleted');
            reload();
        } catch (err) {
            toast(err.message || 'Failed to delete', true);
        }
    }

    return (
        <Card title={'Database backups (' + num(backups.length) + ')'} icon="layers"
            action={<Button onClick={create} disabled={busy}>{busy ? 'Backing up…' : 'Backup now'}</Button>}>
            <Loaded error={error} loading={loading && !data} empty={backups.length === 0} rows={3}
                errorTitle="Backups unavailable"
                emptyHint="No backups yet — click “Backup now” or wait for the automatic daily backup.">
                <div className="rows">
                    {backups.map((b) => (
                        <div className="dist" key={b.name}>
                            <span className="mono">{b.name}</span>
                            <span className="hint">{mb(b.size)} · {timeAgo(b.createdAt)}</span>
                            <div className="row-actions">
                                <Button variant="ghost"
                                    onClick={() => { window.location.href = '/api/backups/download/' + encodeURIComponent(b.name); }}>
                                    Download
                                </Button>
                                <Button variant="ghost"
                                    onClick={() => { if (window.confirm('Delete backup ' + b.name + '?')) remove(b.name); }}>
                                    Delete
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
            </Loaded>
            <p className="hint">Keeps the newest 7 backups. The database is checkpointed before the copy so each file is self-contained.</p>
        </Card>
    );
}

// ──────────────────── Config export / import card ────────────────────
function ConfigTransfer() {
    const toast = useToast();

    async function exportAll() {
        try {
            const res = await api.get('/api/export/all');
            downloadJson(res.data || res, 'bot-config-' + todayStamp() + '.json');
            toast('Config exported');
        } catch (err) {
            toast(err.message || 'Export failed', true);
        }
    }

    function importAll() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'application/json,.json';
        input.onchange = async () => {
            const file = input.files && input.files[0];
            if (!file) return;
            if (!window.confirm('Importing overwrites matching tables with the file contents. Continue?')) return;
            try {
                const text = await file.text();
                const parsed = JSON.parse(text);
                await api.post('/api/import/all', { data: parsed.data || parsed });
                toast('Import complete');
            } catch (err) {
                toast(err.message || 'Import failed', true);
            }
        };
        input.click();
    }

    return (
        <Card title="Config export" icon="server">
            <p className="hint" style={{ margin: 0 }}>
                Download every configurable table (guild configs, permissions, moderation, tickets, temp-voice, dashboards) as JSON — or restore a previous export.
            </p>
            <div className="row-actions mt">
                <Button onClick={exportAll}>⬇️ Export all</Button>
                <Button variant="ghost" onClick={importAll}>⬆️ Import</Button>
            </div>
        </Card>
    );
}

// ──────────────────── Error alert channel card ────────────────────
function ErrorAlertChannel() {
    const toast = useToast();
    const { data, loading, error, reload } = useAsync(() => api.get('/api/errors/alert'), []);
    const [guildId, setGuildId] = useState('');
    const [channelId, setChannelId] = useState('');

    const guilds = (data && data.guilds) || [];

    // Preselect the saved channel's server/channel when the config first loads.
    useEffect(() => {
        if (!data || !data.channelId) return;
        setChannelId(data.channelId);
        const owner = guilds.find((g) => g.channels.some((c) => c.id === data.channelId));
        if (owner) setGuildId(owner.id);
    }, [data]);

    const channels = (guilds.find((g) => g.id === guildId) || {}).channels || [];
    let savedLabel = null;
    if (data && data.channelId) {
        for (const g of guilds) {
            const ch = g.channels.find((c) => c.id === data.channelId);
            if (ch) { savedLabel = '#' + ch.name; break; }
        }
        if (!savedLabel) savedLabel = data.channelId;
    }

    async function save() {
        try {
            await api.post('/api/errors/alert', { channelId });
            toast(channelId ? 'Error alerts enabled' : 'Error alerts disabled');
            reload();
        } catch (err) {
            toast(err.message || 'Failed to save', true);
        }
    }

    return (
        <Card title="Error alert channel" icon="alert">
            <Loaded error={error} loading={loading && !data} errorTitle="Owner access required" rows={2}>
                <p className="hint" style={{ margin: 0 }}>
                    Where critical bot errors (crashes, uncaught exceptions) get announced.
                    {savedLabel ? <> Currently: <strong>{savedLabel}</strong>.</> : <> Not configured.</>}
                </p>
                <div className="form-row mt">
                    <Select value={guildId} onChange={(e) => { setGuildId(e.target.value); setChannelId(''); }}>
                        <option value="">Select server…</option>
                        {guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </Select>
                    <Select value={channelId} onChange={(e) => setChannelId(e.target.value)} disabled={!guildId}>
                        <option value="">{guildId ? 'Select channel…' : 'Select a server first…'}</option>
                        {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                    </Select>
                    <Button onClick={save}>Save</Button>
                </div>
                <p className="hint">Clear the channel (and save) to disable alerts.</p>
            </Loaded>
        </Card>
    );
}

// ──────────────────── Bot identity card ────────────────────
// The bot's own Discord name, avatar, and activity. Each action is owner-only
// server-side, so a refusal arrives as the API's message in a toast.
function BotIdentity() {
    const toast = useToast();
    const [name, setName] = useState('');
    const [avatar, setAvatar] = useState('');
    const [presenceType, setPresenceType] = useState('playing');
    const [presenceText, setPresenceText] = useState('');
    const [busy, setBusy] = useState('');

    async function send(kind, body, okMessage, clearInput) {
        setBusy(kind);
        try {
            await api.post('/api/bot/' + kind, body);
            toast(okMessage);
            if (clearInput) clearInput();
        } catch (err) {
            toast(err.message || 'Failed', true);
        } finally {
            setBusy('');
        }
    }

    return (
        <Card title="Bot identity" icon="star">
            <div className="field-block">
                <label>Presence</label>
                <div className="form-row">
                    <Select value={presenceType} onChange={(e) => setPresenceType(e.target.value)} style={{ flex: '0 0 140px' }}>
                        <option value="playing">Playing</option>
                        <option value="watching">Watching</option>
                        <option value="listening">Listening to</option>
                        <option value="competing">Competing in</option>
                    </Select>
                    <Input value={presenceText} onChange={(e) => setPresenceText(e.target.value)} placeholder="e.g. with code…" />
                    <Button disabled={busy === 'presence'}
                        onClick={() => {
                            const text = presenceText.trim();
                            if (!text) { toast('Enter a presence text', true); return; }
                            send('presence', { type: presenceType, text }, 'Presence updated');
                        }}>
                        {busy === 'presence' ? 'Updating…' : 'Update presence'}
                    </Button>
                </div>
                <p className="hint">Changes the bot&apos;s Discord activity immediately.</p>
            </div>

            <div className="field-block">
                <label>Username</label>
                <div className="form-row">
                    <Input value={name} maxLength={32} onChange={(e) => setName(e.target.value)} placeholder="New bot name…" />
                    <Button disabled={busy === 'name'}
                        onClick={() => {
                            const value = name.trim();
                            if (!value) { toast('Enter a name', true); return; }
                            send('name', { name: value }, 'Username changed', () => setName(''));
                        }}>
                        {busy === 'name' ? 'Renaming…' : 'Rename'}
                    </Button>
                </div>
                <p className="hint">Discord limits username changes to 2 per hour.</p>
            </div>

            <div className="field-block">
                <label>Avatar</label>
                <div className="form-row">
                    <Input value={avatar} onChange={(e) => setAvatar(e.target.value)} placeholder="https://cdn.discordapp.com/…png" />
                    <Button disabled={busy === 'avatar'}
                        onClick={() => {
                            const url = avatar.trim();
                            if (!url) { toast('Enter an image URL', true); return; }
                            send('avatar', { url }, 'Avatar changed', () => setAvatar(''));
                        }}>
                        {busy === 'avatar' ? 'Setting…' : 'Set avatar'}
                    </Button>
                </div>
                <p className="hint">Paste a direct image URL (must end in .png/.jpg/.gif).</p>
            </div>
        </Card>
    );
}

export default function System() {
    const { data, loading, error, reload } = useAsync(() => api.get('/api/system'), []);

    const s = data || {};
    const load = Array.isArray(s.cpuLoad) ? s.cpuLoad.map((v) => v.toFixed(2)).join(' / ') : '—';

    return (
        <>
            <PageHeader title="System & Backups" sub="Host infrastructure, backups, and data transfer" onRefresh={reload} refreshing={loading} />

            {error && !data
                ? <Empty title="System info unavailable" hint="The bot may be starting up." />
                : (
                    <>
                        <Grid cols={2}>
                            <Card title="Host" icon="server">
                                <div className="kv"><span>Platform</span><strong>{s.platform || '—'} {s.release || ''}</strong></div>
                                <div className="kv"><span>Hostname</span><strong>{s.hostname || '—'}</strong></div>
                                <div className="kv"><span>CPU</span><strong>{s.cpuModel || '—'}</strong></div>
                                <div className="kv"><span>Cores</span><strong>{s.cpuCores ?? '—'}</strong></div>
                                <div className="kv"><span>Load (1/5/15m)</span><strong>{load}</strong></div>
                                <div className="kv"><span>Node</span><strong>{s.nodeVersion || '—'}</strong></div>
                            </Card>

                            <Card title="Memory" icon="layers">
                                <div className="kv"><span>Host total</span><strong>{s.memoryTotal ? s.memoryTotal + ' GB' : '—'}</strong></div>
                                <div className="kv"><span>Host used</span><strong>{s.memoryUsed ? s.memoryUsed + ' GB' : '—'} {s.memoryUsage ? '(' + s.memoryUsage + '%)' : ''}</strong></div>
                                <div className="kv"><span>Process RSS</span><strong>{s.rss ? mb(s.rss) : '—'}</strong></div>
                                {s.heapUsed && <div className="kv"><span>Heap</span><strong>{s.heapUsed} / {s.heapTotal} MB</strong></div>}
                                {s.uptime && <div className="kv"><span>Process uptime</span><strong>{s.uptime}</strong></div>}
                            </Card>
                        </Grid>

                        <Grid cols={2}>
                            <Backups />
                            <div>
                                <ConfigTransfer />
                                <div className="mt">
                                    <ErrorAlertChannel />
                                </div>
                            </div>
                        </Grid>
                    </>
                )}

            {/* Bot identity is deliberately outside the system-info gate: an
                owner must still be able to rename or re-avatar the bot when
                /api/system itself is failing. */}
            <div className="mt">
                <BotIdentity />
            </div>
        </>
    );
}

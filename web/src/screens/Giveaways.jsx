import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useTextChannels, num, timeAgo } from '../lib.js';
import { Card, PageHeader, Button, Input, Select, Badge, ChannelSelect, Loaded } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

const STATUS_TONE = { active: 'good', ended: 'default', cancelled: 'bad' };

export default function Giveaways() {
    const { data, loading, error, reload } = useAsync(() => api.get('/api/giveaways'), []);
    const { data: servers } = useServers();
    const toast = useToast();

    const [guildId, setGuildId] = useState('');
    const [channelId, setChannelId] = useState('');
    const [prize, setPrize] = useState('');
    const [winners, setWinners] = useState(1);
    const [hours, setHours] = useState(24);
    const [description, setDescription] = useState('');
    const [busy, setBusy] = useState(false);
    const [busyId, setBusyId] = useState(null);

    const { data: channels } = useTextChannels(guildId);
    const giveaways = Array.isArray(data) ? data : [];

    async function create() {
        if (!guildId) { toast('Pick a server first', true); return; }
        if (!prize.trim()) { toast('A prize is required', true); return; }
        setBusy(true);
        try {
            await api.post('/api/giveaways/create', {
                guildId, channelId: channelId || undefined, prize: prize.trim(),
                durationHours: Number(hours) || 24, winners: Number(winners) || 1,
                description: description || undefined,
            });
            toast('Giveaway started');
            setPrize(''); setDescription('');
            reload();
        } catch (err) {
            toast(err.message || 'Could not start giveaway', true);
            // A create can persist the row and still fail — the announcement
            // post runs after the insert — so reload before giving up. Without
            // this the list and its live count stay stale and the giveaway that
            // does exist is invisible until a manual refresh.
            reload();
        } finally {
            setBusy(false);
        }
    }

    // Ending and cancelling both destroy a running giveaway, so they keep the
    // vanilla panel's confirmations and its success wording. Rerolling only
    // replaces the winners, which vanilla never asked about.
    async function act(id, action, okMessage, confirmText) {
        if (confirmText && !window.confirm(confirmText)) return;
        setBusyId(id);
        try {
            await api.post('/api/giveaways/' + action, { id });
            toast(okMessage);
            reload();
        } catch (err) {
            toast(err.message || 'Could not ' + action + ' giveaway', true);
        } finally {
            setBusyId(null);
        }
    }

    return (
        <>
            <PageHeader title="Giveaways" sub="Create and manage giveaways across servers" onRefresh={reload} refreshing={loading} />

            <Card title="Create a giveaway" icon="star">
                <div className="form-row">
                    <Select value={guildId} onChange={(e) => { setGuildId(e.target.value); setChannelId(''); }}>
                        <option value="">Select server…</option>
                        {(servers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                    <ChannelSelect channels={channels} value={channelId} onChange={setChannelId} label="First usable channel" />
                    <Input placeholder="Prize (e.g. Discord Nitro)" value={prize} onChange={(e) => setPrize(e.target.value)} />
                    <Input type="number" min="1" max="20" value={winners} onChange={(e) => setWinners(e.target.value)} style={{ maxWidth: 110 }} title="Winners" />
                    <Input type="number" min="0.25" max="720" step="0.25" value={hours} onChange={(e) => setHours(e.target.value)} style={{ maxWidth: 130 }} title="Duration (hours)" />
                </div>
                <div className="form-row mt">
                    <Input placeholder="Description (optional)" value={description} onChange={(e) => setDescription(e.target.value)} />
                    <Button onClick={create} disabled={busy}>{busy ? 'Starting…' : 'Start giveaway'}</Button>
                </div>
                <p className="hint">Leave the channel as “First usable channel” and the bot picks one it can post in.</p>            </Card>

            <div className="mt">
                <Card title={'Giveaways (' + num(giveaways.length) + ')'} icon="star">
                    <Loaded error={error} loading={loading && !data} empty={giveaways.length === 0} rows={5}
                        errorTitle="Couldn’t load giveaways"
                        emptyHint="No giveaways yet — start one above.">
                        <div className="list">
                            {giveaways.map((g) => (
                                <div className="row row-static" key={g.id}>
                                    <div className="row-main">
                                        <div className="row-title">
                                            <strong>{g.prize}</strong>
                                            <Badge tone={STATUS_TONE[g.status] || 'default'}>{g.status}</Badge>
                                        </div>
                                        <div className="row-text">
                                            {g.guildName} · {num(g.winners)} winner{g.winners === 1 ? '' : 's'}
                                            {g.hostTag ? ' · hosted by ' + g.hostTag : ''}
                                        </div>
                                        <div className="sub">
                                            {g.status === 'active'
                                                ? 'Ends ' + new Date(g.endsAt).toLocaleString()
                                                : 'Ended ' + timeAgo(g.endedAt || g.createdAt)}
                                            {g.winnerIds && g.winnerIds.length ? ' · winners: ' + g.winnerIds.join(', ') : ''}
                                        </div>
                                    </div>
                                    <div className="row-actions">
                                        {g.status === 'active' && (
                                            <Button disabled={busyId === g.id}
                                                onClick={() => act(g.id, 'end', 'Giveaway ended, winners announced!', 'Pick winners and end this giveaway now?')}>
                                                {busyId === g.id ? 'Ending…' : 'End'}
                                            </Button>
                                        )}
                                        {g.status === 'active' && (
                                            <Button variant="ghost" disabled={busyId === g.id}
                                                onClick={() => act(g.id, 'cancel', 'Giveaway cancelled', 'Cancel this giveaway? No winners will be picked.')}>
                                                Cancel
                                            </Button>
                                        )}
                                        {/* Reroll only exists for ended giveaways: the store
                                            rejects any other status, and the route answers
                                            200 regardless, so offering it on a cancelled
                                            giveaway produced a false success toast. */}
                                        {g.status === 'ended' && (
                                            <Button variant="ghost" disabled={busyId === g.id}
                                                onClick={() => act(g.id, 'reroll', 'New winner(s) picked!')}>
                                                {busyId === g.id ? 'Rerolling…' : 'Reroll'}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </Loaded>
                </Card>
            </div>
        </>
    );
}

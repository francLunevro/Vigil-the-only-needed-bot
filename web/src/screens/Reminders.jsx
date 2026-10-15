import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, num, timeAgo } from '../lib.js';
import { Card, PageHeader, Skeleton, Empty, Button, Input } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

function due(ts) {
    const ms = ts - Date.now();
    if (ms <= 0) return 'due now';
    const mins = Math.floor(ms / 60000);
    if (mins < 60) return 'in ' + Math.max(1, mins) + 'm';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return 'in ' + hours + 'h';
    return 'in ' + Math.floor(hours / 24) + 'd';
}

export default function Reminders() {
    const { data, loading, error, reload } = useAsync(() => api.get('/api/reminders'), []);
    const toast = useToast();

    const [userId, setUserId] = useState('');
    const [channelId, setChannelId] = useState('');
    const [text, setText] = useState('');
    const [durationMs, setDurationMs] = useState(3600000);

    const reminders = Array.isArray(data) ? data : [];

    async function create() {
        if (!userId.trim() || !text.trim() || !durationMs) {
            toast('User ID, text and a duration are required', true);
            return;
        }
        try {
            await api.post('/api/reminders', {
                userId: userId.trim(), channelId: channelId.trim() || null,
                text: text.trim(), durationMs: Number(durationMs),
            });
            toast('Reminder created');
            setText('');
            reload();
        } catch (err) {
            toast(err.message || 'Could not create reminder', true);
        }
    }

    async function remove(rem) {
        try {
            await api.del('/api/reminders/' + rem.id, { userId: rem.userId });
            toast('Reminder deleted');
            reload();
        } catch (err) {
            toast(err.message || 'Could not delete reminder', true);
        }
    }

    if (loading && !data) return <Skeleton rows={4} />;

    return (
        <>
            <PageHeader title="Reminders" sub="All pending reminders" onRefresh={reload} refreshing={loading} />

            <Card title="Create a reminder" icon="bell">
                <div className="form-row">
                    <Input placeholder="User ID" value={userId} onChange={(e) => setUserId(e.target.value)} />
                    <Input placeholder="Channel ID (optional)" value={channelId} onChange={(e) => setChannelId(e.target.value)} />
                    <Input placeholder="Reminder text" value={text} onChange={(e) => setText(e.target.value)} />
                    <Input type="number" min="1000" step="1000" value={durationMs}
                        onChange={(e) => setDurationMs(e.target.value)} style={{ maxWidth: 160 }} title="Duration (ms)" />
                    <Button onClick={create}>Create</Button>
                </div>
                <p className="hint">Duration is in milliseconds — 3600000 is one hour. {durationMs ? 'That’s ' + due(Date.now() + Number(durationMs)) + '.' : ''}</p>
            </Card>

            {error && <Empty title="Couldn’t load reminders" />}

            {!error && <div className="mt">
                <Card title={'Pending (' + num(reminders.length) + ')'} icon="bell">
                    {reminders.length === 0
                        ? <Empty title="No pending reminders" hint="Members can set them with /remindme." />
                        : (
                            <div className="rows">
                                {reminders.map((rem) => (
                                    <div className="dist" key={rem.id}>
                                        <span className="dist-name">
                                            <strong>{rem.text}</strong>
                                            <span className="sub"> · <span className="mono">{rem.userId}</span> · set {timeAgo(rem.createdAt)}</span>
                                        </span>
                                        <span className="dist-meta">due {due(rem.remindAt)}</span>
                                        <Button variant="ghost" onClick={() => remove(rem)}>Delete</Button>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>}
        </>
    );
}

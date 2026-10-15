import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num, timeAgo } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Textarea, Select, StatCard, Badge, Grid } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

const STATUSES = ['', 'pending', 'approved', 'denied'];
const STATUS_LABEL = { pending: 'Pending', approved: 'Approved', denied: 'Denied' };

// Modal for approve/deny with an optional review note (replaces the vanilla
// window.prompt, which is also blocked in some sandboxed embeds).
function ReviewModal({ serverId, appeal, action, onClose, onDone }) {
    const toast = useToast();
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);

    async function save() {
        setBusy(true);
        try {
            await api.put('/api/server/' + serverId + '/ban-appeals/' + appeal.id,
                { status: action, reviewedBy: 'Dashboard', reviewNote: note || null });
            toast('Appeal ' + action);
            onDone();
            onClose();
        } catch (err) {
            toast(err.message || 'Could not update appeal', true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={onClose}>
            <div className="card" style={{ width: 400, maxWidth: '94vw', margin: 0 }} onClick={(e) => e.stopPropagation()}>
                <div className="card-body">
                    <strong>{action === 'approved' ? '✅ Approve' : '⛔ Deny'} appeal from {appeal.user_tag}</strong>
                    <div className="field-block mt">
                        <label>Review note (optional)</label>
                        <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)}
                            placeholder={action === 'approved' ? 'Why it was accepted…' : 'Why it was rejected…'} />
                    </div>
                    <div className="form-row mt">
                        <Button variant="ghost" onClick={onClose}>Cancel</Button>
                        <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Confirm'}</Button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function BanAppeals() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const [filter, setFilter] = useState('');
    const { data, loading, error, reload } = useAsync(
        () => (serverId
            ? Promise.all([
                api.get('/api/server/' + serverId + '/ban-appeals/stats'),
                api.get('/api/server/' + serverId + '/ban-appeals' + (filter ? '?status=' + filter : '')),
            ])
            : Promise.resolve(null)),
        [serverId, filter]
    );

    // Manual submit form (the vanilla dashboard lets staff log appeals by hand).
    const [userId, setUserId] = useState('');
    const [userTag, setUserTag] = useState('');
    const [reason, setReason] = useState('');
    const [message, setMessage] = useState('');
    const [review, setReview] = useState(null); // { appeal, action }

    const header = <PageHeader title="Ban Appeals" sub="Review appeals from banned members" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Ban appeals are per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={5} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load ban appeals" hint={error && error.message} />
            </>
        );
    }

    const [stats, listData] = data;
    const appeals = listData.appeals || [];

    async function submit() {
        if (!userId.trim() || !userTag.trim() || !reason.trim() || !message.trim()) {
            toast('Fill all fields', true);
            return;
        }
        try {
            await api.post('/api/server/' + serverId + '/ban-appeals',
                { userId: userId.trim(), userTag: userTag.trim(), reason, message });
            toast('Appeal submitted');
            setUserId(''); setUserTag(''); setReason(''); setMessage('');
            reload();
        } catch (err) {
            toast(err.message || 'Could not submit appeal', true);
        }
    }

    async function remove(id) {
        try {
            await api.del('/api/server/' + serverId + '/ban-appeals/' + id);
            toast('Appeal deleted');
            reload();
        } catch (err) {
            toast(err.message || 'Could not delete', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Grid cols={4}>
                <StatCard label="Pending" value={num(stats.pending)} tone={stats.pending ? 'warn' : 'default'} />
                <StatCard label="Approved" value={num(stats.approved)} tone="good" />
                <StatCard label="Denied" value={num(stats.denied)} tone="bad" />
                <StatCard label="Total" value={num(stats.total)} />
            </Grid>

            <Card title="Submit appeal manually" icon="shield">
                <div className="form-row">
                    <Input placeholder="User ID" value={userId} onChange={(e) => setUserId(e.target.value)} style={{ maxWidth: 180 }} />
                    <Input placeholder="User tag (e.g. user#1234)" value={userTag} onChange={(e) => setUserTag(e.target.value)} />
                    <Input placeholder="Ban reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                    <Button onClick={submit}>Submit appeal</Button>
                </div>
                <div className="form-row">
                    <Textarea rows={2} placeholder="Appeal message" value={message} onChange={(e) => setMessage(e.target.value)} />
                </div>
            </Card>

            <div className="mt">
                <Card title={'Appeals (' + num(appeals.length) + (filter ? ' · ' + (STATUS_LABEL[filter] || filter) : '') + ')'} icon="shield"
                    action={(
                        <Select value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 160 }}>
                            {STATUSES.map((s) => <option key={s || 'all'} value={s}>{s === '' ? 'All statuses' : STATUS_LABEL[s]}</option>)}
                        </Select>
                    )}>
                    {appeals.length === 0
                        ? <Empty title="No ban appeals found" hint="Submit one above or wait for users to appeal." />
                        : (
                            <div className="rows">
                                {appeals.map((a) => (
                                    <div className="dist" key={a.id}>
                                        <div style={{ minWidth: 0 }}>
                                            <strong>{a.user_tag}</strong> <Badge tone={a.status === 'pending' ? 'warn' : a.status === 'approved' ? 'good' : 'bad'}>{(a.status || 'unknown').toUpperCase()}</Badge>
                                            <div className="hint mono">{a.id} · {timeAgo(a.created_at)}</div>
                                            <div className="hint">Reason: {a.reason || 'None'}</div>
                                            <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>Message: {a.message || 'None'}</div>
                                            {a.reviewed_by && <div className="hint">Reviewed by {a.reviewed_by}{a.reviewed_at ? ' · ' + timeAgo(a.reviewed_at) : ''}</div>}
                                            {a.review_note && <div className="hint">Note: {a.review_note}</div>}
                                        </div>
                                        <div className="row-actions">
                                            {a.status === 'pending' && (
                                                <>
                                                    <Button onClick={() => setReview({ appeal: a, action: 'approved' })}>Approve</Button>
                                                    <Button variant="ghost" onClick={() => setReview({ appeal: a, action: 'denied' })}>Deny</Button>
                                                </>
                                            )}
                                            <Button variant="ghost" onClick={() => remove(a.id)}>Delete</Button>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>

            {review && (
                <ReviewModal serverId={serverId} appeal={review.appeal} action={review.action}
                    onClose={() => setReview(null)} onDone={reload} />
            )}
        </>
    );
}

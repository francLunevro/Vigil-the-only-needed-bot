import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num, timeAgo } from '../lib.js';
import { Card, Grid, StatCard, PageHeader, ServerSelect, Skeleton, Empty, Button, Select, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

export default function MemberReports() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();
    const [status, setStatus] = useState('');

    const { data, loading, error, reload } = useAsync(
        () => (serverId
            ? Promise.all([
                api.get('/api/server/' + serverId + '/reports' + (status ? '?status=' + status : '')),
                api.get('/api/server/' + serverId + '/reports/stats').catch(() => ({})),
            ])
            : Promise.resolve(null)),
        [serverId, status]
    );

    const header = <PageHeader title="Member Reports" sub="Reports submitted by members via /report" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Reports are per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={5} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load reports" hint={error && error.message} />
            </>
        );
    }

    const [list, stats] = data;
    const reports = list.reports || [];

    async function update(report, next) {
        try {
            await api.put('/api/server/' + serverId + '/reports/' + report.id, { status: next, reviewedBy: 'Dashboard' });
            toast('Report ' + next);
            reload();
        } catch (err) {
            toast(err.message || 'Could not update report', true);
        }
    }

    async function remove(report) {
        try {
            await api.del('/api/server/' + serverId + '/reports/' + report.id);
            toast('Report deleted');
            reload();
        } catch (err) {
            toast(err.message || 'Could not delete report', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar">
                <ServerSelect servers={servers} value={serverId} onChange={choose} />
                <Select value={status} onChange={(e) => setStatus(e.target.value)} style={{ maxWidth: 180 }}>
                    <option value="">All statuses</option>
                    <option value="pending">Pending</option>
                    <option value="approved">Approved</option>
                    <option value="dismissed">Dismissed</option>
                </Select>
            </div>

            <Grid cols={4} className="mb">
                <StatCard label="Pending" value={num(stats.pending)} />
                <StatCard label="Approved" value={num(stats.approved)} tone="good" />
                <StatCard label="Dismissed" value={num(stats.dismissed)} />
                <StatCard label="Total" value={num(stats.total)} />
            </Grid>

            {reports.length === 0
                ? <Empty title="No reports found" hint="Members can submit reports with /report." />
                : (
                    <div className="list">
                        {reports.map((rep) => (
                            <Card key={rep.id}>
                                <div className="report-head">
                                    <div>
                                        <strong>{rep.target_tag}</strong>
                                        <span className="sub"> reported by {rep.reporter_tag}</span>
                                    </div>
                                    <Badge tone={rep.status === 'approved' ? 'good' : rep.status === 'dismissed' ? 'bad' : 'warn'}>
                                        {String(rep.status).toUpperCase()}
                                    </Badge>
                                </div>
                                <div className="kv"><span>Reason</span><strong>{rep.reason || 'None'}</strong></div>
                                {rep.message_content && <div className="kv"><span>Reported message</span><strong className="mono">{rep.message_content}</strong></div>}
                                {rep.reviewed_by && <div className="kv"><span>Reviewed by</span><strong>{rep.reviewed_by} {rep.reviewed_at ? '· ' + timeAgo(rep.reviewed_at) : ''}</strong></div>}
                                {rep.review_note && <div className="kv"><span>Note</span><strong>{rep.review_note}</strong></div>}
                                <div className="kv"><span>Submitted</span><strong>{timeAgo(rep.created_at)}</strong></div>

                                {rep.status === 'pending' && (
                                    <div className="row-actions mt">
                                        <Button onClick={() => update(rep, 'approved')}>Approve</Button>
                                        <Button variant="ghost" onClick={() => update(rep, 'dismissed')}>Dismiss</Button>
                                        <Button variant="ghost" onClick={() => remove(rep)}>Delete</Button>
                                    </div>
                                )}
                            </Card>
                        ))}
                    </div>
                )}
        </>
    );
}

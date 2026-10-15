import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Select } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

const ACTIONS = ['timeout', 'kick', 'ban'];

export default function WarningThresholds() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/warning-thresholds') : Promise.resolve(null)),
        [serverId]
    );

    const [warnCount, setWarnCount] = useState(3);
    const [action, setAction] = useState('timeout');
    const [duration, setDuration] = useState(60);

    const header = <PageHeader title="Warning Thresholds" sub="Auto-punish at warning milestones" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="The escalation ladder is per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={4} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load thresholds" hint={error && error.message} />
            </>
        );
    }

    const thresholds = data.thresholds || [];

    async function add() {
        if (!warnCount || Number(warnCount) <= 0) { toast('Warning count must be positive', true); return; }
        try {
            await api.post('/api/server/' + serverId + '/warning-thresholds', {
                warnCount: Number(warnCount), action,
                duration: action === 'timeout' ? Number(duration) || 10 : null,
            });
            toast('Threshold saved');
            reload();
        } catch (err) {
            toast(err.message || 'Could not save threshold', true);
        }
    }

    async function remove(t) {
        try {
            await api.del('/api/server/' + serverId + '/warning-thresholds', { warnCount: t.warnCount });
            toast('Threshold removed');
            reload();
        } catch (err) {
            toast(err.message || 'Could not remove threshold', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Card title="Add or update a step" icon="shield">
                <div className="form-row">
                    <Input type="number" min="1" value={warnCount} onChange={(e) => setWarnCount(e.target.value)}
                        style={{ maxWidth: 140 }} title="Warnings" />
                    <Select value={action} onChange={(e) => setAction(e.target.value)}>
                        {ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
                    </Select>
                    {action === 'timeout' && (
                        <Input type="number" min="1" value={duration} onChange={(e) => setDuration(e.target.value)}
                            style={{ maxWidth: 170 }} title="Duration (minutes)" />
                    )}
                    <Button onClick={add}>Save step</Button>
                </div>
                <p className="hint">Saving a step with an existing warning count replaces it. Timeout duration is in minutes.</p>
            </Card>

            <div className="mt">
                <Card title={'Ladder (' + num(thresholds.length) + ' steps)'} icon="shield">
                    {thresholds.length === 0
                        ? <Empty title="No thresholds set" hint="Add a step above — e.g. 3 warnings = timeout." />
                        : (
                            <div className="rows">
                                {thresholds.map((t) => (
                                    <div className="dist" key={t.warnCount}>
                                        <span className="dist-rank">{t.warnCount}</span>
                                        <span className="dist-name">
                                            {t.warnCount} warning{t.warnCount === 1 ? '' : 's'} → <strong>{t.action}</strong>
                                            {t.action === 'timeout' && t.duration ? ' for ' + t.duration + ' min' : ''}
                                        </span>
                                        <Button variant="ghost" onClick={() => remove(t)}>Remove</Button>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>
        </>
    );
}

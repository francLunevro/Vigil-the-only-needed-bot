import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, num } from '../lib.js';
import { Card, PageHeader, Skeleton, Empty, Select } from '../components/ui.jsx';

// Renders the {command: {guildId: count}} map as a command × server matrix.
export default function CmdHeatmap() {
    const [days, setDays] = useState(7);
    const { data, loading, error, reload } = useAsync(
        () => api.get('/api/stats/commands/heatmap?days=' + days).catch(() => ({})),
        [days]
    );
    const { data: servers } = useServers();

    if (loading && !data) return <Skeleton rows={6} />;

    const heatmap = data || {};
    const commands = Object.keys(heatmap);
    const guildIds = Array.from(new Set(commands.flatMap((c) => Object.keys(heatmap[c] || {}))));
    const guildName = (id) => (servers || []).find((s) => s.id === id)?.name || id;
    const max = Math.max(1, ...commands.flatMap((c) => Object.values(heatmap[c] || {})));

    function intensity(count) {
        return Math.min(0.9, 0.12 + (count / max) * 0.78);
    }

    return (
        <>
            <PageHeader title="Command Heatmap" sub="Where each command is actually used" onRefresh={reload} refreshing={loading} />

            <div className="toolbar">
                <Select value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ maxWidth: 170 }}>
                    <option value="1">Last 24 hours</option>
                    <option value="7">Last 7 days</option>
                    <option value="30">Last 30 days</option>
                </Select>
            </div>

            {error && <Empty title="Couldn’t load the heatmap" />}
            {!error && commands.length === 0 && <Empty title="No command usage recorded" hint="Heat appears as commands run." />}

            {commands.length > 0 && (
                <Card title={'Commands (' + num(commands.length) + ') × servers (' + num(guildIds.length) + ')'} icon="grid">
                    <div className="heat-wrap">
                        <table className="heat">
                            <thead>
                                <tr>
                                    <th className="heat-corner">Command</th>
                                    {guildIds.map((id) => <th key={id} className="heat-head">{guildName(id)}</th>)}
                                </tr>
                            </thead>
                            <tbody>
                                {commands.map((cmd) => (
                                    <tr key={cmd}>
                                        <td className="heat-row-head mono">/{cmd}</td>
                                        {guildIds.map((id) => {
                                            const count = (heatmap[cmd] && heatmap[cmd][id]) || 0;
                                            return (
                                                <td key={id} className="heat-cell">
                                                    {count > 0
                                                        ? <span className="heat-chip" title={cmd + ' · ' + guildName(id) + ': ' + count}
                                                            style={{ background: 'rgba(var(--accent-rgb), ' + intensity(count) + ')' }}>{count}</span>
                                                        : <span className="heat-empty">·</span>}
                                                </td>
                                            );
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <p className="hint">Darker cells mean more usage. Hover a cell for the exact count.</p>
                </Card>
            )}
        </>
    );
}

import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../lib.js';
import { Card, PageHeader, Skeleton, Empty, Button, Input } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

const BUCKETS = [
    { key: 'global', label: 'Global', desc: 'Every API request, including exempt paths' },
    { key: 'login', label: 'Login', desc: 'Password / token attempts per client' },
    { key: 'api', label: 'API', desc: 'Authenticated API requests' },
    { key: 'modActions', label: 'Mod Actions', desc: 'Destructive moderation routes' },
];

function toForm(config) {
    const out = {};
    for (const b of BUCKETS) {
        const c = config[b.key] || { windowMs: 60000, max: 60 };
        out[b.key] = { windowSec: Math.round(c.windowMs / 1000), max: c.max };
    }
    return out;
}

export default function RateLimits() {
    const { data, loading, error, reload } = useAsync(() => api.get('/api/ratelimit/config'), []);
    const toast = useToast();
    const [form, setForm] = useState(null);

    // Seed the editable copy when the config first arrives.
    useEffect(() => { if (data && !form) setForm(toForm(data)); }, [data, form]);

    if (loading && !data) return <Skeleton rows={5} />;
    if (error) return <><PageHeader title="Rate Limits" onRefresh={reload} /><Empty title="Could not load rate limits" hint="Owner-only screen." /></>;

    function update(key, field, value) {
        setForm((prev) => ({ ...prev, [key]: { ...prev[key], [field]: value } }));
    }

    async function save() {
        const body = {};
        for (const b of BUCKETS) {
            body[b.key] = { windowMs: Math.max(1000, Number(form[b.key].windowSec) * 1000), max: Math.max(1, Number(form[b.key].max)) };
        }
        try {
            await api.post('/api/ratelimit/config', body);
            toast('Rate limits saved — taking effect immediately');
            reload();
        } catch (err) {
            toast(err.message || 'Could not save', true);
        }
    }

    async function reset() {
        setForm(toForm(data || {}));
    }

    if (!form) return <Skeleton rows={5} />;

    return (
        <>
            <PageHeader title="Rate Limits" sub="Per-client request budgets enforced by the dashboard"
                onRefresh={reload} refreshing={loading} />

            <Card title="Buckets" icon="sliders"
                action={<div className="row-actions"><Button variant="ghost" onClick={reset}>Reset</Button><Button onClick={save}>Save</Button></div>}>
                <div className="rows">
                    {BUCKETS.map((b) => (
                        <div className="rl-row" key={b.key}>
                            <div className="rl-info">
                                <strong>{b.label}</strong>
                                <span className="sub">{b.desc}</span>
                            </div>
                            <label className="rl-field">
                                <span>Window (s)</span>
                                <Input type="number" min="1" value={form[b.key].windowSec}
                                    onChange={(e) => update(b.key, 'windowSec', e.target.value)} />
                            </label>
                            <label className="rl-field">
                                <span>Max requests</span>
                                <Input type="number" min="1" value={form[b.key].max}
                                    onChange={(e) => update(b.key, 'max', e.target.value)} />
                            </label>
                        </div>
                    ))}
                </div>
                <p className="hint">Saving takes effect immediately — no restart, no cache wait.</p>
            </Card>
        </>
    );
}

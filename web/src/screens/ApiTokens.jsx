import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, num } from '../lib.js';
import { Card, PageHeader, Button, Input, Badge, Loaded, TokenReveal } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

const SCOPES = ['read:servers', 'read:stats', 'read:logs', 'write:webhooks', 'admin:all'];

function parseScopes(raw) {
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw) || []; } catch { return []; }
}

export default function ApiTokens() {
    const { data, loading, error, reload } = useAsync(() => api.get('/api/tokens'), []);
    const toast = useToast();

    const [name, setName] = useState('');
    const [scopes, setScopes] = useState([]);
    const [expires, setExpires] = useState(90);
    const [minted, setMinted] = useState(null);
    const [busy, setBusy] = useState(false);

    const tokens = Array.isArray(data) ? data : [];

    function toggleScope(scope) {
        setScopes((prev) => (prev.includes(scope) ? prev.filter((s) => s !== scope) : [...prev, scope]));
    }

    async function create() {
        if (!name.trim()) { toast('A token name is required', true); return; }
        setBusy(true);
        try {
            const res = await api.post('/api/tokens', {
                name: name.trim(), scopes, expiresInDays: Number(expires) || 0,
            });
            // The raw token is returned exactly once — never stored, never
            // retrievable again. Surface it immediately.
            setMinted(res.token);
            setName(''); setScopes([]);
            reload();
        } catch (err) {
            toast(err.message || 'Could not create token', true);
        } finally {
            setBusy(false);
        }
    }

    async function remove(id) {
        try {
            await api.del('/api/tokens/' + id);
            toast('Token deleted');
            reload();
        } catch (err) {
            toast(err.message || 'Could not delete token', true);
        }
    }

    return (
        <>
            <PageHeader title="API Tokens" sub="Credentials for external integrations" onRefresh={reload} refreshing={loading} />

            {minted && (
                <TokenReveal className="mb" title="Copy this token now" token={minted}
                    onDismiss={() => setMinted(null)} />
            )}

            <Card title="Create a token" icon="terminal">
                <div className="form-row">
                    <Input placeholder="Token name (e.g. CI/CD, Monitoring)" value={name} onChange={(e) => setName(e.target.value)} />
                    <Input type="number" min="0" max="3650" value={expires} onChange={(e) => setExpires(e.target.value)}
                        style={{ maxWidth: 170 }} title="Expiry in days (0 = never)" />
                    <Button onClick={create} disabled={busy}>{busy ? 'Creating…' : 'Create'}</Button>
                </div>
                <div className="chips mt">
                    {SCOPES.map((s) => (
                        <button key={s} className={'chip chip-btn' + (scopes.includes(s) ? ' chip-on' : '')} onClick={() => toggleScope(s)}>
                            {s}
                        </button>
                    ))}
                </div>
                <p className="hint">Expiry is in days (0 = never). Scopes limit what the token can reach.</p>
            </Card>

            <div className="mt">
                <Card title={'Tokens (' + num(tokens.length) + ')'} icon="terminal">
                    <Loaded error={error} loading={loading && !data} rows={4}
                        errorTitle="Couldn’t load tokens" errorHint="Owner-only screen."
                        empty={tokens.length === 0} emptyHint="No API tokens yet — create one above.">
                        <div className="rows">
                            {tokens.map((t) => (
                                <div className="dist" key={t.id}>
                                    <span className="dist-name">
                                        <strong>{t.name}</strong>
                                        <span className="sub"> · <span className="mono">{t.token_hash}</span></span>
                                    </span>
                                    <span className="dist-meta">
                                        {parseScopes(t.scopes).map((s) => <Badge key={s}>{s}</Badge>)}
                                        {t.expires_at ? ' · expires ' + new Date(t.expires_at).toLocaleDateString() : ' · never expires'}
                                        {t.last_used_at ? ' · last used ' + new Date(t.last_used_at).toLocaleDateString() : ' · never used'}
                                    </span>
                                    <Button variant="ghost" onClick={() => remove(t.id)}>Delete</Button>
                                </div>
                            ))}
                        </div>
                    </Loaded>
                </Card>
            </div>
        </>
    );
}

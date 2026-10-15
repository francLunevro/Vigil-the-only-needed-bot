import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, timeAgo, timeUntil } from '../lib.js';
import { Card, PageHeader, Skeleton, Button, Input, Badge, Loaded, TokenReveal } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// ──────────────────── Dashboard Access ────────────────────
// Ported from the vanilla settings section (`Dashboard Access`). Two panels:
//
//   • Dashboard users — who may sign in, plus which servers each of them can
//     see. Owner-only server-side, so a non-owner sees the API's own message.
//   • Active sessions — where this dashboard is signed in. Deliberately NOT
//     owner-only: a scoped Discord user can see and end their own sessions,
//     which is why this screen sits outside the owner-gated Customize screen.
//
// No client-side permission logic is used to decide access — every action just
// calls the API and surfaces the refusal it gets back.

const USER_ID_RE = /^\d{5,25}$/;

function DashboardUsers() {
    const toast = useToast();
    const { data, loading, error, reload } = useAsync(() => api.get('/api/dash/users'), []);
    const servers = useServers();

    const [newId, setNewId] = useState('');
    const [adding, setAdding] = useState(false);
    // The raw token comes back from the add response and nowhere else — it is
    // never stored in the clear, so this is the only chance to show it. "Done"
    // drops it from memory.
    const [issued, setIssued] = useState(null);
    const [openScopes, setOpenScopes] = useState(null);
    const [scopes, setScopes] = useState(null);
    const [scopeError, setScopeError] = useState(null);
    const [savingScopes, setSavingScopes] = useState(false);

    const users = data || {};
    const ids = Object.keys(users);

    async function add() {
        const id = newId.trim();
        if (!USER_ID_RE.test(id)) {
            toast('Enter a valid Discord user ID (5–25 digits)', true);
            return;
        }
        setAdding(true);
        try {
            const res = await api.post('/api/dash/users/add', { userId: id });
            setNewId('');
            setIssued({ userId: id, token: res.accessToken, expiresAt: res.expiresAt });
            reload();
        } catch (err) {
            toast(err.message || 'Failed to add user', true);
        } finally {
            setAdding(false);
        }
    }

    async function remove(id) {
        if (!window.confirm('Revoke dashboard access for ' + id + '?')) return;
        try {
            await api.post('/api/dash/users/remove', { userId: id });
            toast('Access revoked');
            if (openScopes === id) setOpenScopes(null);
            reload();
        } catch (err) {
            toast(err.message || 'Failed to remove', true);
        }
    }

    // The current grant set is loaded BEFORE any checkboxes render. If that read
    // fails we show an error and no inputs at all — rendering an empty unchecked
    // set would invite a Save that silently revokes every real grant.
    async function toggleScopes(id) {
        if (openScopes === id) {
            setOpenScopes(null);
            return;
        }
        setOpenScopes(id);
        setScopes(null);
        setScopeError(null);
        try {
            const granted = await api.get('/api/dash/users/guilds?userId=' + encodeURIComponent(id));
            setScopes(Array.isArray(granted) ? granted.map(String) : []);
        } catch (err) {
            setScopeError(err.message || 'Could not load current server access');
        }
    }

    async function saveScopes(id) {
        if (!scopes) return;
        const allIds = (servers.data || []).map((s) => String(s.id));
        // Both confirmations the vanilla panel had: saving nothing locks the
        // user out of every server, saving everything grants the lot.
        if (scopes.length === 0 && !window.confirm('No servers selected — this user will see NOTHING on the dashboard. Save?')) return;
        if (allIds.length && scopes.length === allIds.length && !window.confirm('Grant access to ALL servers for this user?')) return;
        setSavingScopes(true);
        try {
            await api.post('/api/dash/users/guilds', { userId: id, guildIds: scopes });
            toast('Server access updated');
            setOpenScopes(null);
            setScopes(null);
        } catch (err) {
            toast(err.message || 'Failed to save server access', true);
        } finally {
            setSavingScopes(false);
        }
    }

    return (
        <Card title={'Dashboard users' + (ids.length ? ' (' + ids.length + ')' : '')} icon="users"
            action={<Button variant="ghost" onClick={reload}>Refresh</Button>}>
            <div className="form-row">
                <Input value={newId} onChange={(e) => setNewId(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
                    placeholder="Discord user ID (right-click → Copy User ID)" />
                <Button onClick={add} disabled={adding}>{adding ? 'Adding…' : 'Add'}</Button>
            </div>
            <p className="hint">
                Users who can sign in with their Discord ID and an access token. Removing revokes access
                instantly and ends that user&apos;s sessions. Same list as the /dashaccess command.
            </p>

            {issued && (
                <TokenReveal className="mb" title="Access token" token={issued.token}
                    onDismiss={() => setIssued(null)}>
                    <p className="hint">
                        User <strong>{issued.userId}</strong> can now log in with their Discord ID and this token.
                    </p>
                    <p className="hint">
                        {issued.expiresAt
                            ? 'Expires ' + new Date(issued.expiresAt).toLocaleDateString() + ' — add the user again to issue a fresh token.'
                            : 'This token does not expire.'}
                    </p>
                </TokenReveal>
            )}

            <Loaded error={error} loading={loading && !data} empty={ids.length === 0} rows={3}
                errorTitle="Dashboard users unavailable" errorHint="Owner access is required."
                emptyHint="No dashboard users yet. Add one above — the owner has full access by default.">
                <div className="rows">
                    {ids.map((id) => {
                        const u = users[id] || {};
                        const meta = [];
                        if (u.addedBy) meta.push('by ' + u.addedBy);
                        if (u.addedAt) meta.push(timeAgo(u.addedAt));
                        if (u.lastUsedAt) meta.push('last used ' + timeAgo(u.lastUsedAt));
                        else if (u.hasToken) meta.push('never used');
                        if (u.expired) meta.push('token expired');
                        else if (u.expiresAt) meta.push('token expires ' + timeUntil(u.expiresAt));
                        return (
                            <div key={id}>
                                <div className="dist">
                                    <span className="mono">{id}</span>
                                    <span className="dist-meta">{meta.join(' · ')}</span>
                                    <div className="row-actions">
                                        <Button variant="ghost" onClick={() => toggleScopes(id)}>
                                            {openScopes === id ? 'Hide servers' : 'Servers'}
                                        </Button>
                                        <Button variant="ghost" onClick={() => remove(id)}>Remove</Button>
                                    </div>
                                </div>

                                {openScopes === id && (
                                    <div className="field-block" style={{ padding: '10px 12px', border: '1px solid var(--card-border)', borderRadius: 8, margin: '4px 0 10px' }}>
                                        {scopeError
                                            ? <p className="hint" style={{ color: '#ff7b81', margin: 0 }}>
                                                {scopeError}. Nothing will be saved — try again.
                                            </p>
                                            : !scopes
                                                ? <Skeleton rows={2} />
                                                : (
                                                    <>
                                                        <label>Server access — unchecked servers are hidden from this user</label>
                                                        {servers.error
                                                            ? <p className="hint" style={{ color: '#ff7b81' }}>Could not load servers: {servers.error.message}</p>
                                                            : servers.loading && !servers.data
                                                                ? <Skeleton rows={2} />
                                                                : (servers.data || []).length === 0
                                                                    ? <p className="hint">No servers available.</p>
                                                                    : (
                                                                        <div className="chips">
                                                                            {(servers.data || []).map((s) => {
                                                                                const sid = String(s.id);
                                                                                const on = scopes.includes(sid);
                                                                                return (
                                                                                    <label key={sid} className="chip" style={{ cursor: 'pointer' }}>
                                                                                        <input type="checkbox" checked={on}
                                                                                            onChange={() => setScopes((prev) => (on ? prev.filter((x) => x !== sid) : [...prev, sid]))} />
                                                                                        {' '}{s.name}
                                                                                    </label>
                                                                                );
                                                                            })}
                                                                        </div>
                                                                    )}
                                                        <div className="row-actions mt">
                                                            <Button onClick={() => saveScopes(id)} disabled={savingScopes || !scopes}>
                                                                {savingScopes ? 'Saving…' : 'Save access'}
                                                            </Button>
                                                            <Button variant="ghost" onClick={() => { setOpenScopes(null); setScopes(null); }}>
                                                                Cancel
                                                            </Button>
                                                        </div>
                                                        <p className="hint">With no servers selected, this user sees nothing.</p>
                                                    </>
                                                )}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </Loaded>
        </Card>
    );
}

function Sessions() {
    const toast = useToast();
    const { data, loading, error, reload } = useAsync(() => api.get('/api/dash/sessions'), []);
    const [busyId, setBusyId] = useState(null);

    const list = (data && data.sessions) || [];
    const scoped = !!(data && data.scoped);

    async function revoke(s) {
        if (!window.confirm(s.current
            ? 'End this session? You will be signed out immediately.'
            : 'End this session? That device will be signed out immediately.')) return;
        setBusyId(s.id);
        try {
            const res = await api.post('/api/dash/sessions/revoke', { id: s.id });
            // Ending the session you are calling from is a sign-out, not a list
            // refresh — the server says which one it was.
            if (res.self) {
                toast('Signed out');
                window.location.href = '/login';
                return;
            }
            toast('Session ended');
            reload();
        } catch (err) {
            toast(err.message || 'Failed to end session', true);
        } finally {
            setBusyId(null);
        }
    }

    return (
        <Card title="Active sessions" icon="shield"
            action={<Button variant="ghost" onClick={reload}>Refresh</Button>}>
            <p className="hint" style={{ marginTop: 0 }}>
                Where this dashboard is currently signed in. End one to sign that device out without changing
                any password or token.{scoped ? ' You are seeing your own sessions.' : ''}
            </p>

            <Loaded error={error} loading={loading && !data} empty={list.length === 0} rows={3}
                errorTitle="Sessions unavailable" emptyHint="No sessions found.">
                <div className="rows">
                    {list.map((s) => (
                        <div className="dist" key={s.id}>
                            <span className="dist-name">
                                <strong>{s.method === 'password' ? 'Shared password' : 'Discord token'}</strong>
                                {s.userId ? <span className="sub"> · user {s.userId}</span> : null}
                            </span>
                            <span className="dist-meta">
                                {s.createdAt ? 'signed in ' + timeAgo(s.createdAt) : ''}
                                {s.createdAt && s.expiresAt ? ' · ' : ''}
                                {s.expiresAt ? 'expires ' + timeUntil(s.expiresAt) : ''}
                                {s.current ? <> <Badge tone="good">This device</Badge></> : null}
                            </span>
                            <div className="row-actions">
                                <Button variant="ghost" onClick={() => revoke(s)} disabled={busyId === s.id}>
                                    {busyId === s.id ? 'Ending…' : (s.current ? 'Sign out' : 'End')}
                                </Button>
                            </div>
                        </div>
                    ))}
    </div>
            </Loaded>
        </Card>
    );
}

export default function Access() {
    return (
        <>
            <PageHeader title="Dashboard Access" sub="Who can sign in, where they are signed in, and which servers they can see" />
            <DashboardUsers />
            <div className="mt">
                <Sessions />
            </div>
        </>
    );
}

import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, num } from '../lib.js';
import { Card, Skeleton, Empty, Loaded, Icon, Input, Select } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// Per-server Mod Tools: the four cards vanilla's hub pane rendered — staff
// notes, invite tracking, quick mod actions and temporary roles. Every call
// goes to an endpoint that already existed:
//   GET/POST        /api/server/:id/notes[?userId=]
//   GET             /api/server/:id/invites
//   POST            /api/server/:id/mod/{warn|kick|ban|timeout}
//   GET/POST/DELETE /api/server/:id/temp-roles
// Notes and invites accept any authenticated session; the four actions and
// both temp-role mutations are owner-only and answer 403 with their own
// message, which is what the UI shows rather than guessing at the cause.

// Vanilla's parseDurationInput: "30m", "24h", "7d", and multi-unit "2h30m".
// The server owns the real limits; this only decides whether the text is a
// duration at all, which is what vanilla validated too.
function parseDurationInput(str) {
    const text = String(str || '').trim().toLowerCase();
    if (!/^(?:\d+\s*[wdhms]\s*)+$/.test(text)) return null;
    const units = { w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000 };
    let total = 0;
    let matched = false;
    for (const part of text.matchAll(/(\d+)\s*([wdhms])/g)) {
        total += Number(part[1]) * units[part[2]];
        matched = true;
    }
    return matched && total > 0 ? total : null;
}

// Vanilla's untilLabel() for a pending temporary role, deliberately local to
// this card rather than the shared timeUntil() helper: that helper answers a
// different question for the other screens (one unit, "expired"), while a
// granted role's row has to read exactly as the vanilla pane's row did —
// "in 2h 0m", "in 2d 3h", "in 45m" or "expiring now".
function tempRoleExpiry(expiresAt) {
    const ms = Number(expiresAt) - Date.now();
    if (ms <= 0) return 'expiring now';
    const mins = Math.floor(ms / 60000);
    const hours = Math.floor(mins / 60);
    const days = Math.floor(hours / 24);
    if (days > 0) return 'in ' + days + 'd ' + Math.floor(hours % 24) + 'h';
    if (hours > 0) return 'in ' + hours + 'h ' + Math.floor(mins % 60) + 'm';
    return 'in ' + Math.max(1, mins) + 'm';
}

// ── Staff notes ──
// Vanilla searched one user at a time and showed that user's notes. The same
// endpoint returns recent guild notes when no userId is given; the pane never
// used that, and neither does this.
function NotesSection({ serverId, reloadKey }) {
    const toast = useToast();
    const [lookup, setLookup] = useState('');
    const [searched, setSearched] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);

    const { data, loading, error, reload } = useAsync(
        () => (searched
            ? api.get('/api/server/' + serverId + '/notes?userId=' + encodeURIComponent(searched))
            : Promise.resolve(null)),
        [serverId, searched, reloadKey]
    );

    function search() {
        const id = lookup.trim();
        if (!id) { toast('Enter a user ID', true); return; }
        if (id === searched) reload();
        else setSearched(id);
    }

    async function add() {
        const text = note.trim();
        if (!text) { toast('Enter note text', true); return; }
        setBusy(true);
        try {
            await api.post('/api/server/' + serverId + '/notes', { targetUserId: searched, note: text });
            toast('Note added!');
            setNote('');
            reload();
        } catch (err) {
            toast(err.message || 'Failed to add note', true);
        } finally {
            setBusy(false);
        }
    }

    const notes = (data && data.notes) || [];

    return (
        <Card title="Staff Notes" icon="terminal">
            <div className="toolbar">
                <Input placeholder="Enter User ID…" value={lookup}
                    onChange={(e) => setLookup(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
                <button className="btn btn-ghost" onClick={search}>Search</button>
            </div>

            {!searched && <Empty title="No user searched yet" hint="Search a user ID above to view or add notes." />}

            {searched && error && <Empty title="Could not load notes" hint={error.message} />}
            {searched && !error && loading && !data && <Skeleton rows={3} />}

            {searched && !error && data && (
                <>
                    {notes.length === 0
                        ? <Empty title="No notes for this user" />
                        : (
                            <div className="rows">
                                {notes.map((n) => (
                                    <div className="dist" key={n.id}>
                                        <span className="dist-name"><strong>{n.note}</strong></span>
                                        <span className="dist-meta">
                                            By {n.authorTag || 'unknown'} · {new Date(n.createdAt).toLocaleDateString()}
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}

                    <div className="toolbar mt">
                        <Input placeholder="Add a note…" value={note}
                            onChange={(e) => setNote(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') add(); }} />
                        <button className="btn btn-primary" onClick={add} disabled={busy}>
                            {busy ? 'Adding…' : 'Add Note'}
                        </button>
                    </div>
                </>
            )}
        </Card>
    );
}

// ── Invite tracking ──
// Vanilla's card read `d.top[].inviter`, but this endpoint returns a plain
// array of { inviterId, count, tag }, so vanilla always fell through to "No
// invite data yet." This renders the rows the route does send (it already caps
// itself at the top 10).
function InvitesSection({ serverId, reloadKey }) {
    const { data, loading, error } = useAsync(
        () => api.get('/api/server/' + serverId + '/invites'),
        [serverId, reloadKey]
    );
    const top = Array.isArray(data) ? data : [];

    return (
        <Card title="Invite Tracking" icon="users" className="mt">
            <Loaded error={error} loading={loading && !data} empty={top.length === 0} rows={3}
                errorTitle="Could not load invite data"
                emptyHint="No invite data yet — invite tracking must be enabled for this server.">
                <div className="rows">
                    {top.map((inv, i) => (
                        <div className="dist" key={inv.inviterId || i}>
                            <span className="dist-rank">{i + 1}.</span>
                            <span className="dist-name">
                                <strong>{(inv.tag || inv.inviterId || 'Unknown').slice(0, 30)}</strong>
                            </span>
                            <span className="dist-count">{num(inv.count)} joins</span>
                        </div>
                    ))}
                </div>
            </Loaded>
        </Card>
    );
}

// ── Quick mod actions ──
// One user id / reason pair feeding all four buttons, exactly like vanilla. No
// confirmation dialog on any of them: vanilla had none either.
const ACTIONS = [
    { id: 'warn', label: 'Warn', icon: 'alert', verb: 'Warned' },
    { id: 'kick', label: 'Kick', icon: 'logout', verb: 'Kicked' },
    { id: 'ban', label: 'Ban', icon: 'shield', verb: 'Banned' },
    { id: 'timeout', label: 'Timeout', icon: 'bell', verb: 'Timed out' },
];

function ActionsSection({ serverId }) {
    const toast = useToast();
    const [userId, setUserId] = useState('');
    const [reason, setReason] = useState('');
    const [minutes, setMinutes] = useState('10');
    const [pending, setPending] = useState('');
    const [result, setResult] = useState(null);

    async function run(action) {
        const uid = userId.trim();
        if (!uid) { toast('Enter a user ID', true); return; }

        const body = { userId: uid, reason: reason.trim() || 'No reason provided' };
        if (action.id === 'timeout') {
            const mins = Number(minutes);
            if (!Number.isFinite(mins) || mins <= 0) {
                setResult({ ok: false, text: 'Timeout needs a positive number of minutes.' });
                return;
            }
            // Vanilla passed minutes; the endpoint accepts a named key or minutes.
            body.duration = mins;
        }

        setPending(action.id);
        setResult(null);
        try {
            const d = await api.post('/api/server/' + serverId + '/mod/' + action.id, body);
            // These routes answer { success } without echoing the member, so the
            // confirmation names the id we sent — vanilla printed "user undefined".
            const extra = action.id === 'timeout' ? ' for ' + body.duration + ' min'
                : (action.id === 'warn' && d && d.warningCount ? ' — now ' + d.warningCount + ' warning(s) on record' : '');
            setResult({ ok: true, text: action.verb + ' ' + uid + extra });
        } catch (err) {
            setResult({ ok: false, text: err.message || 'Request failed' });
        } finally {
            setPending('');
        }
    }

    return (
        <Card title="Quick Mod Actions" icon="shield" className="mt">
            <div className="toolbar">
                <Input placeholder="Enter User ID…" value={userId}
                    onChange={(e) => setUserId(e.target.value)} />
                <Input placeholder="Reason (optional)…" value={reason}
                    onChange={(e) => setReason(e.target.value)} />
                <Input style={{ maxWidth: 140 }} placeholder="Minutes" value={minutes}
                    onChange={(e) => setMinutes(e.target.value)} />
            </div>

            <div className="row-actions mt">
                {ACTIONS.map((a) => (
                    // Kick and ban read as destructive, as in vanilla's colour-coded row.
                    <button className={'btn ' + (a.id === 'kick' || a.id === 'ban' ? 'btn-bad' : 'btn-ghost')}
                        key={a.id} onClick={() => run(a)} disabled={!!pending}>
                        <Icon name={a.icon} size={14} /> {pending === a.id ? a.label + '…' : a.label}
                    </button>
                ))}
            </div>

            {pending && <Skeleton rows={1} />}
            {!pending && result && (
                <div className={'result ' + (result.ok ? 'result-good' : 'result-bad')}>
                    {result.text}
                </div>
            )}
        </Card>
    );
}

// ── Temporary roles ──
function TempRolesSection({ serverId, reloadKey }) {
    const toast = useToast();
    const { data, loading, error, reload } = useAsync(
        () => api.get('/api/server/' + serverId + '/temp-roles'),
        [serverId, reloadKey]
    );
    const entries = (data && data.entries) || [];
    const roles = (data && data.roles) || [];
    const [userId, setUserId] = useState('');
    const [roleId, setRoleId] = useState('');
    const [duration, setDuration] = useState('');
    const [busy, setBusy] = useState(false);

    async function grant() {
        const uid = userId.trim();
        if (!uid) { toast('Enter a user ID', true); return; }
        if (!roleId) { toast('Pick a role', true); return; }
        const ms = parseDurationInput(duration);
        if (!ms) { toast('Duration must look like 30m, 24h or 7d', true); return; }
        setBusy(true);
        try {
            const d = await api.post('/api/server/' + serverId + '/temp-roles', { userId: uid, roleId, durationMs: ms });
            toast(d && d.extended ? 'Temporary role extended' : 'Temporary role granted');
            setUserId('');
            reload();
        } catch (err) {
            toast(err.message || 'Failed to grant role', true);
        } finally {
            setBusy(false);
        }
    }

    async function remove(entry) {
        // Vanilla asked before revoking; same words here.
        if (!window.confirm('Remove this role from the member now?')) return;
        try {
            await api.del('/api/server/' + serverId + '/temp-roles', { userId: entry.userId, roleId: entry.roleId });
            toast('Role removed');
            reload();
        } catch (err) {
            toast(err.message || 'Failed to remove role', true);
        }
    }

    return (
        <Card title="Temporary Roles" icon="bell" className="mt">
            <div className="toolbar">
                <Input placeholder="User ID…" value={userId} onChange={(e) => setUserId(e.target.value)} />
                <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                    <option value="">Select role…</option>
                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
                <Input style={{ maxWidth: 140 }} placeholder="24h" value={duration}
                    onChange={(e) => setDuration(e.target.value)} />
                <button className="btn btn-primary" onClick={grant} disabled={busy}>
                    {busy ? 'Granting…' : 'Grant'}
                </button>
            </div>

            <p className="hint">
                The bot removes the role automatically when the time is up — durations
                like <code>30m</code>, <code>24h</code>, <code>7d</code>.
            </p>

            <Loaded error={error} loading={loading && !data} empty={entries.length === 0} rows={3}
                errorTitle="Could not load temporary roles"
                emptyHint="No temporary roles pending.">
                <div className="rows mt">
                    {entries.map((e) => {
                        const role = roles.find((r) => r.id === e.roleId);
                        return (
                            <div className="dist" key={(e.userId || '') + ':' + (e.roleId || '')}>
                                <span className="dist-name">
                                    <strong>{role ? role.name : e.roleId}</strong> → <span className="mono">{e.userId}</span>
                                </span>
                                <span className="dist-meta">
                                    {tempRoleExpiry(e.expiresAt)} · {new Date(Number(e.expiresAt)).toLocaleString()}
                                    {e.attempts ? ' · ⚠️ ' + e.attempts + ' failed removal attempt(s)' : ''}
                                </span>
                                <button className="btn btn-bad" onClick={() => remove(e)}>Remove</button>
                            </div>
                        );
                    })}
                </div>
            </Loaded>
        </Card>
    );
}

export default function ServerModTools({ serverId, reloadKey }) {
    return (
        <>
            <NotesSection serverId={serverId} reloadKey={reloadKey} />
            <InvitesSection serverId={serverId} reloadKey={reloadKey} />
            <ActionsSection serverId={serverId} />
            <TempRolesSection serverId={serverId} reloadKey={reloadKey} />
        </>
    );
}

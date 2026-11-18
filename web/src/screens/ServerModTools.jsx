import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, num, timeAgo } from '../lib.js';
import { Card, Skeleton, Empty, Loaded, Icon, Input, Select, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// Per-server Mod Tools: the cards vanilla's hub pane rendered — staff notes,
// invite tracking, quick mod actions and temporary roles — plus the member
// file, which is the one place that shows everything about a member at once.
// Every call goes to an endpoint that already existed:
//   GET/POST        /api/server/:id/notes[?userId=]
//   GET             /api/server/:id/invites
//   POST            /api/server/:id/mod/{warn|kick|ban|timeout}
//   GET/POST/DELETE /api/server/:id/temp-roles
//   GET             /api/server/:id/members/search?q=
//   GET             /api/server/:id/member/:userId/profile
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

// ── Member file ──
// Everything staff know about one member, composed by src/memberFile.js on the
// server: the merged timeline across warnings, cases, notes, reports, appeals
// and tickets, plus the per-system totals. The route is the member profile the
// vanilla pane already called — it returns the same warnings/notes/cases/invites
// arrays it always did, and now also the `memberFile` this renders, so an older
// payload degrades to the message below instead of throwing.

// Badge tone per source, so the same system keeps one colour down the timeline.
// Only the tones styles.css defines (good / bad / warn / default): a tone
// without a rule would render an unstyled badge, which reads as a bug.
const KIND_TONE = {
    case: 'bad',
    tempban: 'bad',
    warning: 'warn',
    report: 'warn',
    ticket: 'good',
    note: 'default',
    appeal: 'default',
};

const KIND_LABEL = {
    case: 'Case',
    warning: 'Warning',
    note: 'Note',
    report: 'Report',
    appeal: 'Appeal',
    ticket: 'Ticket',
    tempban: 'Temp ban',
};

// Which systems to count in the header, in a fixed order — the timeline shows
// one row per event, this shows how much of each there is.
const STAT_ROWS = [
    { key: 'warnings', label: 'Warnings' },
    { key: 'cases', label: 'Cases' },
    { key: 'notes', label: 'Notes' },
    { key: 'reports', label: 'Reports' },
    { key: 'appeals', label: 'Appeals' },
    { key: 'tickets', label: 'Tickets' },
];

// Pure presenter: takes the payload, renders it. Kept separate from the
// fetching card so it can be rendered directly in a test with a crafted file.
export function MemberFileView({ member, invites, file }) {
    if (!file) {
        return (
            <Empty title="Member file unavailable"
                hint="This server did not return the composed member file. Reload the page, and check the Errors screen if it persists." />
        );
    }

    const summaries = file.summaries || {};
    const timeline = file.timeline || [];
    const open = file.activePunishments || [];
    const pending = (summaries.reports && summaries.reports.pending) || 0;
    const appealsPending = (summaries.appeals && summaries.appeals.pending) || 0;
    const invitesTotal = (invites && invites.total) || 0;

    return (
        <>
            <div className="toolbar">
                <span className="mono">
                    {member ? (member.tag + (member.isBot ? ' (bot)' : '')) : 'Not in this server — showing stored history'}
                </span>
                {member && member.joinedAt && <span className="dist-meta">joined {new Date(member.joinedAt).toLocaleDateString()}</span>}
                <span className="dist-meta">{num(invitesTotal)} invite{invitesTotal === 1 ? '' : 's'}</span>
            </div>

            <div className="rows mt">
                {STAT_ROWS.map((row) => {
                    const s = summaries[row.key] || {};
                    const sub = row.key === 'cases' && s.active ? s.active + ' active'
                        : row.key === 'reports' && s.pending ? s.pending + ' pending'
                            : row.key === 'appeals' && s.pending ? s.pending + ' pending'
                                : row.key === 'tickets' && s.open ? s.open + ' open'
                                    : null;
                    return (
                        <div className="dist" key={row.key}>
                            <span className="dist-name"><strong>{num(s.total || 0)}</strong> {row.label}</span>
                            {sub && <span className="dist-count">{sub}</span>}
                        </div>
                    );
                })}
            </div>

            {(open.length > 0 || pending > 0 || appealsPending > 0) && (
                <div className="result result-bad mt">
                    {open.map((p, i) => (
                        <div key={(p.caseNumber || i) + p.type}>
                            {p.type}{p.caseNumber ? ' (case #' + p.caseNumber + ')' : ''} since {timeAgo(p.since)}
                            {p.until ? ' · until ' + new Date(p.until).toLocaleString() : ''}
                            {p.reason ? ' — ' + p.reason : ''}
                        </div>
                    ))}
                    {pending > 0 && <div>{pending} report(s) awaiting review</div>}
                    {appealsPending > 0 && <div>{appealsPending} ban appeal(s) pending</div>}
                </div>
            )}

            {timeline.length === 0
                ? <Empty title="Nothing on file" hint="No warnings, cases, notes, reports, appeals or tickets for this member." />
                : (
                    <div className="rows mt">
                        {timeline.map((entry) => (
                            <div className="dist" key={entry.kind + ':' + entry.id}>
                                <span className="dist-name">
                                    <Badge tone={KIND_TONE[entry.kind] || 'default'}>{KIND_LABEL[entry.kind] || entry.kind}</Badge>
                                    {' '}<strong>{entry.title}</strong>
                                </span>
                                <span className="dist-meta">
                                    {entry.detail ? String(entry.detail).slice(0, 160) : '—'}
                                    {entry.actor ? ' · by ' + entry.actor : ''}
                                    {' · '}{timeAgo(entry.at)}
                                </span>
                            </div>
                        ))}
                    </div>
                )}

            <p className="hint">
                Newest first. {file.truncated ? 'Older entries are capped per system — ' : ''}
                Staff notes and appeals are never shown to the member; the same file is available in Discord with{' '}
                <code>/memberfile</code>.
            </p>
            {file.errors && file.errors.length > 0 && (
                <p className="hint">Could not read: {file.errors.join(', ')}.</p>
            )}
        </>
    );
}

function MemberFileSection({ serverId, reloadKey }) {
    const toast = useToast();
    const [lookup, setLookup] = useState('');
    const [searched, setSearched] = useState('');
    const [results, setResults] = useState(null);
    const [searching, setSearching] = useState(false);

    const { data, loading, error } = useAsync(
        () => (searched
            ? api.get('/api/server/' + serverId + '/member/' + encodeURIComponent(searched) + '/profile')
            : Promise.resolve(null)),
        [serverId, searched, reloadKey]
    );

    // Search by name or id through the endpoint the vanilla pane used; picking a
    // result is what loads the file, so a half-typed id never queries.
    async function search() {
        const q = lookup.trim();
        if (!q) { toast('Enter a name or user ID', true); return; }
        setSearching(true);
        try {
            const d = await api.get('/api/server/' + serverId + '/members/search?q=' + encodeURIComponent(q));
            const members = (d && d.members) || [];
            setResults(members);
            if (members.length === 0) toast('No members matched', true);
        } catch (err) {
            toast(err.message || 'Search failed', true);
        } finally {
            setSearching(false);
        }
    }

    function open(id) {
        setSearched(id);
        setResults(null);
    }

    return (
        <Card title="Member File" icon="users">
            <div className="toolbar">
                <Input placeholder="Name or user ID…" value={lookup}
                    onChange={(e) => setLookup(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') search(); }} />
                <button className="btn btn-ghost" onClick={search} disabled={searching}>
                    {searching ? 'Searching…' : 'Search'}
                </button>
            </div>

            {results && results.length > 0 && (
                <div className="rows mt">
                    {results.map((m) => (
                        <div className="dist" key={m.id}>
                            <span className="dist-name"><strong>{m.tag || m.displayName || m.id}</strong></span>
                            <span className="dist-meta">{m.isBot ? 'bot' : '@' + (m.displayName || '')}</span>
                            <button className="btn btn-ghost" onClick={() => open(m.id)}>Open file</button>
                        </div>
                    ))}
                </div>
            )}

            {!searched && <p className="hint">Search a member to open their full file — warnings, cases, notes, reports, appeals and tickets.</p>}
            {searched && error && <Empty title="Could not load the member file" hint={error.message} />}
            {searched && !error && loading && !data && <Skeleton rows={4} />}
            {searched && !error && data && (
                <div className="mt">
                    <MemberFileView member={data.member} invites={data.invites} file={data.memberFile} />
                </div>
            )}
        </Card>
    );
}

export default function ServerModTools({ serverId, reloadKey }) {
    return (
        <>
            <MemberFileSection serverId={serverId} reloadKey={reloadKey} />
            <NotesSection serverId={serverId} reloadKey={reloadKey} />
            <InvitesSection serverId={serverId} reloadKey={reloadKey} />
            <ActionsSection serverId={serverId} />
            <TempRolesSection serverId={serverId} reloadKey={reloadKey} />
        </>
    );
}

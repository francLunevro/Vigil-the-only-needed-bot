import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, timeAgo, num } from '../lib.js';
import { useLiveReload } from '../live.jsx';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Textarea, Select, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// Reusable inline modal — the ticket screen is modal-heavy (create/edit panel,
// type settings, questions, live preview, counter). Styling matches the
// existing card/field look so no extra CSS file is needed.
function Modal({ title, onClose, children, width = 460 }) {
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={onClose}>
            <div className="card" style={{ width, maxWidth: '94vw', maxHeight: '92vh', overflowY: 'auto', margin: 0 }}
                onClick={(e) => e.stopPropagation()}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '14px 18px 0' }}>
                    <strong>{title}</strong>
                    <Button variant="ghost" onClick={onClose} aria-label="Close">✖</Button>
                </div>
                <div className="card-body">{children}</div>
            </div>
        </div>
    );
}

function Field({ label, hint, children }) {
    return (
        <div className="field-block">
            <label>{label}</label>
            {children}
            {hint && <p className="hint">{hint}</p>}
        </div>
    );
}

// ──────────────────── Shared small pieces ────────────────────

// Toggleable role chips (replaces the vanilla multi-select).
function RoleChips({ roles, selected, onToggle }) {
    if (!roles || !roles.length) return <p className="hint">No roles available</p>;
    return (
        <div className="chip-row">
            {roles.map((r) => (
                <button key={r.id} type="button"
                    className={'chip' + (selected.includes(r.id) ? ' chip-on' : '')}
                    onClick={() => onToggle(r.id)}>
                    {r.name}
                </button>
            ))}
        </div>
    );
}

const STATUS_LABEL = { open: 'Open', claimed: 'Claimed', closed: 'Closed' };

// ──────────────────── Live preview modal ────────────────────
// Simulates the Discord message the panel posts, then walks the creation flow
// (questions → answers embed → welcome embed) the way the bot does it live.
function PreviewModal({ serverId, panel, channels, servers, onClose, onSent }) {
    const toast = useToast();
    const [picked, setPicked] = useState('');
    const [channelId, setChannelId] = useState('');
    const [sending, setSending] = useState(false);

    const types = panel.types || [];
    const textChannels = channels.filter((c) => c.type === 0 || c.type === 5);
    const color = panel.color || '#5865F2';
    const desc = panel.description || 'Click the button below to create a ticket.';
    const server = (servers || []).find((s) => s.id === serverId);
    const timeStr = 'Today at ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

    const active = types.find((t) => t.id === picked) || null;

    function pickType(id) {
        setPicked(id);
    }

    const questions = active ? (Array.isArray(active.questions) ? active.questions : []) : [];
    const chName = active
        ? (active.ticket_name_format || 'ticket-{username}-{number}')
            .replace('{username}', 'you').replace('{number}', '0001').replace('{name}', 'you')
            .replace('{type}', 'ticket').replace('{category}', 'ticket')
            .replace(/[^a-z0-9-]/g, '')
        : '';

    async function send() {
        if (!channelId) { toast('Select a channel first', true); return; }
        setSending(true);
        try {
            await api.post('/api/server/' + serverId + '/tickets/panels/' + panel.id + '/send', { channelId });
            toast('Panel sent');
            onSent();
            onClose();
        } catch (err) {
            toast(err.message || 'Could not send panel', true);
        } finally {
            setSending(false);
        }
    }

    return (
        <Modal title={'Live preview: ' + (panel.name || 'Unnamed')} onClose={onClose} width={560}>
            {/* Discord message frame */}
            <div className="preview-message">
                <div className="preview-avatar">{server && server.icon ? <img src={server.icon} alt="" /> : '🎫'}</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="preview-meta">
                        <span className="preview-name">Ticket Bot</span>
                        <span className="preview-bot">BOT</span>
                        <span className="preview-time">{timeStr}</span>
                    </div>
                    <div className="preview-embed" style={{ borderLeftColor: color }}>
                        {server && <div className="preview-author">{server.name}</div>}
                        <div className="preview-title">🎫 {panel.name || 'Support Tickets'}</div>
                        <div className="preview-desc">{desc}</div>
                        {panel.image_url && <img className="preview-img" src={panel.image_url} alt="" />}
                        <div className="preview-footer">{timeStr}</div>
                    </div>
                    <div className="preview-comps">
                        {types.length > 1
                            ? (
                                <select className="preview-select" value={picked} onChange={(e) => pickType(e.target.value)}>
                                    <option value="">Choose a ticket type...</option>
                                    {types.map((t) => <option key={t.id} value={t.id}>{t.emoji || '🎫'} {t.name}</option>)}
                                </select>
                            )
                            : <button className="preview-btn" onClick={() => setPicked(types[0] ? types[0].id : 'none')}>🎫 Create Ticket</button>}
                    </div>
                </div>
            </div>

            {/* Simulated flow once a type is picked */}
            {active && (
                <div className="preview-flow">
                    {questions.length > 0 && (
                        <>
                            <div className="preview-note">📋 {questions.length} question{questions.length > 1 ? 's' : ''} will be asked when the ticket opens:</div>
                            {questions.slice(0, 5).map((q, i) => (
                                <div className="preview-question" key={i}>
                                    <label>{q.label || q.question || 'Question ' + (i + 1)}{(q.required !== false) ? ' *' : ''}</label>
                                    <input type="text" placeholder={q.placeholder || ''} disabled />
                                </div>
                            ))}
                        </>
                    )}
                    <div className="preview-success">
                        ✅ Your <b>{active.emoji || '🎫'} {active.name}</b> ticket has been created! <code>#{chName}</code>
                    </div>
                    <div className="preview-embed" style={{ borderLeftColor: color }}>
                        <div className="preview-title">🎫 {active.name} Ticket</div>
                        <div className="preview-desc">{active.welcome_message || 'Thank you for creating a ticket. A staff member will be with you shortly.'}</div>
                        <div className="preview-footer">Created By: @you · Type: {active.emoji || '🎫'} {active.name}</div>
                    </div>
                </div>
            )}

            <div className="modal-foot">
                <Field label="Send to channel">
                    <div className="form-row">
                        <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                            <option value="">Select a channel…</option>
                            {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                        </Select>
                        <Button onClick={send} disabled={sending}>{sending ? 'Sending…' : '📤 Send'}</Button>
                    </div>
                </Field>
            </div>
        </Modal>
    );
}

// ──────────────────── Questions editor modal ────────────────────
function QuestionsModal({ serverId, panelId, type, onClose, onSaved }) {
    const toast = useToast();
    const [rows, setRows] = useState(() => (Array.isArray(type.questions) ? type.questions : []).map((q) => ({
        label: q.label || q.question || '',
        placeholder: q.placeholder || '',
        required: q.required !== false,
    })));

    function update(i, key, value) {
        setRows((prev) => prev.map((r, j) => (j === i ? { ...r, [key]: value } : r)));
    }

    function addRow() {
        if (rows.length >= 5) { toast('Maximum 5 questions per type', true); return; }
        setRows((prev) => [...prev, { label: '', placeholder: '', required: true }]);
    }

    function removeRow(i) {
        setRows((prev) => prev.filter((_, j) => j !== i));
    }

    async function save() {
        const qs = rows.filter((r) => r.label.trim());
        if (!qs.length) { toast('Add at least one question with a label', true); return; }
        if (qs.length < rows.length) toast((rows.length - qs.length) + ' empty question(s) skipped');
        try {
            await api.put('/api/server/' + serverId + '/tickets/panels/' + panelId + '/types/' + type.id, { questions: qs });
            toast('Questions saved');
            onSaved();
            onClose();
        } catch (err) {
            toast(err.message || 'Could not save questions', true);
        }
    }

    return (
        <Modal title={'📝 Questions for ' + (type.name || 'type')} onClose={onClose} width={480}>
            {rows.length === 0 && <p className="hint">No questions yet. Add one below.</p>}
            {rows.map((q, i) => (
                <div className="question-row" key={i}>
                    <div className="form-row">
                        <span className="hint">{i + 1}.</span>
                        <Input placeholder="Question label…" value={q.label} onChange={(e) => update(i, 'label', e.target.value)} />
                        <Button variant="ghost" onClick={() => removeRow(i)}>✖</Button>
                    </div>
                    <div className="form-row">
                        <Input placeholder="Placeholder text" value={q.placeholder} onChange={(e) => update(i, 'placeholder', e.target.value)} />
                        <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                            <input type="checkbox" checked={q.required} onChange={(e) => update(i, 'required', e.target.checked)} /> Required
                        </label>
                    </div>
                </div>
            ))}
            <div className="form-row mt">
                <Button variant="ghost" onClick={addRow}>+ Add question</Button>
                <Button onClick={save}>✔ Save</Button>
            </div>
        </Modal>
    );
}

// ──────────────────── Type settings modal (create + edit) ────────────────────
function TypeModal({ serverId, panelId, type, categories, roles, onClose, onSaved }) {
    const toast = useToast();
    const editing = !!type;
    const [name, setName] = useState(type ? (type.name || '') : '');
    const [emoji, setEmoji] = useState(type ? (type.emoji || '🎫') : '🎫');
    const [categoryId, setCategoryId] = useState(type ? (type.category_id || '') : '');
    const [roleIds, setRoleIds] = useState(type ? (Array.isArray(type.support_roles) ? type.support_roles : []) : []);
    const [welcome, setWelcome] = useState(type ? (type.welcome_message || 'Thank you for creating a ticket. A staff member will be with you shortly.') : 'Thank you for creating a ticket. A staff member will be with you shortly.');
    const [nameFormat, setNameFormat] = useState(type ? (type.ticket_name_format || 'ticket-{username}-{number}') : 'ticket-{username}-{number}');
    const [busy, setBusy] = useState(false);

    function toggleRole(id) {
        setRoleIds((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id]));
    }

    async function save() {
        if (!name.trim()) { toast('Enter a type name', true); return; }
        setBusy(true);
        const body = {
            name: name.trim(),
            emoji: emoji.trim() || '🎫',
            category_id: categoryId || null,
            support_roles: roleIds,
            welcome_message: welcome.trim(),
            ticket_name_format: nameFormat.trim() || 'ticket-{username}-{number}',
        };
        try {
            if (editing) {
                await api.put('/api/server/' + serverId + '/tickets/panels/' + panelId + '/types/' + type.id, body);
                toast('Settings saved');
            } else {
                await api.post('/api/server/' + serverId + '/tickets/panels/' + panelId + '/types', body);
                toast('Type added');
            }
            onSaved();
            onClose();
        } catch (err) {
            toast(err.message || 'Could not save type', true);
        } finally {
        setBusy(false);
        }
    }

    return (
        <Modal title={(editing ? '⚙️ ' + (type.emoji || '🎫') + ' ' + type.name + ' settings' : '➕ Add ticket type')} onClose={onClose} width={500}>
            <Field label="Type name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. General Support, Appeals" />
            </Field>
            <Field label="Emoji">
                <Input value={emoji} onChange={(e) => setEmoji(e.target.value)} style={{ maxWidth: 120 }} />
            </Field>
            <Field label="Category">
                <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                    <option value="">None</option>
                    {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
            </Field>
            <Field label="Support roles (who can see tickets)" hint="Click roles to toggle them on/off">
                <RoleChips roles={roles} selected={roleIds} onToggle={toggleRole} />
            </Field>
            <Field label="Welcome message">
                <Textarea rows={2} value={welcome} onChange={(e) => setWelcome(e.target.value)} />
            </Field>
            <Field label="Channel name format" hint="Variables: {username}, {number}, {name}">
                <Input value={nameFormat} onChange={(e) => setNameFormat(e.target.value)} />
            </Field>
            <div className="form-row mt">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : (editing ? 'Save settings' : 'Add type')}</Button>
            </div>
        </Modal>
    );
}

// ──────────────────── Panel modal (create + edit) ────────────────────
function PanelModal({ panel, onClose, onSaved, serverId }) {
    const toast = useToast();
    const editing = !!panel;
    const [name, setName] = useState(panel ? (panel.name || '') : '');
    const [description, setDescription] = useState(panel ? (panel.description || '') : '');
    const [color, setColor] = useState(panel ? (panel.color || '#5865F2') : '#5865F2');
    const [busy, setBusy] = useState(false);

    async function save() {
        if (!name.trim()) { toast('Enter a panel name', true); return; }
        setBusy(true);
        try {
            if (editing) {
                await api.put('/api/server/' + serverId + '/tickets/panels/' + panel.id, { name: name.trim(), description, color });
                toast('Panel updated');
            } else {
                await api.post('/api/server/' + serverId + '/tickets/panels', { name: name.trim(), description, color });
                toast('Panel created');
            }
            onSaved();
            onClose();
        } catch (err) {
            toast(err.message || 'Could not save panel', true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title={editing ? '✏️ Edit panel' : '✨ Create ticket panel'} onClose={onClose} width={440}>
            <Field label="Panel name">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Support, Applications" />
            </Field>
            <Field label="Description">
                <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)}
                    placeholder="Click the button below to create a ticket…" />
            </Field>
            <Field label="Accent colour">
                <input type="color" className="color-input" value={color} onChange={(e) => setColor(e.target.value)} />
            </Field>
            <div className="form-row mt">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : (editing ? 'Save changes' : 'Create panel')}</Button>
            </div>
        </Modal>
    );
}

// ──────────────────── Ticket SLA ────────────────────
// Response-time tracking (src/ticketSla.js). Three pieces, all fed by the same
// route the rest of this screen already reads:
//   • the thresholds, written back through the same ticket config route
//   • the statistics for the window the server returned
//   • a per-ticket badge in the recent list
// The two presentational ones are exported so they can be rendered directly in
// a test, without a server or a fetch.

const SLA_LABEL = { waiting: 'Waiting', overdue: 'Overdue', met: 'On time', late: 'Late' };
const SLA_TONE = { waiting: 'default', overdue: 'bad', met: 'good', late: 'warn' };

// "45m" / "2h 5m" / "1d 3h" — the same compact shape the bot's formatDuration
// produces for the ticket embeds, so a wait reads identically in both places.
function durationLabel(ms) {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return '—';
    const secs = Math.max(0, Math.floor(Number(ms) / 1000));
    const days = Math.floor(secs / 86400);
    const hours = Math.floor((secs % 86400) / 3600);
    const mins = Math.floor((secs % 3600) / 60);
    if (days > 0) return days + 'd ' + hours + 'h';
    if (hours > 0) return hours + 'h ' + mins + 'm';
    if (mins > 0) return mins + 'm';
    return secs + 's';
}

export function SlaBadge({ state }) {
    if (!state) return null;
    return <Badge tone={SLA_TONE[state] || 'default'}>{SLA_LABEL[state] || state}</Badge>;
}

// Pure: takes the `sla` payload the route returns and renders it.
export function SlaOverview({ sla }) {
    if (!sla) {
        return <p className="hint">This server did not return SLA data. Reload the page; check the Errors screen if it persists.</p>;
    }
    if (!sla.enabled) {
        return <p className="hint">Response-time tracking is off for this server. Turn it on to start recording first-response times.</p>;
    }

    const stats = sla.stats || {};
    const responded = stats.responded || {};
    const open = stats.open || {};
    const breaches = stats.breaches || {};
    const waits = sla.waits || [];
    const target = stats.targetMs ? durationLabel(stats.targetMs) : 'no target';

    return (
        <>
            <div className="kv-grid">
                <div className="kv"><span>Target</span><strong>{target}</strong></div>
                <div className="kv"><span>Answered</span><strong>{num(responded.count || 0)}</strong></div>
                <div className="kv"><span>Average response</span><strong>{durationLabel(responded.averageMs)}</strong></div>
                <div className="kv"><span>Median response</span><strong>{durationLabel(responded.medianMs)}</strong></div>
                <div className="kv"><span>Answered in target</span><strong>{num(responded.withinTarget || 0)}</strong></div>
                <div className="kv"><span>Breaches</span><strong>{num(breaches.total || 0)}</strong></div>
                <div className="kv"><span>Waiting now</span><strong>{num(open.waiting || 0)}</strong></div>
                <div className="kv"><span>Overdue now</span><strong>{num(open.overdue || 0)}</strong></div>
                <div className="kv"><span>Oldest open</span><strong>{durationLabel(open.oldestWaitMs)}</strong></div>
            </div>

            <p className="hint">
                Last {num(stats.windowDays || 0)} days · alert after{' '}
                {stats.alertAfterMs ? durationLabel(stats.alertAfterMs) : 'never'} ·{' '}
                {num(breaches.respondedLate || 0)} answered late, {num(breaches.openOverdue || 0)} still unanswered past the target.
            </p>

            {waits.length === 0
                ? <p className="hint">No ticket is waiting for a first response right now.</p>
                : (
                    <div className="rows mt">
                        {waits.map((w) => (
                            <div className="dist" key={w.id}>
                                <div style={{ minWidth: 0 }}>
                                    <strong>#{w.ticketNumber} {w.creatorTag || 'Unknown'}</strong>
                                    {w.panelTypeName ? <span className="hint"> · {w.panelTypeName}</span> : null}
                                    <div className="hint">
                                        waiting {durationLabel(w.waitedMs)}
                                        {w.claimerId ? ' · claimed' : ''}
                                    </div>
                                </div>
                                <SlaBadge state={w.state} />
                            </div>
                        ))}
                    </div>
                )}
        </>
    );
}

function SlaSettingsCard({ serverId, sla, channels, onSaved }) {
    const toast = useToast();
    const cfg = sla || {};
    const [enabled, setEnabled] = useState(cfg.enabled !== false);
    const [target, setTarget] = useState(cfg.firstResponseMinutes === null || cfg.firstResponseMinutes === undefined ? '' : String(cfg.firstResponseMinutes));
    const [alertAfter, setAlertAfter] = useState(cfg.alertAfterMinutes === null || cfg.alertAfterMinutes === undefined ? '' : String(cfg.alertAfterMinutes));
    const [alertChannel, setAlertChannel] = useState(cfg.alertChannelId || '');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    // Re-seed when the server changes or the stored config comes back different
    // (a save followed by a reload is exactly that).
    useEffect(() => {
        setEnabled(cfg.enabled !== false);
        setTarget(cfg.firstResponseMinutes === null || cfg.firstResponseMinutes === undefined ? '' : String(cfg.firstResponseMinutes));
        setAlertAfter(cfg.alertAfterMinutes === null || cfg.alertAfterMinutes === undefined ? '' : String(cfg.alertAfterMinutes));
        setAlertChannel(cfg.alertChannelId || '');
        setError(null);
    }, [serverId, cfg.enabled, cfg.firstResponseMinutes, cfg.alertAfterMinutes, cfg.alertChannelId]);

    async function save() {
        setBusy(true);
        setError(null);
        try {
            // Blank means "no target" / "never alert", which the API takes as
            // null. Anything that isn't a whole number is left for the server's
            // validator to refuse, so the message the user sees is the one rule
            // every caller is held to.
            await api.post('/api/server/' + serverId + '/tickets/config', {
                sla: {
                    enabled,
                    firstResponseMinutes: target.trim() === '' ? null : Number(target),
                    alertAfterMinutes: alertAfter.trim() === '' ? null : Number(alertAfter),
                    alertChannelId: alertChannel || null,
                },
            });
            toast('Response targets saved');
            if (onSaved) onSaved();
        } catch (err) {
            setError(err.message || 'Could not save response targets');
        } finally {
            setBusy(false);
        }
    }

    const textChannels = (channels || []).filter((c) => c.type === 0 || c.type === 5);

    return (
        <Card title="Response targets (SLA)" icon="pulse">
            <div className="dist">
                <div>
                    <div>Track first-response times</div>
                    <span className="hint">Record when staff first answer each ticket</span>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
                    <Badge tone={enabled ? 'good' : 'default'}>{enabled ? 'On' : 'Off'}</Badge>
                </label>
            </div>

            <div className="field-block">
                <label>First response target (minutes)</label>
                <Input type="number" min="1" placeholder="60" value={target}
                    onChange={(e) => setTarget(e.target.value)} />
                <p className="hint">Counting starts when the ticket opens. Leave blank for no target — times are still recorded and shown.</p>
            </div>

            <div className="field-block">
                <label>Alert staff after (minutes)</label>
                <Input type="number" min="1" placeholder="120" value={alertAfter}
                    onChange={(e) => setAlertAfter(e.target.value)} />
                <p className="hint">A ticket that is still unanswered after this long is posted to the alert channel, once.</p>
            </div>

            <div className="field-block">
                <label>Alert channel</label>
                <Select value={alertChannel} onChange={(e) => setAlertChannel(e.target.value)}>
                    <option value="">Ticket log channel</option>
                    {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                </Select>
            </div>

            {error && <p className="result result-bad" role="alert">{error}</p>}

            <div className="row-actions mt">
                <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save response targets'}</Button>
            </div>
        </Card>
    );
}

// ──────────────────── Main screen ────────────────────
export default function Tickets() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/tickets') : Promise.resolve(null)),
        [serverId]
    );

    const [panelSel, setPanelSel] = useState('');
    const [typeSel, setTypeSel] = useState('');
    const [filter, setFilter] = useState('');
    const [modal, setModal] = useState(null); // { kind, ...payload }
    const [logChannel, setLogChannel] = useState('');
    const [freqRoles, setFreqRoles] = useState([]);   // quick-config support roles
    const [freqCategory, setFreqCategory] = useState(''); // quick-config category
    const [freqDirty, setFreqDirty] = useState(false);

    // Claim/transfer events arrive over SSE; refresh the recent-tickets list
    // when they do (skip while a modal is open so it isn't pulled from under
    // the user).
    useLiveReload(() => { if (!modal) reload(); });

    const header = <PageHeader title="Tickets" sub="Ticket panels, types, and recent tickets" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Create ticket panels, configure ticket types, and view recent tickets." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={6} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load tickets" hint={error && error.message} />
            </>
        );
    }

    const config = data.config || {};
    const panels = data.panels || [];
    const tickets = data.tickets || [];
    const channels = data.channels || [];
    const roles = data.roles || [];
    const categories = channels.filter((c) => c.type === 4);
    const textChannels = channels.filter((c) => c.type === 0 || c.type === 5);

    // Selected panel + type, kept across reloads while the ids stay valid.
    const panel = panels.find((p) => p.id === panelSel) || panels[0] || null;
    const types = panel ? (panel.types || []) : [];
    const type = types.find((t) => t.id === typeSel) || types[0] || null;

    // Seed quick-config pickers from the selected type once loaded.
    useEffect(() => {
        if (!type) return;
        setFreqRoles(Array.isArray(type.support_roles) ? type.support_roles : []);
        setFreqCategory(type.category_id || '');
        setFreqDirty(false);
    }, [type && type.id]);

    const filteredTickets = filter ? tickets.filter((t) => t.status === filter) : tickets;

    async function call(fn, message) {
        try {
            await fn();
            toast(message);
            reload();
        } catch (err) {
            toast(err.message || 'Action failed', true);
        }
    }

    async function saveLogChannel(v) {
        setLogChannel(v);
        try {
            await api.post('/api/server/' + serverId + '/tickets/config', { logChannelId: v || null });
            toast('Log channel updated');
        } catch (err) {
            toast(err.message || 'Could not update log channel', true);
        }
    }

    async function saveQuickConfig() {
        if (!panel || !type) { toast('No type to update', true); return; }
        try {
            await api.put('/api/server/' + serverId + '/tickets/panels/' + panel.id + '/types/' + type.id,
                { support_roles: freqRoles, category_id: freqCategory || null });
            toast('Settings saved');
            setFreqDirty(false);
            reload();
        } catch (err) {
            toast(err.message || 'Save failed', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <div className="grid grid-2">
                {/* Left column: config + actions */}
                <div>
                    <Card title="General ticket options" icon="sliders">
                        <div className="dist">
                            <div>
                                <div>Ticket system</div>
                                <span className="hint">Enable or disable tickets on this server</span>
                            </div>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                <input type="checkbox" checked={!!config.enabled}
                                    onChange={(e) => call(() => api.post('/api/server/' + serverId + '/tickets/config', { enabled: e.target.checked }), 'Ticket system ' + (e.target.checked ? 'enabled' : 'disabled'))} />
                                <Badge tone={config.enabled ? 'good' : 'default'}>{config.enabled ? 'Enabled' : 'Disabled'}</Badge>
                            </label>
                        </div>
                        <div className="field-block">
                            <label>Transcript log channel</label>
                            <Select value={logChannel || config.logChannelId || ''} onChange={(e) => saveLogChannel(e.target.value)}>
                                <option value="">None</option>
                                {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                            </Select>
                        </div>
                        <p className="hint">{num(config.ticketCount)} tickets created all-time</p>
                    </Card>

                    <div className="mt">
                        <SlaSettingsCard serverId={serverId} sla={data.sla && data.sla.config} channels={channels} onSaved={reload} />
                    </div>

                    <div className="mt">
                        <Card title="Advanced settings" icon="wrench">
                            <div className="dist">
                                <div>
                                    <div>Auto-close on leave</div>
                                    <span className="hint">Close tickets when the creator leaves the server</span>
                                </div>
                                <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                    <input type="checkbox" checked={!!config.closeOnLeave}
                                        onChange={(e) => call(() => api.post('/api/server/' + serverId + '/tickets/config', { closeOnLeave: e.target.checked }), 'Auto-close ' + (e.target.checked ? 'enabled' : 'disabled'))} />
                                    <Badge tone={config.closeOnLeave ? 'good' : 'default'}>{config.closeOnLeave ? 'On' : 'Off'}</Badge>
                                </label>
                            </div>
                        </Card>
                    </div>
                </div>

                {/* Right column: panels */}
                <div>
                    <Card title={'Panel settings (' + num(panels.length) + ')'} icon="grid"
                        action={<Button onClick={() => setModal({ kind: 'panel-create' })}>+ New panel</Button>}>
                        <div className="form-row">
                            <Select value={panel ? panel.id : ''} onChange={(e) => { setPanelSel(e.target.value); setTypeSel(''); }}>
                                <option value="">Select a panel…</option>
                                {panels.map((p, i) => <option key={p.id} value={p.id}>{(i + 1) + ' | ' + p.name}</option>)}
                            </Select>
                        </div>

                        {!panel ? <p className="hint">No panel selected. Select one above or create a new one.</p> : (
                            <>
                                <div className="row-actions mt">
                                    <Button variant="ghost" onClick={() => setModal({ kind: 'preview' })}>👁 Preview</Button>
                                    <Button variant="ghost" onClick={() => setModal({ kind: 'preview' })}>📨 Send</Button>
                                    <Button variant="ghost" onClick={() => call(() => api.post('/api/server/' + serverId + '/tickets/panels/' + panel.id + '/clone'), 'Panel cloned')}>🔄 Clone</Button>
                                    <Button variant="ghost" onClick={() => setModal({ kind: 'panel-edit' })}>✏️ Rename/Edit</Button>
                                    <Button variant="ghost" onClick={() => setModal({ kind: 'count' })}>🔢 Set count</Button>
                                    <Button variant="ghost" onClick={() => { if (window.confirm('Delete this panel and all its types? This cannot be undone.')) call(() => api.del('/api/server/' + serverId + '/tickets/panels/' + panel.id), 'Panel deleted'); }}>✖ Delete</Button>
                                </div>

                                {/* Ticket type picker */}
                                <div className="form-row mt">
                                    <Select value={type ? type.id : ''} onChange={(e) => setTypeSel(e.target.value)}>
                                        {types.length === 0 && <option value="">No types yet</option>}
                                        {types.map((t) => <option key={t.id} value={t.id}>{(t.emoji || '🎫') + ' ' + t.name}</option>)}
                                    </Select>
                                    <Button variant="ghost" onClick={() => setModal({ kind: 'type-create' })}>+ Add type</Button>
                                </div>

                                {type && (
                                    <div className="mt">
                                        <div className="kv-grid">
                                            <div className="kv"><span>Category</span><strong>{(categories.find((c) => c.id === type.category_id) || {}).name || 'None'}</strong></div>
                                            <div className="kv"><span>Questions</span><strong>{(Array.isArray(type.questions) ? type.questions.length : 0)}</strong></div>
                                            <div className="kv"><span>Support roles</span><strong>{(Array.isArray(type.support_roles) ? type.support_roles.length : 0) || 'None'}</strong></div>
                                            <div className="kv"><span>Name format</span><strong>{type.ticket_name_format || 'ticket-{username}-{number}'}</strong></div>
                                        </div>
                                        <div className="row-actions mt">
                                            <Button variant="ghost" onClick={() => setModal({ kind: 'type-edit' })}>⚙️ Edit settings</Button>
                                            <Button variant="ghost" onClick={() => setModal({ kind: 'questions' })}>📝 Questions</Button>
                                            <Button variant="ghost" onClick={() => { if (window.confirm('Delete this ticket type? This cannot be undone.')) call(() => api.del('/api/server/' + serverId + '/tickets/panels/' + panel.id + '/types/' + type.id), 'Type deleted'); }}>🗑️ Delete</Button>
                                        </div>
                                    </div>
                                )}

                                {/* Quick config: roles + category for the selected type */}
                                <div className="mt">
                                    <div className="field-block">
                                        <label>Support team roles</label>
                                        <RoleChips roles={roles} selected={freqRoles}
                                            onToggle={(id) => { setFreqRoles((prev) => (prev.includes(id) ? prev.filter((r) => r !== id) : [...prev, id])); setFreqDirty(true); }} />
                                    </div>
                                    <div className="field-block">
                                        <label>Category created/opened</label>
                                        <Select value={freqCategory} onChange={(e) => { setFreqCategory(e.target.value); setFreqDirty(true); }}>
                                            <option value="">None</option>
                                            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                        </Select>
                                        <p className="hint">Applies to the selected type. Per-type settings override.</p>
                                    </div>
                                    {freqDirty && (
                                        <div className="row-actions">
                                            <Button variant="ghost" onClick={() => {
                                                setFreqRoles(Array.isArray(type.support_roles) ? type.support_roles : []);
                                                setFreqCategory(type.category_id || '');
                                                setFreqDirty(false);
                                            }}>Reset</Button>
                                            <Button onClick={saveQuickConfig}>Save</Button>
                                        </div>
                                    )}
                                </div>
                            </>
                        )}
                    </Card>
                </div>
            </div>

            {/* Recent tickets */}
            <div className="mt">
                <Card title={'Recent tickets (' + num(tickets.length) + ')'} icon="bell">
                    <div className="row-actions">
                        {['', 'open', 'claimed', 'closed'].map((f) => (
                            <Button key={f || 'all'} variant={filter === f ? 'primary' : 'ghost'} onClick={() => setFilter(f)}>
                                {f === '' ? 'All' : STATUS_LABEL[f]}
                            </Button>
                        ))}
                        <span className="hint">{filteredTickets.filter((t) => t.status === 'open').length} open</span>
                    </div>
                    {filteredTickets.length === 0
                        ? <Empty title={tickets.length ? 'No ' + (filter || '') + ' tickets yet' : 'No tickets have been created yet.'} />
                        : (
                            <div className="rows">
                                {filteredTickets.slice(0, 15).map((t) => (
                                    <div className="dist" key={t.id}>
                                        <div style={{ minWidth: 0 }}>
                                            <strong>#{t.ticketNumber} {t.creatorTag || 'Unknown'}</strong>
                                            {t.panelTypeName ? <span className="hint"> · {t.panelTypeName}</span> : null}
                                            {t.status !== 'closed' && (
                                                <div className="hint">
                                                    waiting {durationLabel(t.waitedMs)}
                                                    {t.slaBreached ? ' · past the target' : ''}
                                                    {!t.slaBreached && t.firstResponseAt ? ' · answered ' + durationLabel(t.firstResponseMs) + ' after opening' : ''}
                                                </div>
                                            )}
                                            {t.status === 'closed' && t.closedAt && (
                                                <div className="hint">closed {timeAgo(t.closedAt)}{t.closedByTag ? ' by ' + t.closedByTag : ''}{t.closedReason ? ' · ' + t.closedReason : ''}</div>
                                            )}
                                            {t.status === 'closed' && t.firstResponseAt && (
                                                <div className="hint">first response {durationLabel(t.firstResponseMs)} after opening</div>
                                            )}
                                        </div>
                                        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                            {t.status !== 'closed' && <SlaBadge state={t.slaState} />}
                                            <Badge tone={t.status === 'open' ? 'good' : t.status === 'claimed' ? 'warn' : 'default'}>{STATUS_LABEL[t.status] || t.status}</Badge>
                                        </span>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>

            {/* Response times (SLA) */}
            <div className="mt">
                <Card title="Response times" icon="chart">
                    <SlaOverview sla={data.sla} />
                </Card>
            </div>

            {/* Modals */}
            {modal && modal.kind === 'panel-create' && (
                <PanelModal serverId={serverId} onClose={() => setModal(null)} onSaved={reload} />
            )}
            {modal && modal.kind === 'panel-edit' && panel && (
                <PanelModal serverId={serverId} panel={panel} onClose={() => setModal(null)} onSaved={reload} />
            )}
            {modal && modal.kind === 'count' && panel && (
                <CountModal serverId={serverId} panel={panel} onClose={() => setModal(null)} onSaved={reload} />
            )}
            {modal && modal.kind === 'preview' && panel && (
                <PreviewModal serverId={serverId} panel={panel} channels={channels} servers={servers}
                    onClose={() => setModal(null)} onSent={reload} />
            )}
            {modal && modal.kind === 'type-create' && panel && (
                <TypeModal serverId={serverId} panelId={panel.id} categories={categories} roles={roles}
                    onClose={() => setModal(null)} onSaved={reload} />
            )}
            {modal && modal.kind === 'type-edit' && panel && type && (
                <TypeModal serverId={serverId} panelId={panel.id} type={type} categories={categories} roles={roles}
                    onClose={() => setModal(null)} onSaved={reload} />
            )}
            {modal && modal.kind === 'questions' && panel && type && (
                <QuestionsModal serverId={serverId} panelId={panel.id} type={type}
                    onClose={() => setModal(null)} onSaved={reload} />
            )}
        </>
    );
}

// ──────────────────── Set counter modal ────────────────────
function CountModal({ serverId, panel, onClose, onSaved }) {
    const toast = useToast();
    const [count, setCount] = useState(panel.ticket_counter > 0 ? panel.ticket_counter : 1);
    const [busy, setBusy] = useState(false);

    async function save() {
        const val = parseInt(count);
        if (isNaN(val) || val < 0) { toast('Enter a valid number >= 0', true); return; }
        setBusy(true);
        try {
            await api.put('/api/server/' + serverId + '/tickets/panels/' + panel.id + '/count', { count: val });
            toast('Counter set');
            onSaved();
            onClose();
        } catch (err) {
            toast(err.message || 'Could not set counter', true);
        } finally {
            setBusy(false);
        }
    }

    return (
        <Modal title="🔢 Set ticket counter" onClose={onClose} width={360}>
            <Field label="Next ticket number">
                <Input type="number" min="0" value={count} onChange={(e) => setCount(e.target.value)} />
            </Field>
            <p className="hint">Panel: <strong>{panel.name}</strong> · Current: <strong>{panel.ticket_counter || 0}</strong>. Set to 0 to auto-increment.</p>
            <div className="form-row mt">
                <Button variant="ghost" onClick={onClose}>Cancel</Button>
                <Button onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Set'}</Button>
            </div>
        </Modal>
    );
}

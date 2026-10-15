import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Select, Badge } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// Same labels the vanilla section used for match types.
const MATCH_LABELS = {
    exact: 'exact message',
    contains: 'contains',
    startswith: 'starts with',
    regex: 'regex',
};

// One command row: name, response preview, uses, edit + delete.
function CommandRow({ serverId, prefix, cmd, onEdit, onChanged }) {
    const toast = useToast();

    async function remove() {
        try {
            await api.del('/api/server/' + serverId + '/custom-commands/' + encodeURIComponent(cmd.name));
            toast('Command deleted');
            onChanged();
        } catch (err) {
            toast(err.message || 'Could not delete', true);
        }
    }

    return (
        <div className="dist">
            <div style={{ minWidth: 0 }}>
                <span className="mono">{prefix}{cmd.name}</span>
                {cmd.asEmbed ? <Badge>embed</Badge> : null}
                {cmd.uses ? <span className="hint"> · {num(cmd.uses)} uses</span> : null}
                <div className="hint" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {cmd.response.length > 300 ? cmd.response.slice(0, 300) + '…' : cmd.response}
                </div>
            </div>
            <div className="row-actions">
                <Button variant="ghost" onClick={() => onEdit(cmd)}>Edit</Button>
                <Button variant="ghost" onClick={remove}>Delete</Button>
            </div>
        </div>
    );
}

// One autoresponder row: trigger, match type, channel, pause toggle, delete.
function ResponderRow({ serverId, responder, channels, onChanged }) {
    const toast = useToast();

    async function toggle() {
        try {
            await api.patch('/api/server/' + serverId + '/autoresponders/' + encodeURIComponent(responder.id), { enabled: !responder.enabled });
            toast(responder.enabled ? 'Paused' : 'Enabled');
            onChanged();
        } catch (err) {
            toast(err.message || 'Could not update', true);
        }
    }

    async function remove() {
        try {
            await api.del('/api/server/' + serverId + '/autoresponders/' + encodeURIComponent(responder.id));
            toast('Autoresponder deleted');
            onChanged();
        } catch (err) {
            toast(err.message || 'Could not delete', true);
        }
    }

    const ch = (channels || []).find((c) => c.id === responder.channelId);

    return (
        <div className="dist">
            <div style={{ minWidth: 0 }}>
                <strong>{responder.trigger}</strong>
                <span className="hint">
                    {' · ' + (MATCH_LABELS[responder.matchType] || responder.matchType)}
                    {' · ' + (responder.channelId ? (ch ? ch.name : responder.channelId) : 'every channel')}
                    {responder.uses ? ' · ' + num(responder.uses) + ' uses' : ''}
                </span>
                <div className="hint" style={{ wordBreak: 'break-word' }}>
                    {responder.response.length > 300 ? responder.response.slice(0, 300) + '…' : responder.response}
                </div>
            </div>
            <div className="row-actions">
                <Badge tone={responder.enabled ? 'good' : 'default'}>{responder.enabled ? 'Enabled' : 'Paused'}</Badge>
                <Button variant="ghost" onClick={toggle}>{responder.enabled ? 'Pause' : 'Enable'}</Button>
                <Button variant="ghost" onClick={remove}>Delete</Button>
            </div>
        </div>
    );
}

export default function CustomCommands() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? Promise.all([
            api.get('/api/server/' + serverId + '/custom-commands'),
            api.get('/api/server/' + serverId + '/autoresponders'),
        ]) : Promise.resolve(null)),
        [serverId]
    );

    // Command form state; `editing` holds the name of the command being
    // overwritten, so the Save button acts as an update instead of a
    // duplicate-name rejection.
    const [name, setName] = useState('');
    const [response, setResponse] = useState('');
    const [asEmbed, setAsEmbed] = useState(false);
    const [editing, setEditing] = useState(null);

    const [trigger, setTrigger] = useState('');
    const [matchType, setMatchType] = useState('contains');
    const [arResponse, setArResponse] = useState('');
    const [arChannel, setArChannel] = useState('');

    const header = <PageHeader title="Custom Commands" sub="Prefix commands and autoresponders" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Custom commands are per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={5} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load custom commands" hint={error && error.message} />
            </>
        );
    }

    const [cmdData, arData] = data;
    const commands = cmdData.commands || [];
    const prefix = cmdData.prefix || ';';
    const max = cmdData.maxPerGuild || 50;
    const responders = arData.responders || [];
    const channels = arData.channels || [];
    const matchTypes = arData.matchTypes && arData.matchTypes.length ? arData.matchTypes : Object.keys(MATCH_LABELS);

    function loadForEdit(cmd) {
        setName(cmd.name);
        setResponse(cmd.response);
        setAsEmbed(!!cmd.asEmbed);
        setEditing(cmd.name);
        toast('Loaded — saving now overwrites it');
    }

    function resetForm() {
        setName('');
        setResponse('');
        setAsEmbed(false);
        setEditing(null);
    }

    async function saveCommand() {
        if (!name.trim() || !response.trim()) { toast('A name and a response are required', true); return; }
        try {
            const body = { name: name.trim(), response };
        const res = await api.post('/api/server/' + serverId + '/custom-commands', body);
        // The backend upserts by name; the loaded name is what gets overwritten.
        if (res.error) { toast(res.error, true); return; }
            toast(res.created ? 'Command created' : 'Command updated');
            resetForm();
            reload();
        } catch (err) {
            toast(err.message || 'Could not save', true);
        }
    }

    async function addResponder() {
        if (!trigger.trim() || !arResponse.trim()) { toast('A trigger and a response are required', true); return; }
        try {
            await api.post('/api/server/' + serverId + '/autoresponders',
                { trigger, response: arResponse, matchType, channelId: arChannel || null });
            setTrigger(''); setArResponse(''); setArChannel('');
            toast('Autoresponder added');
            reload();
        } catch (err) {
            toast(err.message || 'Could not add', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Card title={editing ? 'Edit command: ' + prefix + editing : 'Add a custom command'} icon="terminal"
                action={editing ? <Button variant="ghost" onClick={resetForm}>New instead</Button> : null}>
                <div className="form-row">
                    <Input placeholder="Command name (e.g. rules)" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: 220 }} />
                    <Input placeholder={'Response — {user} {server} {membercount} {channel} {args}'}
                        value={response} onChange={(e) => setResponse(e.target.value)} />
                    <label className="hint" style={{ display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
                        <input type="checkbox" checked={asEmbed} onChange={(e) => setAsEmbed(e.target.checked)} /> as embed
                    </label>
                    <Button onClick={saveCommand}>{editing ? 'Save changes' : 'Save command'}</Button>
                </div>
                <p className="hint">
                    Typed as <code className="mono">{prefix}name</code>. Built-in commands always win, so a name that already exists is rejected.
                    {' '}{commands.length}/{max} used.
                </p>
            </Card>

            <div className="mt">
                <Card title={'Commands (' + num(commands.length) + ')'} icon="terminal">
                    {commands.length === 0
                        ? <Empty title="No custom commands yet" hint="Add one above — it answers instantly, no restart." />
                        : <div className="stack-list">
                            {commands.map((c) => (
                                <CommandRow key={c.name} serverId={serverId} prefix={prefix} cmd={c}
                                    onEdit={loadForEdit} onChanged={reload} />
                            ))}
                        </div>}
                </Card>
            </div>

            <div className="mt">
                <Card title={'Autoresponders (' + num(responders.length) + ')'} icon="heart">
                    <div className="form-row">
                        <Input placeholder="Trigger text" value={trigger} onChange={(e) => setTrigger(e.target.value)} style={{ maxWidth: 220 }} />
                        <Select value={matchType} onChange={(e) => setMatchType(e.target.value)} style={{ maxWidth: 150 }}>
                            {matchTypes.map((m) => <option key={m} value={m}>{MATCH_LABELS[m] || m}</option>)}
                        </Select>
                        <Input placeholder="Response" value={arResponse} onChange={(e) => setArResponse(e.target.value)} />
                        <Select value={arChannel} onChange={(e) => setArChannel(e.target.value)} style={{ maxWidth: 180 }}>
                            <option value="">Every channel</option>
                            {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </Select>
                        <Button onClick={addResponder}>Add autoresponder</Button>
                    </div>
                    <p className="hint">Fires on ordinary messages (bots and its own replies are ignored), one response per message, throttled per member so a trigger cannot loop.</p>
                    {responders.length === 0
                        ? <p className="hint">No autoresponders yet.</p>
                        : <div className="rows mt">
                            {responders.map((a) => (
                                <ResponderRow key={a.id} serverId={serverId} responder={a} channels={channels} onChanged={reload} />
                            ))}
                        </div>}
                </Card>
            </div>
        </>
    );
}

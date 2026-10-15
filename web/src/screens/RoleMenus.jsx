import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Select, Loaded } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// One menu's option editor. Options are loaded per menu, because the list
// endpoint returns menus only.
function OptionEditor({ serverId, menu, channels, rolesList, onChanged }) {
    const toast = useToast();
    const { data, loading, reload } = useAsync(
        () => api.get('/api/server/' + serverId + '/role-menus/' + menu.message_id + '/options').catch(() => ({ options: [] })),
        [serverId, menu.message_id]
    );
    const [roleId, setRoleId] = useState('');
    const [emoji, setEmoji] = useState('');
    const [label, setLabel] = useState('');

    const options = (data && data.options) || [];
    const roleName = (id) => (rolesList.find((r) => r.id === id) || {}).name || id;
    const channelName = (id) => (channels.find((c) => c.id === id) || {}).name || id;

    async function add() {
        if (!roleId) return;
        try {
            await api.post('/api/server/' + serverId + '/role-menus/' + menu.message_id + '/options',
                { roleId, label: label || null, emoji: emoji || null, description: null });
            setRoleId(''); setEmoji(''); setLabel('');
            toast('Option added');
            reload();
        } catch (err) {
            toast(err.message || 'Could not add option', true);
        }
    }

    async function remove(optionRoleId) {
        try {
            await api.del('/api/server/' + serverId + '/role-menus/' + menu.message_id + '/options', { roleId: optionRoleId });
            toast('Option removed');
            reload();
        } catch (err) {
            toast(err.message || 'Could not remove option', true);
        }
    }

    async function publish() {
        try {
            await api.put('/api/server/' + serverId + '/role-menus/' + menu.message_id + '/publish?channelId=' + menu.channel_id);
            toast('Menu published');
        } catch (err) {
            toast(err.message || 'Could not publish', true);
        }
    }

    async function removeMenu() {
        try {
            await api.del('/api/server/' + serverId + '/role-menus/' + menu.message_id + '?channelId=' + menu.channel_id);
            toast('Menu deleted');
            onChanged();
        } catch (err) {
            toast(err.message || 'Could not delete menu', true);
        }
    }

    return (
        <Card title={(menu.title || 'Role Menu') + ' · #' + channelName(menu.channel_id)} icon="grid"
            action={<div className="row-actions"><Button variant="ghost" onClick={publish}>Publish</Button><Button variant="ghost" onClick={removeMenu}>Delete</Button></div>}>
            <div className="kv"><span>Message ID</span><strong className="mono">{menu.message_id}</strong></div>

            <Loaded loading={loading && !data} empty={options.length === 0} rows={2}
                emptyHint="No options yet — add a role below.">
                <div className="rows">
                    {options.map((o) => (
                        <div className="dist" key={o.roleId}>
                            <span className="emoji">{o.emoji || '•'}</span>
                            <span className="dist-name">{o.label || roleName(o.roleId)}</span>
                            <Button variant="ghost" onClick={() => remove(o.roleId)}>Remove</Button>
                        </div>
                    ))}
                </div>
            </Loaded>

            <div className="form-row mt">
                <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                    <option value="">Add role…</option>
                    {rolesList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </Select>
                <Input placeholder="Emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} style={{ maxWidth: 120 }} />
                <Input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
                <Button onClick={add}>Add</Button>
            </div>
        </Card>
    );
}

export default function RoleMenus() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/role-menus') : Promise.resolve(null)),
        [serverId]
    );

    const [title, setTitle] = useState('');
    const [channelId, setChannelId] = useState('');

    const header = <PageHeader title="Role Menus" sub="Dropdown menus that assign roles" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Role menus are per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={5} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load role menus" hint={error && error.message} />
            </>
        );
    }

    const menus = data.menus || [];
    const channels = data.channels || [];
    const rolesList = data.rolesList || [];

    async function create() {
        if (!channelId) { toast('Pick a channel first', true); return; }
        try {
            await api.post('/api/server/' + serverId + '/role-menus', { channelId, title: title || null });
            setTitle(''); setChannelId('');
            toast('Menu created — now publish it to a message');
            reload();
        } catch (err) {
            toast(err.message || 'Could not create menu', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Card title="Create a role menu" icon="grid">
                <div className="form-row">
                    <Input placeholder="Menu title (e.g. Self-Assignable Roles)" value={title} onChange={(e) => setTitle(e.target.value)} />
                    <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                        <option value="">Select channel…</option>
                        {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                    <Button onClick={create}>Create</Button>
                </div>
                <p className="hint">Creating a menu stores it; Publish edits the target message with the dropdown. You need the message ID — create the menu, then publish.</p>
            </Card>

            <div className="mt">
                <Card title={'Menus (' + num(menus.length) + ')'} icon="grid">
                    {menus.length === 0
                        ? <Empty title="No role menus configured" hint="Create one above." />
                        : <div className="stack-list">{menus.map((m) => (
                            <OptionEditor key={m.message_id} serverId={serverId} menu={m}
                                channels={channels} rolesList={rolesList} onChanged={reload} />
                        ))}</div>}
                </Card>
            </div>
        </>
    );
}

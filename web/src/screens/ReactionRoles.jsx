import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num } from '../lib.js';
import { Card, PageHeader, ServerSelect, Skeleton, Empty, Button, Input, Select } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

export default function ReactionRoles() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/reaction-roles') : Promise.resolve(null)),
        [serverId]
    );

    const [channelId, setChannelId] = useState('');
    const [messageId, setMessageId] = useState('');
    const [emoji, setEmoji] = useState('');
    const [roleId, setRoleId] = useState('');
    const [label, setLabel] = useState('');
    const [busy, setBusy] = useState(false);

    const header = <PageHeader title="Reaction Roles" sub="Self-assignable roles by emoji" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Reaction roles are per server." />
            </>
        );
    }

    if (loading && !data) return <>{header}<Skeleton rows={5} /></>;

    if (error || !data) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Could not load reaction roles" hint={error && error.message} />
            </>
        );
    }

    const roles = data.roles || [];
    const channels = data.channels || [];
    const rolesList = data.rolesList || [];
    const channelName = (id) => (channels.find((c) => c.id === id) || {}).name || id;
    const roleName = (id) => (rolesList.find((r) => r.id === id) || {}).name || id;

    async function create() {
        if (!channelId || !emoji || !roleId) {
            toast('Channel, emoji and role are required', true);
            return;
        }
        setBusy(true);
        try {
            if (messageId.trim()) {
                await api.post('/api/server/' + serverId + '/reaction-roles',
                    { channelId, messageId: messageId.trim(), emoji, roleId, label: label || null });
            } else {
                // No message ID: the bot posts a new message and attaches the
                // reaction to it (matches the vanilla "leave empty to create").
                await api.post('/api/server/' + serverId + '/reaction-roles/message',
                    { channelId, content: 'React to get roles!', roles: [{ emoji, roleId, label: label || null }] });
            }
            toast('Reaction role added');
            setMessageId(''); setEmoji(''); setRoleId(''); setLabel('');
            reload();
        } catch (err) {
            toast(err.message || 'Could not add reaction role', true);
        } finally {
            setBusy(false);
        }
    }

    async function remove(rr) {
        try {
            await api.del('/api/server/' + serverId + '/reaction-roles', { messageId: rr.messageId, emoji: rr.emoji });
            toast('Reaction role removed');
            reload();
        } catch (err) {
            toast(err.message || 'Could not remove', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Card title="Add a reaction role" icon="star">
                <div className="form-row">
                    <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                        <option value="">Select channel…</option>
                        {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </Select>
                    <Input placeholder="Message ID (leave empty to post a new message)" value={messageId}
                        onChange={(e) => setMessageId(e.target.value)} />
                    <Input placeholder="Emoji" value={emoji} onChange={(e) => setEmoji(e.target.value)} style={{ maxWidth: 120 }} />
                    <Select value={roleId} onChange={(e) => setRoleId(e.target.value)}>
                        <option value="">Select role…</option>
                        {rolesList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </Select>
                    <Input placeholder="Label (optional)" value={label} onChange={(e) => setLabel(e.target.value)} />
                    <Button onClick={create} disabled={busy}>{busy ? 'Adding…' : 'Add'}</Button>
                </div>
                <p className="hint">For an existing message, paste its ID. Leave it empty and the bot posts a new message with the reaction.</p>
            </Card>

            <div className="mt">
                <Card title={'Configured (' + num(roles.length) + ')'} icon="star">
                    {roles.length === 0
                        ? <Empty title="No reaction roles configured" hint="Add one above to get started." />
                        : (
                            <div className="rows">
                                {roles.map((rr) => (
                                    <div className="dist" key={rr.messageId + rr.emoji}>
                                        <span className="emoji">{rr.emoji}</span>
                                        <span className="dist-name">
                                            <span className="mono">{rr.messageId}</span>
                                            {' · '}#{channelName(rr.channelId)} → {roleName(rr.roleId)}
                                            {rr.label ? ' · ' + rr.label : ''}
                                        </span>
                                        <Button variant="ghost" onClick={() => remove(rr)}>Delete</Button>
                                    </div>
                                ))}
                            </div>
                        )}
                </Card>
            </div>
        </>
    );
}

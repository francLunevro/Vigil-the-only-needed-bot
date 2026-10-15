import { api } from '../api.js';
import { useAsync, useServers, useServerSelection, useDefaultServer, num, timeAgo } from '../lib.js';
import { Card, PageHeader, ServerSelect, Empty, Button, Badge, Loaded } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

export default function Webhooks() {
    const { data: servers } = useServers();
    const [serverId, choose] = useServerSelection();
    useDefaultServer(servers, serverId, choose);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => (serverId ? api.get('/api/server/' + serverId + '/webhooks') : Promise.resolve(null)),
        [serverId]
    );

    const header = <PageHeader title="Webhooks" sub="Webhooks attached to this server" onRefresh={reload} refreshing={loading} />;

    if (!serverId) {
        return (
            <>
                {header}
                <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>
                <Empty title="Select a server" hint="Webhooks are listed per server." />
            </>
        );
    }

    const webhooks = Array.isArray(data) ? data : [];

    async function remove(wh) {
        try {
            await api.del('/api/server/' + serverId + '/webhooks/' + wh.id);
            toast('Webhook deleted');
            reload();
        } catch (err) {
            toast(err.message || 'Could not delete webhook', true);
        }
    }

    return (
        <>
            {header}
            <div className="toolbar"><ServerSelect servers={servers} value={serverId} onChange={choose} /></div>

            <Card title={'Webhooks (' + num(webhooks.length) + ')'} icon="layers">
                <Loaded error={error} loading={loading && !data} empty={webhooks.length === 0} rows={4}
                    errorTitle="Could not load webhooks" errorHint="Owner-only screen."
                    emptyHint="No webhooks — webhooks created in Discord will show up here.">
                    <div className="rows">
                        {webhooks.map((wh) => (
                            <div className="dist" key={wh.id}>
                                {wh.avatar
                                    ? <img className="dist-avatar" src={wh.avatar} alt="" />
                                    : <span className="dist-avatar dist-avatar-fallback">{(wh.name || '?')[0]}</span>}
                                <span className="dist-name">
                                    <strong>{wh.name}</strong>
                                    {' · '}#{wh.channelName}
                                </span>
                                <span className="dist-meta">
                                    <Badge>{wh.type === 1 ? 'Incoming' : wh.type === 2 ? 'Channel follower' : 'Type ' + wh.type}</Badge>
                                    {' '}owner {wh.owner} · {timeAgo(wh.createdAt)}
                                </span>
                                <Button variant="ghost" onClick={() => remove(wh)}>Delete</Button>
                            </div>
                        ))}
                    </div>
                </Loaded>
            </Card>
        </>
    );
}

import { api } from '../api.js';
import { useAsync, timeAgo } from '../lib.js';
import { useLiveReload } from '../live.jsx';
import { Card, PageHeader, Skeleton, Empty, Icon } from '../components/ui.jsx';

// The standalone Activity feed: one row per recorded member event from
// /api/activity (member_join / member_leave, newest first).
// The event-by-event history lives on the Bot Activity screen
// (/api/activity/timeline), which is a separate, richer view.
const LABELS = {
    member_join: { text: 'Member joined', tone: 'dist-ico-good' },
    member_leave: { text: 'Member left', tone: 'dist-ico-bad' },
};

export default function Activity() {
    const { data, loading, error, reload } = useAsync(() => api.get('/api/activity'), []);
    // Join/leave events arrive over SSE; refresh the feed when they do.
    useLiveReload(reload);

    if (loading && !data) return <Skeleton rows={5} />;

    const events = Array.isArray(data) ? data : [];

    return (
        <>
            <PageHeader title="Activity" sub="Recent member activity across all servers" onRefresh={reload} refreshing={loading} />

            {error && <Empty title="Couldn’t load activity" hint="The bot may be starting up." />}

            {!error && events.length === 0 && (
                <Empty title="No activity yet" hint="Activity will appear as members join or leave." />
            )}

            {events.length > 0 && (
                <Card title={'Recent activity (' + events.length + ')'} icon="pulse">
                    <div className="rows">
                        {events.map((e, i) => {
                            const meta = LABELS[e.type] || { text: String(e.type || 'Event').replace(/_/g, ' '), tone: '' };
                            return (
                                <div className="dist" key={(e.id || e.guildId || 'event') + '-' + i}>
                                    <span className={'dist-ico ' + meta.tone}><Icon name="users" size={13} /></span>
                                    <span className="dist-name">
                                        {meta.text} <strong>{e.guildName || e.guildId}</strong>
                                        {e.userTag ? <span className="sub"> · {e.userTag}</span> : null}
                                    </span>
                                    <span className="dist-meta">{timeAgo(e.time)}</span>
                                </div>
                            );
                        })}
                    </div>
                </Card>
            )}
        </>
    );
}

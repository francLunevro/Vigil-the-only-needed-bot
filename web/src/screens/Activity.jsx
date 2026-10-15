import { api } from '../api.js';
import { useAsync, num, timeAgo } from '../lib.js';
import { useLiveReload } from '../live.jsx';
import { Card, PageHeader, Skeleton, Empty, Icon } from '../components/ui.jsx';

// The standalone Activity feed: per-guild join totals from /api/activity.
// The event-by-event history lives on the Bot Activity screen
// (/api/activity/timeline), which is a separate, richer view.
export default function Activity() {
    const { data, loading, error, reload } = useAsync(() => api.get('/api/activity'), []);
    // Join/leave style events arrive over SSE; refresh the feed when they do.
    useLiveReload(reload);

    if (loading && !data) return <Skeleton rows={5} />;

    const events = Array.isArray(data) ? data : [];

    return (
        <>
            <PageHeader title="Activity" sub="Recent member activity across all servers" onRefresh={reload} refreshing={loading} />

            {error && <Empty title="Couldn’t load activity" hint="The bot may be starting up." />}

            {!error && events.length === 0 && (
                <Empty title="No activity yet" hint="Activity will appear as members join." />
            )}

            {events.length > 0 && (
                <Card title={'Servers with joins (' + events.length + ')'} icon="pulse">
                    <div className="rows">
                        {[...events].reverse().map((e, i) => (
                            <div className="dist" key={(e.guildId || '') + i}>
                                <span className="dist-ico dist-ico-good"><Icon name="users" size={13} /></span>
                                <span className="dist-name">Member joined <strong>{e.guildName}</strong></span>
                                <span className="dist-count">{num(e.count)}</span>
                                <span className="dist-meta">{timeAgo(e.time)}</span>
                            </div>
                        ))}
                    </div>
                </Card>
            )}
        </>
    );
}

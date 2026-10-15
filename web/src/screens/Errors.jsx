import { useState } from 'react';
import { api } from '../api.js';
import { useAsync, timeAgo } from '../lib.js';
import { PageHeader, Skeleton, Empty, Badge, Button, Icon } from '../components/ui.jsx';
import { useToast } from '../components/Toast.jsx';

// The API hands back an ISO timestamp, while timeAgo() counts backwards from a
// millisecond number — an unconverted string rendered "NaNd ago". Date.parse
// handles both the string the route sends and a raw number if one ever arrives.
function errTime(ts) {
    const ms = new Date(ts).getTime();
    return Number.isFinite(ms) ? timeAgo(ms) : '—';
}

// Vanilla showed the newest 25 entries and grew the window by 50 per Load More.
// The tag chips carry the API's own counts, and the tag filter is applied by the
// server (?tag=) exactly as the vanilla pane did.
const PAGE = 25;
const STEP = 50;

export default function Errors() {
    const [tag, setTag] = useState('');
    const [shown, setShown] = useState(PAGE);
    const [openId, setOpenId] = useState(null);
    const toast = useToast();

    const { data, loading, error, reload } = useAsync(
        () => api.get('/api/errors' + (tag ? '?tag=' + encodeURIComponent(tag) : '')),
        [tag]
    );

    const entries = Array.isArray(data) ? data : (data && data.errors) || [];
    const tags = (data && data.tags) || [];
    const allCount = tags.reduce((n, t) => n + t.count, 0);
    const visible = entries.slice(0, shown);

    // Same reset the vanilla chip handler did: back to the first page.
    function choose(next) {
        setTag(next);
        setShown(PAGE);
    }

    async function clear() {
        if (!window.confirm('Clear all logged errors?')) return;
        try {
            const res = await api.del('/api/errors');
            // Only report success when the API said so — the log is still there
            // otherwise, and the feed below would contradict a cheerful toast.
            if (!res || !res.success) throw new Error('not cleared');
            setTag('');
            setShown(PAGE);
            toast('Error log cleared');
            reload();
        } catch {
            // Same wording the vanilla pane used: a rejected DELETE (or a 200
            // without success) is never reported as a completed clear.
            toast('Failed to clear', true);
        }
    }

    if (loading && !data) return <Skeleton rows={6} />;

    return (
        <>
            <PageHeader title="Errors" sub="Live bot error log — newest first" onRefresh={reload} refreshing={loading} />

            {error
                ? <Empty title="Couldn’t load errors" hint={(error && error.message) || 'The bot may be reconnecting.'} />
                : (
                    <>
                        <div className="form-row">
                            <div className="chips">
                                <button className={'chip chip-btn' + (tag === '' ? ' chip-on' : '')} onClick={() => choose('')}>
                                    All <span className="sub">{allCount}</span>
                                </button>
                                {tags.map((t) => (
                                    <button key={t.tag} className={'chip chip-btn' + (tag === t.tag ? ' chip-on' : '')}
                                        onClick={() => choose(t.tag)}>
                                        {t.tag} <span className="sub">{t.count}</span>
                                    </button>
                                ))}
                            </div>
                            <Button variant="ghost" onClick={clear} style={{ marginLeft: 'auto' }}>Clear</Button>
                        </div>

                        {entries.length === 0 && (
                            <Empty title={tag ? 'No ' + tag + ' errors logged.' : 'No errors logged yet.'}
                                hint="Errors are captured automatically from every module — a clean feed means a healthy bot." />
                        )}

                        <div className="list mt">
                            {visible.map((e) => (
                                <div className="row" key={e.id ?? e.timestamp + e.message}>
                                    <div className="row-main">
                                        <div className="row-title">
                                            <Badge tone="bad">{e.tag || 'unknown'}</Badge>
                                            <span className="row-time">{errTime(e.timestamp)}</span>
                                        </div>
                                        <div className="row-text mono">
                                            {e.message}
                                            {e.extra && <span className="sub mono"> · {e.extra}</span>}
                                        </div>
                                        {e.meta && <div className="sub mono">{e.meta}</div>}
                                    </div>
                                    {e.stack && (
                                        <button className="icon-btn" title={openId === e.id ? 'Hide stack' : 'Show stack'}
                                            onClick={() => setOpenId(openId === e.id ? null : e.id)}>
                                            <Icon name="chevron" />
                                        </button>
                                    )}
                                    {openId === e.id && e.stack && <pre className="stack">{e.stack}</pre>}
                                </div>
                            ))}
                        </div>

                        {entries.length > shown && (
                            <div className="row-actions mt">
                                <Button variant="ghost" onClick={() => setShown((s) => s + STEP)}>
                                    Load More ({entries.length - shown} remaining)
                                </Button>
                            </div>
                        )}
                    </>
                )}
        </>
    );
}

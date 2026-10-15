import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAsync, num } from '../lib.js';
import { PageHeader, Input, Select, Skeleton, Empty, Icon, Badge } from '../components/ui.jsx';

const TIERS = ['', 'Tier 1', 'Tier 2', 'Tier 3'];

// The list is the entry point into the per-server detail route: a card opens
// `server/<id>`, which owns identity, growth, and (in later passes) the
// management tabs. The expandable inline card this replaced showed a subset of
// that same Overview while still saying per-server management had to be ported
// one screen at a time — that port is the detail view, so the placeholder went
// with it. Search and sort stay exactly as they were.
export default function Servers({ navigate }) {
    const { data: servers, loading, error, reload } = useAsync(() => api.get('/api/servers'), []);
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState('members');

    const visible = useMemo(() => {
        const list = Array.isArray(servers) ? [...servers] : [];
        const q = query.trim().toLowerCase();
        const filtered = q ? list.filter((s) => s.name.toLowerCase().includes(q)) : list;
        filtered.sort((a, b) => {
            if (sort === 'name') return a.name.localeCompare(b.name);
            if (sort === 'boosts') return (b.boostCount || 0) - (a.boostCount || 0);
            return (b.memberCount || 0) - (a.memberCount || 0);
        });
        return filtered;
    }, [servers, query, sort]);

    if (loading && !servers) return <Skeleton rows={5} />;

    return (
        <>
            <PageHeader title="Servers" sub="All servers the bot is connected to" onRefresh={reload} refreshing={loading} />

            <div className="toolbar">
                <Input placeholder="Search servers…" value={query} onChange={(e) => setQuery(e.target.value)} />
                <Select value={sort} onChange={(e) => setSort(e.target.value)}>
                    <option value="members">Members</option>
                    <option value="name">Name</option>
                    <option value="boosts">Boosts</option>
                </Select>
            </div>

            {error && <Empty title="Couldn’t load servers" hint="The bot may be starting up." />}

            {!error && visible.length === 0 && (
                <Empty title="No servers found" hint="Invite the bot to a server to see it here." />
            )}

            <div className="srv-grid mt">
                {visible.map((s) => (
                    <button key={s.id} className="srv-card" title={'Open ' + s.name}
                        onClick={() => navigate('server/' + s.id)}>
                        {s.icon
                            ? <img src={s.icon} alt="" className="srv-icon" />
                            : <span className="srv-icon srv-icon-fallback"><Icon name="server" size={18} /></span>}
                        <span className="srv-meta">
                            <strong>{s.name}</strong>
                            <span>{num(s.memberCount)} members</span>
                        </span>
                        {s.boostTier > 0 && <Badge tone="warn"><Icon name="star" size={11} /> {TIERS[s.boostTier]}</Badge>}
                    </button>
                ))}
            </div>
        </>
    );
}

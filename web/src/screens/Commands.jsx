import { useMemo, useState } from 'react';
import { api } from '../api.js';
import { useAsync } from '../lib.js';
import { Card, PageHeader, Input, Select, Skeleton, Empty, Badge, Button, Icon } from '../components/ui.jsx';

// /api/commands returns CATEGORIES, not a flat command list:
//   [{ category, owner, commands: [{ name, description, usage }] }]
// Each category is a card — its command count and owner/public badge in the
// header, its commands in the body, and the header collapses it (the vanilla
// pane's toggleCollapsed). Reading the payload as a flat list of commands was
// what lost every command's name/description/usage and threw as soon as the
// search box was used.
function CategoryCard({ category, owner, commands }) {
    const [open, setOpen] = useState(true);

    return (
        <Card
            title={category}
            icon="terminal"
            action={
                <>
                    <Badge>{commands.length}</Badge>
                    <Badge tone={owner ? 'bad' : 'good'}>{owner ? 'Owner only' : 'Public'}</Badge>
                    <Button variant="ghost" aria-expanded={open}
                        title={open ? 'Collapse' : 'Expand'} onClick={() => setOpen((o) => !o)}>
                        <Icon name="chevron" size={14} />
                    </Button>
                </>
            }>
            {open && (
                <div className="list">
                    {commands.map((cmd) => (
                        <div className="row row-static" key={cmd.name}>
                            <div className="row-main">
                                <div className="row-title">
                                    <code className="cmd-name">/{cmd.name}</code>
                                </div>
                                {cmd.description && <div className="row-text">{cmd.description}</div>}
                                {cmd.usage && <div className="hint mono" style={{ marginTop: 4 }}>{cmd.usage}</div>}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </Card>
    );
}

export default function Commands() {
    const { data, loading, error, reload } = useAsync(() => api.get('/api/commands'), []);
    const [query, setQuery] = useState('');
    const [category, setCategory] = useState('all');

    const groups = Array.isArray(data) ? data : [];

    const categories = useMemo(
        () => groups.map((g) => g.category).filter(Boolean),
        [groups]
    );

    // Vanilla filtered inside each category and then dropped the categories
    // left with no match, so the per-category counts and the totals line both
    // follow the filter. Name and description are both matched case-insensitively.
    const visible = useMemo(() => {
        const q = query.trim().toLowerCase();
        return groups
            .filter((g) => category === 'all' || g.category === category)
            .map((g) => ({
                ...g,
                commands: (g.commands || []).filter((cmd) => !q
                    || String(cmd.name || '').toLowerCase().includes(q)
                    || String(cmd.description || '').toLowerCase().includes(q)),
            }))
            .filter((g) => g.commands.length > 0);
    }, [groups, query, category]);

    const total = visible.reduce((n, g) => n + g.commands.length, 0);

    if (loading && !data) return <Skeleton rows={6} />;

    return (
        <>
            <PageHeader title="Commands" sub="Browse every command, its category and description" onRefresh={reload} refreshing={loading} />

            <div className="toolbar">
                <Input placeholder="Search commands…" value={query} onChange={(e) => setQuery(e.target.value)} />
                <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                    <option value="all">All categories</option>
                    {categories.map((c) => <option key={c} value={c}>{c}</option>)}
                </Select>
            </div>

            {error && <Empty title="Couldn’t load commands" hint="The bot may be starting up. Try again in a moment." />}
            {!error && groups.length === 0 && <Empty title="No commands found." />}
            {!error && groups.length > 0 && visible.length === 0 && (
                <Empty title={query.trim() ? 'No commands match “' + query.trim() + '”' : 'No commands in this category'}
                    hint="Try a different search term or category." />
            )}

            {visible.length > 0 && (
                <>
                    <p className="hint">{total} commands across {visible.length} categories</p>
                    <div className="stack-list mt">
                        {visible.map((g) => (
                            <CategoryCard key={g.category} category={g.category} owner={g.owner} commands={g.commands} />
                        ))}
                    </div>
                </>
            )}
        </>
    );
}

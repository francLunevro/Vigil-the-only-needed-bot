import { useToast } from './Toast.jsx';

// A tiny inline icon set — same paths the vanilla dashboard used, extracted so
// screens stop embedding SVG strings. Unknown names fall back to a dot so a
// typo degrades instead of crashing.
const PATHS = {
    grid: <><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></>,
    chart: <><path d="M18 20V10" /><path d="M12 20V4" /><path d="M6 20v-6" /></>,
    pulse: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    layers: <><polygon points="12 2 2 7 12 12 22 7 12 2" /><polyline points="2 17 12 22 22 17" /><polyline points="2 12 12 17 22 12" /></>,
    heart: <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />,
    wrench: <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />,
    sliders: <><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></>,
    server: <><rect x="2" y="2" width="20" height="8" rx="2" /><rect x="2" y="14" width="20" height="8" rx="2" /></>,
    star: <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />,
    alert: <><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" /></>,
    terminal: <><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" /><line x1="13" y1="19" x2="19" y2="13" /><line x1="16" y1="21" x2="21" y2="16" /><line x1="10" y1="11" x2="14" y2="15" /></>,
    users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /></>,
    bell: <><circle cx="12" cy="13" r="8" /><path d="M12 9v4l2 2" /></>,
    moon: <><circle cx="12" cy="12" r="5" /><line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" /><line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" /><line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" /><line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" /></>,
    logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></>,
    menu: <><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></>,
    refresh: <><path d="M21 12a9 9 0 1 1-9-9" /><path d="M21 3v9h-9" /></>,
    download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></>,
    chevron: <polyline points="6 9 12 15 18 9" />,
};

export function Icon({ name, size = 16, className = '' }) {
    const shape = PATHS[name] || <circle cx="12" cy="12" r="3" />;
    return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {shape}
        </svg>
    );
}

export function Card({ title, icon, children, className = '', action }) {
    return (
        <section className={'card ' + className}>
            {title && (
                <header className="card-head">
                    {icon && <Icon name={icon} />}
                    <span>{title}</span>
                    {action && <div className="card-action">{action}</div>}
                </header>
            )}
            <div className="card-body">{children}</div>
        </section>
    );
}

// One-time secret reveal. The API returns a raw token exactly once — only a
// hash is stored — so every screen that mints one shows it the same way: the
// same wording, the same copy affordance, the same dismissal. Keeping it in one
// component is what stops the two mint flows drifting apart again, and the
// token lives only in the caller's state, so `onDismiss` genuinely drops it.
// `children` carries whatever else the caller needs to say (whose token it is,
// when it expires); the block itself always says when it can be shown.
export function TokenReveal({ title, token, onDismiss, className = '', children }) {
    const toast = useToast();

    function copy() {
        navigator.clipboard.writeText(token)
            .then(() => toast('Token copied'))
            .catch(() => toast('Could not copy — select the token and copy it manually', true));
    }

    return (
        <Card title={title} icon="terminal" className={className}
            action={onDismiss && <Button variant="ghost" onClick={onDismiss}>Done</Button>}>
            <p className="hint" style={{ marginTop: 0 }}>
                It is stored only as a hash — this is the one and only time it can be shown. Copy it now.
            </p>
            <code className="token-reveal" title="Click to copy" onClick={copy}>{token}</code>
            {children}
            <div className="row-actions mt">
                <Button onClick={copy}>Copy token</Button>
            </div>
        </Card>
    );
}

export function StatCard({ label, value, sub, tone = 'default' }) {
    return (
        <div className={'stat stat-' + tone}>
            <div className="stat-label">{label}</div>
            <div className="stat-value">{value}</div>
            {sub && <div className="stat-sub">{sub}</div>}
        </div>
    );
}

export function Grid({ cols = 4, children, className = '' }) {
    return <div className={'grid grid-' + cols + ' ' + className}>{children}</div>;
}

export function PageHeader({ title, sub, onRefresh, refreshing }) {
    return (
        <div className="page-head">
            <div>
                <h1 className="page-title">{title}</h1>
                {sub && <p className="page-sub">{sub}</p>}
            </div>
            {onRefresh && (
                <button className="btn btn-ghost" onClick={onRefresh} disabled={refreshing}>
                    <Icon name="refresh" /> {refreshing ? 'Refreshing…' : 'Refresh'}
                </button>
            )}
        </div>
    );
}

export function Button({ variant = 'primary', icon, children, ...rest }) {
    return (
        <button className={'btn btn-' + variant} {...rest}>
            {icon && <Icon name={icon} size={14} />}
            {children}
        </button>
    );
}

export function Select({ children, ...rest }) {
    return <select className="input" {...rest}>{children}</select>;
}

// Server dropdown shared by the per-server screens. It renders the placeholder
// itself so callers only pass the servers, the current id, and a setter.
export function ServerSelect({ servers, value, onChange, label = 'Select a server…' }) {
    return (
        <Select value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">{label}</option>
            {(servers || []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
    );
}

// Channel dropdown fed by useTextChannels(guildId).
export function ChannelSelect({ channels, value, onChange, label = 'Select channel…', style }) {
    return (
        <Select value={value} onChange={(e) => onChange(e.target.value)} style={style}>
            <option value="">{label}</option>
            {(channels || []).map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </Select>
    );
}

export function Textarea(props) {
    return <textarea className="input" {...props} />;
}

export function Input(props) {
    return <input className="input" {...props} />;
}

export function Empty({ title, hint }) {
    return (
        <div className="empty">
            <Icon name="alert" size={22} />
            <p>{title}</p>
            {hint && <p className="empty-hint">{hint}</p>}
        </div>
    );
}

export function Skeleton({ rows = 3 }) {
    return (
        <div className="skeleton">
            {Array.from({ length: rows }, (_, i) => (
                <div className="sk-line" key={i} style={{ width: (60 + (i % 3) * 15) + '%' }} />
            ))}
        </div>
    );
}

// The error → loading → empty → content ladder a data-backed card renders.
// Every card used to spell out the four branches inline, which made it easy for
// one card to quietly skip a rung (an error or empty state falling through to
// an empty list). Callers pass `loading && !data` so a background refresh
// doesn't flash the skeleton over content already on screen, and the server's
// own message beats the generic hint when there is one.
export function Loaded({ error, loading, empty, errorTitle, errorHint, emptyHint, rows = 3, children }) {
    if (error) return <Empty title={errorTitle} hint={(error && error.message) || errorHint} />;
    if (loading) return <Skeleton rows={rows} />;
    if (empty) return <p className="hint">{emptyHint}</p>;
    return children;
}

export function Badge({ children, tone = 'default' }) {
    return <span className={'badge badge-' + tone}>{children}</span>;
}

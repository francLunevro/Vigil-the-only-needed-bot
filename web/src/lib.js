import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// ──────────────────── Data fetching ────────────────────
// Runs `fn` on mount and whenever `deps` change, and exposes loading / error /
// reload. A monotonically increasing sequence guards against an older request
// resolving after a newer one (a fast refresh button clicking twice).
export function useAsync(fn, deps = []) {
    const [state, setState] = useState({ data: null, loading: true, error: null });
    const seq = useRef(0);

    const run = useCallback(() => {
        const id = ++seq.current;
        setState((s) => ({ data: s.data, loading: true, error: null }));
        Promise.resolve()
            .then(fn)
            .then((data) => { if (id === seq.current) setState({ data, loading: false, error: null }); })
            .catch((error) => { if (id === seq.current) setState({ data: null, loading: false, error }); });
        // fn is intentionally not a dependency — callers pass its deps.
    }, deps);

    useEffect(() => { run(); }, [run]);
    return { ...state, reload: run };
}

// ──────────────────── Server selection ────────────────────
// Several screens (Moderation, Insights, …) are scoped to one server. The
// selection is shared via localStorage so switching screens doesn't reset it.
export function useServers() {
    return useAsync(() => api.get('/api/servers').catch(() => []), []);
}

export function useServerSelection() {
    const [serverId, setServerId] = useState(() => {
        try { return localStorage.getItem('vigil-server') || ''; } catch { return ''; }
    });
    const choose = useCallback((id) => {
        setServerId(id || '');
        try { localStorage.setItem('vigil-server', id || ''); } catch { /* private mode */ }
    }, []);
    return [serverId, choose];
}

// Text-like channels for a guild (text / announcement / forum), used by the
// screens that post into a chosen channel.
export function useTextChannels(guildId) {
    return useAsync(
        () => (guildId
            ? api.get('/api/server/' + guildId + '/channels').then((cs) => cs.filter((c) => [0, 5, 15].includes(c.typeId)))
            : Promise.resolve([])),
        [guildId]
    );
}

// Picks a default server once the list arrives, when nothing is selected yet.
export function useDefaultServer(servers, serverId, choose) {
    useEffect(() => {
        if (!serverId && Array.isArray(servers) && servers.length) choose(servers[0].id);
    }, [servers, serverId, choose]);
}

// ──────────────────── Routing ────────────────────
// The dashboard is a single page with section tabs, not URL-addressed pages.
// Hash routing keeps deep links and the back button working without needing a
// server-side SPA fallback, which matters when the bot serves static files.
export function useHashRoute(fallback = 'overview') {
    const read = () => window.location.hash.replace(/^#\/?/, '') || fallback;
    const [route, setRoute] = useState(read);

    useEffect(() => {
        const onChange = () => setRoute(read());
        window.addEventListener('hashchange', onChange);
        return () => window.removeEventListener('hashchange', onChange);
    }, []);

    const navigate = useCallback((id) => {
        if (read() === id) return;
        window.location.hash = '/' + id;
    }, []);

    return [route, navigate];
}

// ──────────────────── Formatting ────────────────────

export function num(value) {
    if (value === null || value === undefined || value === '') return '—';
    const n = Number(value);
    return Number.isFinite(n) ? n.toLocaleString() : String(value);
}

// "in 3m" / "in 2d" from a millisecond timestamp in the FUTURE — token and
// session expiries. timeAgo() only counts backwards, so a future timestamp
// would clamp to "0s ago" and read as long expired.
export function timeUntil(ts) {
    if (!ts) return '—';
    const secs = Math.floor((Number(ts) - Date.now()) / 1000);
    if (!Number.isFinite(secs)) return '—';
    if (secs <= 0) return 'expired';
    if (secs < 3600) return 'in ' + Math.max(1, Math.floor(secs / 60)) + 'm';
    if (secs < 86400) return 'in ' + Math.floor(secs / 3600) + 'h';
    return 'in ' + Math.floor(secs / 86400) + 'd';
}

// "3m ago" / "2d ago" from a millisecond timestamp.
export function timeAgo(ts) {
    if (!ts) return '—';
    const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (secs < 60) return secs + 's ago';
    if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
    if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
    return Math.floor(secs / 86400) + 'd ago';
}

export function mb(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n.toFixed(1) + ' MB' : '—';
}

// A number with an explicit sign, for net-growth readouts.
export function signed(value) {
    const n = Number(value) || 0;
    return (n >= 0 ? '+' : '') + n.toLocaleString();
}

// ──────────────────── Downloads ────────────────────

// Saves `payload` as pretty-printed JSON under `filename`, entirely client
// side. Shared by the bot-config export (System) and the growth-data export
// (Analytics) so the anchor/revoke dance lives in one place.
export function downloadJson(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// YYYY-MM-DD stamp for export filenames.
export function todayStamp() {
    return new Date().toISOString().slice(0, 10);
}

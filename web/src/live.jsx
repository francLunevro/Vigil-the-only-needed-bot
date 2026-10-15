import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

// ──────────────────── SSE live updates ────────────────────
// One EventSource to /api/events, shared app-wide. The backend already
// scopes events per client (scoped dash users only receive events for their
// granted guilds, fail-closed), so the client just renders what arrives.
//
// Wire format (parts/10-insights.js): `data: {"type":…,"data":…,"time":…}`,
// currently emitted for msg_deleted / msg_edited / ticket_claimed /
// ticket_transferred. Vanilla's member_join / member_leave refresh pair is
// covered by subscribing screens reloading on any event.
//
// Consumers:
//   const { lastEvent, bump } = useLive();
//   useEffect(() => { if (bump) reload(); }, [bump]);        // reload on any event
//   toast('Message deleted by ' + lastEvent.data.authorTag); // or read the event

const LiveContext = createContext({ lastEvent: null, bump: 0 });

export function LiveProvider({ children }) {
    const [state, setState] = useState({ lastEvent: null, bump: 0 });
    const sourceRef = useRef(null);
    const retryRef = useRef(null);

    const handleEvent = useCallback((ev) => {
        setState((prev) => ({ lastEvent: ev, bump: prev.bump + 1 }));
    }, []);

    useEffect(() => {
        if (typeof EventSource === 'undefined') return undefined;
        let closed = false;

        function connect() {
            if (closed) return;
            const es = new EventSource('/api/events');
            sourceRef.current = es;
            es.onmessage = (e) => {
                try {
                    const ev = JSON.parse(e.data);
                    if (ev && ev.type && ev.type !== 'connected') handleEvent(ev);
                } catch { /* malformed frame — ignore */ }
            };
            es.onerror = () => {
                es.close();
                sourceRef.current = null;
                // Vanilla's reconnect backoff: 5s.
                if (!closed && !retryRef.current) {
                    retryRef.current = setTimeout(() => { retryRef.current = null; connect(); }, 5000);
                }
            };
        }
        connect();

        return () => {
            closed = true;
            if (retryRef.current) { clearTimeout(retryRef.current); retryRef.current = null; }
            if (sourceRef.current) sourceRef.current.close();
            sourceRef.current = null;
        };
    }, [handleEvent]);

    return <LiveContext.Provider value={state}>{children}</LiveContext.Provider>;
}

export function useLive() {
    return useContext(LiveContext);
}

// Convenience for screens: run `fn` whenever any live event arrives.
export function useLiveReload(fn) {
    const { bump } = useLive();
    useEffect(() => {
        if (bump > 0 && typeof fn === 'function') fn();
        // fn intentionally not a dependency — callers pass stable reloads.
    }, [bump]);
}

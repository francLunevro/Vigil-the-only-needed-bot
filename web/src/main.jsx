import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import Login from './Login.jsx';
import { ToastProvider, useToast } from './components/Toast.jsx';
import { LiveProvider, useLive } from './live.jsx';
import './styles.css';

// Global reactions to live events (vanilla 02-ui-shell initSSE): message
// deletions/edits toast immediately no matter which screen is open. Screens
// showing live data (Overview, Activity, Tickets) reload via useLiveReload.
function GlobalLiveToasts() {
    const { lastEvent, bump } = useLive();
    const toast = useToast();

    useEffect(() => {
        if (bump === 0 || !lastEvent) return;
        if (lastEvent.type === 'msg_deleted') {
            toast('✉️ Message deleted by ' + ((lastEvent.data && lastEvent.data.authorTag) || 'unknown'));
        } else if (lastEvent.type === 'msg_edited') {
            toast('✏️ Message edited by ' + ((lastEvent.data && lastEvent.data.authorTag) || 'unknown'));
        }
        // toast is stable (useCallback in ToastProvider).
    }, [bump]);

    return null;
}

// The login page renders without the app shell: before a session exists the
// shell has nothing to show, so /login gets its own minimal React tree (and
// no SSE connection — /api/events would just 401). The server only serves
// this bundle at /login when unauthenticated, so a path check is enough.
const path = window.location.pathname.replace(/\/+$/, '') || '/';
const Root = path === '/login' ? Login : App;

createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <ToastProvider>
            <LiveProvider>
                <GlobalLiveToasts />
                <Root />
            </LiveProvider>
        </ToastProvider>
    </React.StrictMode>
);

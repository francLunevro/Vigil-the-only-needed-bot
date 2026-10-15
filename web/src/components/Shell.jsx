import { useEffect, useRef, useState } from 'react';
import { Icon } from './ui.jsx';
import CommandPalette from './CommandPalette.jsx';
import { SweepToggle } from '../motion.jsx';

// Grouped navigation, mirroring the vanilla dashboard's seven places. The
// standalone entries carry no `group`; everything else lives under one.
export const NAV = [
    { id: 'overview', label: 'Overview', icon: 'grid' },
    { id: 'analytics', label: 'Analytics', icon: 'chart' },
    { id: 'activity', label: 'Activity', icon: 'pulse' },
    {
        group: 'Operate', icon: 'layers',
        items: [
            { id: 'servers', label: 'Servers', icon: 'server' },
            { id: 'auditlog', label: 'Audit Log', icon: 'pulse' },
            { id: 'moderation', label: 'Moderation', icon: 'shield' },
        ],
    },
    {
        group: 'Engage', icon: 'heart',
        items: [
            { id: 'insights', label: 'Insights', icon: 'chart' },
            { id: 'invites', label: 'Invites', icon: 'users' },
            { id: 'giveaways', label: 'Giveaways', icon: 'star' },
            { id: 'reminders', label: 'Reminders', icon: 'bell' },
        ],
    },
    {
        group: 'Manage', icon: 'wrench',
        items: [
            { id: 'automod', label: 'Auto-Mod', icon: 'shield' },
            { id: 'tickets', label: 'Tickets', icon: 'grid' },
            { id: 'commands', label: 'Commands', icon: 'terminal' },
            { id: 'custom-commands', label: 'Custom Commands', icon: 'terminal' },
            { id: 'reaction-roles', label: 'Reaction Roles', icon: 'star' },
            { id: 'role-menus', label: 'Role Menus', icon: 'grid' },
            { id: 'member-reports', label: 'Member Reports', icon: 'alert' },
        ],
    },
    {
        group: 'Server tools', icon: 'sliders',
        items: [
            { id: 'logging', label: 'Logging', icon: 'pulse' },
            { id: 'greetings', label: 'Greetings', icon: 'heart' },
            { id: 'temp-voice', label: 'Temp Voice', icon: 'bell' },
            { id: 'voice-presence', label: 'Voice Presence', icon: 'bell' },
            { id: 'warning-thresholds', label: 'Warning Thresholds', icon: 'shield' },
            { id: 'ban-appeals', label: 'Ban Appeals', icon: 'shield' },
            { id: 'polls', label: 'Polls & Announcements', icon: 'chart' },
            { id: 'webhooks', label: 'Webhooks', icon: 'layers' },
            { id: 'api-tokens', label: 'API Tokens', icon: 'terminal' },
            { id: 'rate-limits', label: 'Rate Limits', icon: 'sliders' },
            { id: 'bot-activity', label: 'Bot Activity', icon: 'pulse' },
            { id: 'server-compare', label: 'Server Comparison', icon: 'chart' },
            { id: 'cmd-heatmap', label: 'Command Heatmap', icon: 'grid' },
        ],
    },
    {
        group: 'System', icon: 'sliders',
        items: [
            { id: 'system', label: 'System & Backups', icon: 'server' },
            { id: 'access', label: 'Dashboard Access', icon: 'users' },
            { id: 'errors', label: 'Errors', icon: 'alert' },
            { id: 'settings', label: 'Customize', icon: 'sliders' },
        ],
    },
];

// Flattened id -> label lookup for the page header / breadcrumbs.
export const SECTION_LABELS = Object.fromEntries(
    NAV.flatMap((entry) => (entry.group ? entry.items : [entry])).map((i) => [i.id, i.label])
);

function isActive(route, id) {
    // `server/<id>` is the per-server detail view opened from the Servers
    // list, so Servers stays highlighted while it is on screen.
    if (id === 'servers') return route === 'servers' || route.startsWith('server/');
    return route === id;
}

function groupActive(route, items) {
    return items.some((i) => isActive(route, i.id));
}

export function Shell({ route, navigate, theme, onToggleTheme, title, logoUrl, children }) {
    const [openGroup, setOpenGroup] = useState(null);
    const [mobileOpen, setMobileOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);
    const navRef = useRef(null);

    // Close any open dropdown when clicking elsewhere.
    useEffect(() => {
        function onDoc(e) {
            if (navRef.current && !navRef.current.contains(e.target)) setOpenGroup(null);
        }
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, []);

    // Ctrl+K / ⌘K opens the jump palette.
    useEffect(() => {
        function onKey(e) {
            if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') {
                e.preventDefault();
                setPaletteOpen((v) => !v);
            }
        }
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    // Flat section list for the palette, keeping each item's group label.
    const paletteSections = useRef(NAV.flatMap((entry) => (entry.group
        ? entry.items.map((i) => ({ ...i, group: entry.group }))
        : [{ ...entry, group: '' }]))).current;

    function go(id) {
        navigate(id);
        setOpenGroup(null);
        setMobileOpen(false);
    }

    async function logout() {
        try { await fetch('/api/logout', { method: 'POST' }); } catch { /* navigate away regardless */ }
        window.location.href = '/login';
    }

    return (
        <div className="app">
            <header className="topbar" ref={navRef}>
                <button className="logo" onClick={() => go('overview')} title={(title || 'Vigil') + ' dashboard'}>
                    {logoUrl ? <img src={logoUrl} alt="" /> : <Icon name="grid" size={18} />}
                    <span>{title || 'Vigil'}</span>
                </button>

                <nav className={'nav' + (mobileOpen ? ' nav-open' : '')}>
                    {NAV.map((entry) => {
                        if (!entry.group) {
                            return (
                                <button key={entry.id} className={'nav-link' + (isActive(route, entry.id) ? ' active' : '')}
                                    onClick={() => go(entry.id)}>
                                    <Icon name={entry.icon} /> <span>{entry.label}</span>
                                </button>
                            );
                        }
                        const open = openGroup === entry.group;
                        return (
                            <div className="nav-group" key={entry.group}>
                                <button className={'nav-link' + (groupActive(route, entry.items) ? ' active' : '')}
                                    onClick={() => setOpenGroup(open ? null : entry.group)}>
                                    <Icon name={entry.icon} /> <span>{entry.group}</span>
                                    <Icon name="chevron" size={12} />
                                </button>
                                {open && (
                                    <div className="nav-menu">
                                        <div className="nav-menu-label">{entry.group}</div>
                                        {entry.items.map((item) => (
                                            <button key={item.id} className={'nav-item' + (isActive(route, item.id) ? ' active' : '')}
                                                onClick={() => go(item.id)}>
                                                <Icon name={item.icon} size={14} /> {item.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </nav>

                <div className="topbar-actions">
                    <button className="icon-btn" onClick={() => setPaletteOpen(true)} title="Jump to (Ctrl+K)">
                        <Icon name="terminal" size={15} />
                    </button>
                    <SweepToggle theme={theme} onToggle={onToggleTheme} />
                    <button className="icon-btn" onClick={logout} title="Sign out"><Icon name="logout" /></button>
                    <button className="icon-btn nav-burger" onClick={() => setMobileOpen((v) => !v)} title="Menu"><Icon name="menu" /></button>
                </div>
            </header>

            <main className="main">{children}</main>

            <CommandPalette
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
                navigate={navigate}
                sections={paletteSections}
            />
        </div>
    );
}

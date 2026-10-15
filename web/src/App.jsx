import { useEffect, useState } from 'react';
import { api } from './api.js';
import { useAsync, useHashRoute } from './lib.js';
import { applyConfig, safeUrl } from './config.js';
import { Shell, SECTION_LABELS } from './components/Shell.jsx';
import BackgroundCanvas from './components/BackgroundCanvas.jsx';
import { AmbientLight, installPointerFX } from './motion.jsx';

import Overview from './screens/Overview.jsx';
import Analytics from './screens/Analytics.jsx';
import Servers from './screens/Servers.jsx';
import Activity from './screens/Activity.jsx';
import Moderation from './screens/Moderation.jsx';
import Insights from './screens/Insights.jsx';
import AutoMod from './screens/AutoMod.jsx';
import ReactionRoles from './screens/ReactionRoles.jsx';
import RoleMenus from './screens/RoleMenus.jsx';
import MemberReports from './screens/MemberReports.jsx';
import AuditLog from './screens/AuditLog.jsx';
import BotActivity from './screens/BotActivity.jsx';
import ServerCompare from './screens/ServerCompare.jsx';
import CmdHeatmap from './screens/CmdHeatmap.jsx';
import Webhooks from './screens/Webhooks.jsx';
import ApiTokens from './screens/ApiTokens.jsx';
import RateLimits from './screens/RateLimits.jsx';
import WarningThresholds from './screens/WarningThresholds.jsx';
import VoicePresence from './screens/VoicePresence.jsx';
import TempVoice from './screens/TempVoice.jsx';
import CustomCommands from './screens/CustomCommands.jsx';
import Tickets from './screens/Tickets.jsx';
import BanAppeals from './screens/BanAppeals.jsx';
import Customize from './screens/Customize.jsx';
import Invites from './screens/Invites.jsx';
import Giveaways from './screens/Giveaways.jsx';
import Reminders from './screens/Reminders.jsx';
import Polls from './screens/Polls.jsx';
import Errors from './screens/Errors.jsx';
import Commands from './screens/Commands.jsx';
import System from './screens/System.jsx';
import Access from './screens/Access.jsx';
import Greetings from './screens/Greetings.jsx';
import Logging from './screens/Logging.jsx';
import ServerDetail from './screens/ServerDetail.jsx';
import ComingSoon from './screens/ComingSoon.jsx';

// Screens that are ported. Everything else still has a nav entry and renders
// the ComingSoon placeholder, so no section is lost during the migration.
const SCREENS = {
    overview: Overview,
    analytics: Analytics,
    servers: Servers,
    activity: Activity,
    moderation: Moderation,
    insights: Insights,
    automod: AutoMod,
    'reaction-roles': ReactionRoles,
    'role-menus': RoleMenus,
    'member-reports': MemberReports,
    giveaways: Giveaways,
    reminders: Reminders,
    polls: Polls,
    auditlog: AuditLog,
    'bot-activity': BotActivity,
    'server-compare': ServerCompare,
    'cmd-heatmap': CmdHeatmap,
    webhooks: Webhooks,
    'api-tokens': ApiTokens,
    'rate-limits': RateLimits,
    'warning-thresholds': WarningThresholds,
    'voice-presence': VoicePresence,
    'temp-voice': TempVoice,
    'custom-commands': CustomCommands,
    tickets: Tickets,
    'ban-appeals': BanAppeals,
    settings: Customize,
    invites: Invites,
    errors: Errors,
    commands: Commands,
    system: System,
    access: Access,
    greetings: Greetings,
    logging: Logging,
};

function useTheme(configDark) {
    // First paint: the saved dashboard config's darkMode wins over the local
    // toggle's last position, so the two can't disagree after a Customize save.
    const [theme, setTheme] = useState(() => {
        if (configDark === true) return 'dark';
        if (configDark === false) return 'light';
        return localStorage.getItem('vigil-theme') || 'dark';
    });

    useEffect(() => {
        if (configDark === true || configDark === false) {
            setTheme(configDark ? 'dark' : 'light');
        }
    }, [configDark]);

    useEffect(() => {
        document.documentElement.classList.toggle('light-mode', theme === 'light');
        localStorage.setItem('vigil-theme', theme);
    }, [theme]);

    return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))];
}

export default function App() {
    const [route, navigate] = useHashRoute('overview');

    // Config first (its darkMode seeds the theme), theme next, then the
    // applier runs whenever either changes — it is idempotent, so a theme
    // flip just re-applies the mode-dependent parts (palette, borders).
    const config = useAsync(() => api.get('/api/dash/config').catch(() => null), []).data;
    const configDark = config ? config.darkMode !== false : null;
    const [theme, toggleTheme] = useTheme(configDark);

    useEffect(() => {
        applyConfig(config, theme === 'dark');
    }, [config, theme]);

    // Card glow + ambient light are owned by the saved config; one shared
    // pointer listener drives both (no re-renders on the hot path).
    installPointerFX({
        cardGlow: !config || config.cardGlow !== false,
        ambientLight: !config || config.ambientLight !== false,
    });

    // One per-server address for the whole detail view: `server/<id>`. It is
    // parameterised, so it can't live in SCREENS (that lookup is id -> screen)
    // and is handled here instead. Vanilla reached the same place by swapping
    // the server list for a detail panel instead of navigating.
    const detailId = route.startsWith('server/') ? route.slice('server/'.length) : null;
    const Screen = SCREENS[route];
    const label = SECTION_LABELS[route] || route;

    return (
        <>
            {/* Ambient effect behind the app (saved backgroundStyle). None by
                default — the canvas renders only when a style is set. */}
            <BackgroundCanvas style={config && config.backgroundStyle} />
            {(!config || config.ambientLight !== false) && <AmbientLight />}
            <Shell route={route} navigate={navigate} theme={theme} onToggleTheme={toggleTheme} title={config && config.title} logoUrl={config && safeUrl(config.logoUrl)}>
                {Screen ? <Screen navigate={navigate} />
                    : detailId ? <ServerDetail id={detailId} navigate={navigate} />
                        : <ComingSoon title={label} />}
            </Shell>
        </>
    );
}

import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// ──────────────────── Canvas dot background ────────────────────
// The login page's ambient dot field (vanilla login.mjs, simplified): dots
// spring back to their grid position and shy away from the cursor.
function DotBackground() {
    const ref = useRef(null);

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        let w = 0, h = 0, dots = [], raf = 0;
        const mouse = { x: -9999, y: -9999 };

        function build() {
            dots = [];
            for (let y = 0; y < h; y += 32) {
                for (let x = 0; x < w; x += 32) dots.push({ x, y, ox: x, oy: y });
            }
        }
        function resize() {
            w = window.innerWidth; h = window.innerHeight;
            const d = window.devicePixelRatio || 1;
            canvas.width = w * d; canvas.height = h * d;
            canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
            ctx.setTransform(d, 0, 0, d, 0, 0);
            build();
        }
        function onMove(e) { mouse.x = e.clientX; mouse.y = e.clientY; }
        function onLeave() { mouse.x = -9999; mouse.y = -9999; }

        function anim() {
            ctx.clearRect(0, 0, w, h);
            const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '88,101,242';
            for (const d of dots) {
                const dx = mouse.x - d.ox, dy = mouse.y - d.oy;
                const di = Math.sqrt(dx * dx + dy * dy);
                let ox = 0, oy = 0;
                if (di < 100) {
                    const f = (1 - di / 100) * 12;
                    ox = -Math.cos(Math.atan2(dy, dx)) * f;
                    oy = -Math.sin(Math.atan2(dy, dx)) * f;
                }
                d.x += (d.ox + ox - d.x) * 0.08;
                d.y += (d.oy + oy - d.y) * 0.08;
                ctx.beginPath();
                ctx.arc(d.x, d.y, 0.6, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(' + accent + ',' + (0.06 + 0.12 * (1 - Math.min(di / 200, 1))) + ')';
                ctx.fill();
            }
            raf = requestAnimationFrame(anim);
        }

        resize();
        window.addEventListener('resize', resize);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseleave', onLeave);
        anim();

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('resize', resize);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseleave', onLeave);
        };
    }, []);

    return <canvas ref={ref} className="login-canvas" aria-hidden="true" />;
}

// ──────────────────── Login page ────────────────────
// Mounted by main.jsx when the path is /login — before a session exists the
// dashboard shell has nothing to show, so this renders without App/Shell.
export default function Login() {
    const [mode, setMode] = useState('password');
    const [password, setPassword] = useState('');
    const [discordId, setDiscordId] = useState('');
    const [accessToken, setAccessToken] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [dark, setDark] = useState(() => {
        try { return localStorage.getItem('loginTheme') !== 'light'; } catch { return true; }
    });
    const [branding, setBranding] = useState(null);
    const passwordRef = useRef(null);

    // Theme (separate storage key from the dashboard, same as vanilla).
    useEffect(() => {
        document.body.classList.toggle('light-login', !dark);
    }, [dark]);

    // Branding is public (/api/branding) — accent, title, logo, favicon.
    useEffect(() => {
        fetch('/api/branding').then((r) => (r.ok ? r.json() : null)).then((b) => {
            if (!b) return;
            setBranding(b);
            if (b.title) document.title = b.title + ' — Sign In';
            if (b.accentColor && /^#[0-9a-fA-F]{6}$/.test(b.accentColor)) {
                const r = parseInt(b.accentColor.slice(1, 3), 16);
                const g = parseInt(b.accentColor.slice(3, 5), 16);
                const bl = parseInt(b.accentColor.slice(5, 7), 16);
                document.documentElement.style.setProperty('--accent', b.accentColor);
                document.documentElement.style.setProperty('--accent-rgb', r + ',' + g + ',' + bl);
            }
            if (b.faviconUrl && ( /^https:\/\//.test(b.faviconUrl) || /^\/uploads\//.test(b.faviconUrl))) {
                let link = document.querySelector('link[rel="icon"]');
                if (!link) {
                    link = document.createElement('link');
                    link.rel = 'icon';
                    document.head.appendChild(link);
                }
                link.href = b.faviconUrl;
            }
        })
        // Branding is decorative — defaults are fine offline.
        .catch(() => null);
    }, []);

    // Clear credentials on bfcache restore (security, same as vanilla).
    useEffect(() => {
        const onPageShow = () => { setPassword(''); setDiscordId(''); setAccessToken(''); };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
    }, []);

    function switchMode(m) {
        setMode(m);
        setError('');
    }

    async function submit(e) {
        e.preventDefault();
        if (busy) return;
        setError('');
        setBusy(true);
        try {
            const body = mode === 'password'
                ? { password }
                : { discordId, accessToken };
            const d = await api.post('/api/login', body);
            if (d && d.success) {
                window.location.href = '/';
                return;
            }
            setError('Invalid ' + (mode === 'password' ? 'password' : 'credentials') + '.');
        } catch (err) {
            setError(err.status === 429 ? 'Too many attempts. Please wait a minute.' : 'Invalid ' + (mode === 'password' ? 'password' : 'credentials') + '.');
        } finally {
            setBusy(false);
        }
    }

    const logoSafe = branding && branding.logoUrl
        && (/^https:\/\//.test(branding.logoUrl) || /^\/uploads\//.test(branding.logoUrl));

    return (
        <div className="login-page">
            <DotBackground />
            <button type="button" className="icon-btn login-theme" title="Toggle theme"
                onClick={() => {
                    const next = !dark;
                    setDark(next);
                    try { localStorage.setItem('loginTheme', next ? 'dark' : 'light'); } catch { /* private mode */ }
                }}>
                {dark ? '🌙' : '☀️'}
            </button>

            <div className="login-card">
                <div className="login-icon">
                    {logoSafe
                        ? <img src={branding.logoUrl} alt="" />
                        : (
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                                <rect x="3" y="3" width="18" height="18" rx="4" />
                                <line x1="3" y1="9" x2="21" y2="9" />
                                <line x1="9" y1="21" x2="9" y2="9" />
                            </svg>
                        )}
                </div>
                <h1>{(branding && branding.title) || 'Vigil'}</h1>
                <p className="login-sub">Access the control panel</p>

                <div className="login-tabs">
                    <button type="button" className={mode === 'password' ? 'active' : ''} onClick={() => switchMode('password')}>Password</button>
                    <button type="button" className={mode === 'discord' ? 'active' : ''} onClick={() => switchMode('discord')}>Discord ID</button>
                </div>
                <p className="login-hint">
                    {mode === 'password'
                        ? 'Enter your password to sign in.'
                        : 'Enter your Discord user ID. Only granted users can use this.'}
                </p>

                <form onSubmit={submit} autoComplete="off">
                    {mode === 'password' ? (
                        <div className="login-field">
                            <label htmlFor="login-password">Password</label>
                            <input id="login-password" type="password" ref={passwordRef}
                                value={password} onChange={(e) => setPassword(e.target.value)}
                                placeholder="Enter dashboard password…"
                                autoComplete="new-password" readOnly onFocus={(e) => { e.target.removeAttribute('readonly'); }} />
                        </div>
                    ) : (
                        <>
                            <div className="login-field">
                                <label htmlFor="login-discord-id">Discord user ID</label>
                                <input id="login-discord-id" type="text" value={discordId}
                                    onChange={(e) => setDiscordId(e.target.value)}
                                    placeholder="Paste your Discord user ID…" autoComplete="off" />
                            </div>
                            <div className="login-field">
                                <label htmlFor="login-token">Access token</label>
                                <input id="login-token" type="password" value={accessToken}
                                    onChange={(e) => setAccessToken(e.target.value)}
                                    placeholder="Paste the access token from the bot…" autoComplete="new-password" />
                            </div>
                        </>
                    )}

                    <button type="submit" className="login-btn" disabled={busy}>
                        {busy ? 'Signing in…' : 'Sign In'}
                    </button>
                    {error && <div className="login-error">{error}</div>}
                </form>

                <p className="login-foot">Vigil · Self-Hosted Control</p>
            </div>
        </div>
    );
}

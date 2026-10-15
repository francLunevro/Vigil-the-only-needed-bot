import { useEffect, useRef } from 'react';

// ──────────────────── Motion layer ────────────────────
// React ports of the vanilla 11-motion.mjs pieces that make sense in a
// component tree: the theme sweep, card glow tracking, ambient light, and
// scroll reveal. The smooth caret / pill button / avatar picker stay
// vanilla-only (they wrap DOM imperatively; React forms don't need them).
//
// Everything degrades to plain behaviour: no View Transitions API or
// prefers-reduced-motion → instant flips and no decoration.

function reducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch { return false; }
}

const HAS_VT = typeof document !== 'undefined' && typeof document.startViewTransition === 'function';

// ──────────────────── 1. Theme sweep ────────────────────
// The last pointer-down position is the sweep origin, so the theme appears to
// pour out of the button that was pressed. Falls back to screen centre for
// keyboard toggles.

const SWEEP_MS = 550;
const SWEEP_EASE = 'cubic-bezier(.23,1,.32,1)';

// Distance to the farthest corner, so one circle always covers the viewport.
function coverRadius({ x, y }) {
    return Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) * 1.02;
}

function sweepCSS({ x, y }) {
    const r = coverRadius({ x, y });
    const at = Math.round(x) + 'px ' + Math.round(y) + 'px';
    return '::view-transition-group(root){animation-duration:.55s;animation-timing-function:cubic-bezier(.23,1,.32,1)}'
        + '::view-transition-old(root){animation:none;z-index:-1}'
        + '::view-transition-new(root){animation:tk-sweep .55s cubic-bezier(.23,1,.32,1);filter:blur(0)}'
        + '@keyframes tk-sweep{from{clip-path:circle(0% at ' + at + ');filter:blur(3px)}40%{filter:blur(1.5px)}to{clip-path:circle(' + r + 'px at ' + at + ');filter:blur(0)}}';
}

function injectStyleOnce(id, css) {
    let el = document.getElementById(id);
    if (!el) {
        el = document.createElement('style');
        el.id = id;
        document.head.appendChild(el);
    }
    el.textContent = css;
}

// Approximate sweep for browsers without the View Transitions API: cover the
// viewport with the previous theme's background, flip underneath, then shrink
// the curtain into the click point.
function fallbackSweep(apply, point) {
    let curtain = null;
    try {
        const body = getComputedStyle(document.body);
        const isLight = document.body.classList.contains('light-mode');
        const bg = (body.backgroundColor && body.backgroundColor !== 'rgba(0, 0, 0, 0)')
            ? body.backgroundColor
            : (body.getPropertyValue('--bg').trim() || (isLight ? '#f4f5f8' : '#0b0b10'));
        curtain = document.createElement('div');
        curtain.setAttribute('aria-hidden', 'true');
        curtain.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:99999;will-change:clip-path';
        curtain.style.background = bg;
        if (body.backgroundImage && body.backgroundImage !== 'none') curtain.style.backgroundImage = body.backgroundImage;
        curtain.style.clipPath = 'circle(' + coverRadius(point) + 'px at ' + Math.round(point.x) + 'px ' + Math.round(point.y) + 'px)';
        document.body.appendChild(curtain);
        void curtain.offsetWidth; // paint the covering frame before the flip
    } catch { /* decoration only — never block the flip */ }

    try {
        apply();
    } finally {
        if (!curtain) return;
        if (typeof curtain.animate !== 'function') { curtain.remove(); return; }
        const anim = curtain.animate(
            [
                { clipPath: curtain.style.clipPath },
                { clipPath: 'circle(0px at ' + Math.round(point.x) + 'px ' + Math.round(point.y) + 'px)' },
            ],
            { duration: SWEEP_MS, easing: SWEEP_EASE, fill: 'forwards' }
        );
        anim.onfinish = () => curtain.remove();
        anim.oncancel = () => curtain.remove();
    }
}

// Run `apply` (the class/state flip) inside an animated view transition.
export function themeSweep(apply, origin) {
    if (reducedMotion()) { apply(); return; }
    let point = origin || null;
    if (!point) {
        const fresh = document.__vigilLastClick;
        point = (fresh && Date.now() - fresh.at < 1500)
            ? { x: fresh.x, y: fresh.y }
            : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    }
    if (HAS_VT) {
        try {
            injectStyleOnce('vigil-theme-sweep', sweepCSS(point));
            document.startViewTransition(apply);
            return;
        } catch { /* transition refused — fall through to the curtain */ }
    }
    fallbackSweep(apply, point);
}

// Track the last pointer position module-wide (the SweepToggle reads it).
export function trackLastClick() {
    if (typeof document === 'undefined' || document.__vigilClickTracked) return;
    document.__vigilClickTracked = true;
    document.addEventListener('pointerdown', (e) => {
        document.__vigilLastClick = { x: e.clientX, y: e.clientY, at: Date.now() };
    }, { passive: true });
}

// ──────────────────── 2. Card glow + ambient light ────────────────────
// One pointermove listener drives both effects, writing CSS variables that
// the stylesheet consumes — no React re-renders on the hot path.
//   • .card::before conic border glow, tinted/angled toward the cursor
//   • .ambient radial light following the cursor (vanilla's #ambient div)
// Controlled by the saved config: cardGlow / ambientLight.

export function installPointerFX({ cardGlow = true, ambientLight = true } = {}) {
    useEffect(() => {
        trackLastClick();
        if (reducedMotion() || (!cardGlow && !ambientLight)) return undefined;

        let raf = 0;
        let last = null;

        function paint() {
            raf = 0;
            if (!last) return;
            const { x, y } = last;
            document.documentElement.style.setProperty('--mx', String(x / window.innerWidth));
            document.documentElement.style.setProperty('--my', String(y / window.innerHeight));
            if (cardGlow) {
                for (const card of document.querySelectorAll('.card, .stat')) {
                    const r = card.getBoundingClientRect();
                    const cx = r.left + r.width / 2;
                    const cy = r.top + r.height / 2;
                    const dx = x - cx, dy = y - cy;
                    const d = Math.sqrt(dx * dx + dy * dy);
                    const intensity = Math.max(0, 1 - d / 250);
                    const ang = (Math.atan2(dy, dx) * (180 / Math.PI)) + 90;
                    card.style.setProperty('--glow-int', intensity.toFixed(3));
                    card.style.setProperty('--glow-ang', ang.toFixed(1) + 'deg');
                }
            }
        }

        function onMove(e) {
            last = { x: e.clientX, y: e.clientY };
            if (!raf) raf = requestAnimationFrame(paint);
        }

        document.addEventListener('pointermove', onMove, { passive: true });
        return () => {
            document.removeEventListener('pointermove', onMove);
            if (raf) cancelAnimationFrame(raf);
        };
    }, [cardGlow, ambientLight]);
}

// The ambient light element — rendered by App when ambientLight is on.
export function AmbientLight() {
    return <div className="ambient" aria-hidden="true" />;
}

// ──────────────────── 3. Scroll reveal ────────────────────
// Vanilla revealed `.sr` elements through an IntersectionObserver; in React
// the clean equivalent is a per-card observer hook. Attach it to any element
// ref — the element starts translated/faded and eases in on first sight.
// Skipped entirely under reduced motion (elements render revealed).

export function useReveal() {
    const ref = useRef(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || reducedMotion()) return undefined;
        if (typeof IntersectionObserver === 'undefined') return undefined;
        el.classList.add('sr');
        const io = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (entry.isIntersecting) {
                    el.classList.add('sr-in');
                    io.unobserve(el);
                }
            }
        }, { threshold: 0.1 });
        io.observe(el);
        return () => {
            io.disconnect();
            el.classList.remove('sr', 'sr-in');
        };
    }, []);
    return ref;
}

// Convenience wrapper for cards that should reveal on scroll.
export function Reveal({ as: Tag = 'div', children, ...rest }) {
    const ref = useReveal();
    return <Tag ref={ref} {...rest}>{children}</Tag>;
}

// ──────────────────── Theme toggle with sweep ────────────────────
// Drop-in replacement for the plain theme button: flips the theme inside the
// sweep transition, origin = the button just clicked.
export function SweepToggle({ theme, onToggle }) {
    return (
        <button
            className="icon-btn"
            title={'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode'}
            onClick={(e) => {
                trackLastClick();
                const rect = e.currentTarget.getBoundingClientRect();
                const origin = {
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                };
                themeSweep(() => onToggle(), origin);
            }}
        >
            {theme === 'dark' ? '🌙' : '☀️'}
        </button>
    );
}

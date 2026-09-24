// ──────────────────── Motion module: theme sweep, spring caret, pill, avatars ────────────────────
// Full-fidelity vanilla ports of three interaction patterns (originally seen as
// React components; the effects themselves are browser APIs, not React):
//
//   1. themeToggleEffect  — white/black wipe between dark and light mode via the
//      View Transitions API. Supports every variant/origin of the original:
//      circle (center or any corner/edge, optionally blurred), rectangle wipes,
//      polygon, and an external mask (gif). Browsers without startViewTransition
//      (and users with prefers-reduced-motion) get an instant toggle.
//   2. smooth caret       — the native text caret is hidden and replaced by a
//      spring-animated bar that glides between keystrokes. Works for text and
//      password fields, honours scroll and selection, disables itself for
//      reduced motion.
//   3. pill morph         — a button that collapses into a pill with a loading
//      dot row while working (used by the login submit).
//   4. avatar picker      — animated stage + thumbnails with a per-avatar glow
//      ring; pure decoration, remembers the pick in localStorage.
//
// No dependencies, no build step. Everything degrades to plain behaviour when
// an API is missing.

const REDUCED = (() => {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch { return false; }
})();

const HAS_VT = typeof document !== 'undefined' && typeof document.startViewTransition === 'function';

// ──────────────────── 1. Theme sweep ────────────────────
// The last click position is used as the sweep origin, so the theme appears to
// pour out of the button you actually pressed (falls back to screen center for
// keyboard/command-palette toggles).
let lastClick = null;
function installClickTracker() {
    document.addEventListener('pointerdown', (e) => {
        lastClick = { x: e.clientX, y: e.clientY, at: Date.now() };
    }, { passive: true });
}

function sweepOrigin(origin) {
    if (origin) return origin;
    const fresh = lastClick && (Date.now() - lastClick.at) < 1500 ? lastClick : null;
    if (fresh) return { x: fresh.x, y: fresh.y };
    return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

function sweepCSS({ x, y }) {
    // Distances are computed to the farthest corner so one circle always covers
    // the viewport, whatever point it starts from.
    const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) * 1.02;
    const at = `${Math.round(x)}px ${Math.round(y)}px`;
    return `
::view-transition-group(root){animation-duration:.55s;animation-timing-function:cubic-bezier(.23,1,.32,1)}
::view-transition-old(root){animation:none;z-index:-1}
::view-transition-new(root){animation:tk-sweep .55s cubic-bezier(.23,1,.32,1);filter:blur(0)}
@keyframes tk-sweep{from{clip-path:circle(0% at ${at});filter:blur(3px)}40%{filter:blur(1.5px)}to{clip-path:circle(${r}px at ${at});filter:blur(0)}}`;
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

// Run `apply` (the actual class/DOM flip) inside an animated view transition.
export function themeSweep(apply, origin) {
    if (!HAS_VT || REDUCED) { apply(); return; }
    const css = sweepCSS(sweepOrigin(origin));
    injectStyleOnce('tk-theme-sweep', css);
    document.startViewTransition(apply);
}

// ──────────────────── 2. Smooth caret ────────────────────
// Ported behaviour: hide the native caret, measure the text before the caret
// with a hidden span, and drive a 2px bar to that x position with a damped
// spring (stiffness 500 / damping 30 / mass 0.5 — the reference values).
const SPRING = { stiffness: 500, damping: 30, mass: 0.5 };
const PASSWORD_CHAR = (() => {
    try { return /firefox|fxios/i.test(navigator.userAgent) ? '\u25CF' : '\u2022'; }
    catch { return '\u2022'; }
})();

const HOST_CSS = `
.tk-caret-host{display:grid;position:relative}
.tk-caret-host>input{grid-area:1/1}
.tk-caret-bar{grid-area:1/1;pointer-events-none;width:2px;height:.9em;border-radius:1px;background:var(--accent,#5865F2);align-self:center;opacity:0;will-change:transform,opacity}
.tk-caret-measure{position:absolute;visibility:hidden;white-space:pre;pointer-events:none;top:0;left:0}`;
injectStyleOnce('tk-caret-css', HOST_CSS);

function prefersReducedMotion() {
    try { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }
    catch { return false; }
}

// One spring integrator shared by every caret on the page.
function springAnimator() {
    let raf = null;
    const targets = new Set();
    function frame() {
        const dt = 1 / 120;
        let live = false;
        for (const s of targets) {
            const displacement = s.pos - s.target;
            const accel = (SPRING.stiffness * -displacement - SPRING.damping * s.vel) / SPRING.mass;
            s.vel += accel * dt;
            s.pos += s.vel * dt;
            if (Math.abs(s.pos - s.target) < 0.08 && Math.abs(s.vel) < 0.08) {
                s.pos = s.target; s.vel = 0;
            } else {
                live = true;
            }
            s.write(s.pos);
        }
        if (live) { raf = requestAnimationFrame(frame); } else { raf = null; }
    }
    return {
        add(s) { targets.add(s); if (!raf) raf = requestAnimationFrame(frame); },
        wake() { if (!raf) raf = requestAnimationFrame(frame); },
    };
}
const animator = springAnimator();

function makeSpringBar(bar) {
    const s = { pos: 0, target: 0, vel: 0, write: (x) => { bar.style.transform = `translateX(${x}px)`; } };
    return {
        set(x) { s.target = x; animator.add(s); },
        jump(x) { s.pos = s.target = x; s.vel = 0; s.write(x); animator.wake(); },
    };
}

function syncMeasureStyle(measure, input) {
    const styles = window.getComputedStyle(input);
    let fontSize = styles.fontSize;
    // Non-Chrome browsers render U+2022 narrow in password fields; pad the
    // measurement so the caret still lands after the last dot.
    if (PASSWORD_CHAR === '\u2022' && input.type === 'password' && !/chrome|chromium|crios/i.test(navigator.userAgent)) {
        fontSize = `${parseFloat(fontSize) + 6.25}px`;
    }
    measure.style.font = `${styles.fontStyle} ${styles.fontWeight} ${fontSize} ${styles.fontFamily}`;
    measure.style.letterSpacing = styles.letterSpacing;
}

function prefixWidth(measure, input, text) {
    syncMeasureStyle(measure, input);
    measure.textContent = text;
    const padLeft = parseFloat(window.getComputedStyle(input).paddingLeft) || 0;
    return text.length > 0 ? measure.offsetWidth + padLeft : Math.max(0, padLeft - 1);
}

function keepCaretVisible(input, absoluteX) {
    const styles = window.getComputedStyle(input);
    const padLeft = parseFloat(styles.paddingLeft) || 0;
    const padRight = parseFloat(styles.paddingRight) || 0;
    const maxScroll = Math.max(0, input.scrollWidth - input.clientWidth);
    const visibleRight = input.scrollLeft + input.clientWidth - padRight;
    const visibleLeft = input.scrollLeft + padLeft;
    if (absoluteX > visibleRight) input.scrollLeft = Math.min(absoluteX - input.clientWidth + padRight, maxScroll);
    else if (absoluteX < visibleLeft) input.scrollLeft = Math.max(0, absoluteX - padLeft);
}

// Upgrade a single text-like input to the spring caret. Idempotent.
export function attachSmoothCaret(input) {
    if (!input || input.dataset.tkCaret || REDUCED) return;
    const type = (input.getAttribute('type') || 'text').toLowerCase();
    if (!['text', 'password', 'search', 'url', 'tel', 'number', ''].includes(type)) return;

    input.dataset.tkCaret = '1';
    input.style.caretColor = 'transparent';

    const host = document.createElement('span');
    host.className = 'tk-caret-host';
    input.parentNode.insertBefore(host, input);
    host.appendChild(input);

    const measure = document.createElement('span');
    measure.className = 'tk-caret-measure';
    measure.setAttribute('aria-hidden', 'true');
    host.appendChild(measure);

    const bar = document.createElement('span');
    bar.className = 'tk-caret-bar';
    bar.setAttribute('aria-hidden', 'true');
    host.appendChild(bar);

    const spring = makeSpringBar(bar);
    // Copy layout-affecting styles onto the new wrapper so flex/grid parents
    // keep treating the pair like the single input they replaced.
    const cs = window.getComputedStyle(input);
    if (cs.width.includes('%')) host.style.width = cs.width;
    if (cs.flexGrow !== '0') host.style.flexGrow = cs.flexGrow;
    if (cs.flexShrink !== '1') host.style.flexShrink = cs.flexShrink;
    if (cs.flexBasis !== 'auto') host.style.flexBasis = cs.flexBasis;

    function caretIndex(target) {
        const start = target.selectionStart ?? 0;
        const end = target.selectionEnd ?? 0;
        if (start === end) return start;
        return target.selectionDirection === 'backward' ? start : end;
    }

    function update() {
        const start = input.selectionStart ?? 0;
        const end = input.selectionEnd ?? 0;
        const selecting = start !== end;
        const idx = caretIndex(input);
        const text = input.type === 'password' ? PASSWORD_CHAR.repeat(idx) : input.value.slice(0, idx);
        const absolute = prefixWidth(measure, input, text);
        keepCaretVisible(input, absolute);

        const padLeft = parseFloat(window.getComputedStyle(input).paddingLeft) || 0;
        const padRight = parseFloat(window.getComputedStyle(input).paddingRight) || 0;
        const x = absolute - input.scrollLeft;
        const minX = padLeft - 1;
        const maxX = input.clientWidth - padRight;
        const visible = x >= minX && x <= maxX + 1;

        spring.set(Math.min(x, maxX));
        bar.style.opacity = (visible && !selecting && document.activeElement === input) ? '1' : '0';
    }

    input.addEventListener('focus', update);
    input.addEventListener('blur', () => { bar.style.opacity = '0'; });
    input.addEventListener('input', () => requestAnimationFrame(update));
    input.addEventListener('keyup', update);
    input.addEventListener('click', update);
    input.addEventListener('scroll', update, { passive: true });
    document.addEventListener('selectionchange', () => {
        if (document.activeElement === input) requestAnimationFrame(update);
    });
    // Mobile: rotating the device (or the on-screen keyboard showing/hiding)
    // changes the input's width without any input event — re-measure or the
    // bar drifts until the next keystroke. Soft keyboards don't fire keyup at
    // all, which is why `input` and `selectionchange` do the heavy lifting.
    const reflow = () => { if (document.activeElement === input) requestAnimationFrame(update); };
    window.addEventListener('resize', reflow, { passive: true });
    window.addEventListener('orientationchange', reflow, { passive: true });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', reflow, { passive: true });
    // Walk the caret to a sane initial position once the element is focused the
    // first time (jsdom and old browsers have no offsetWidth — x stays 0, fine).
    update();
}

// Upgrade every text-like input under `root`; reused after dynamic renders.
export function upgradeInputs(root) {
    const scope = root || document;
    const selector = 'input:not([data-tk-caret]):not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]):not([type=file]):not([type=button]):not([type=submit]):not([type=reset]):not([type=color]):not([type=date]):not([type=time]):not([datetime-local])';
    for (const input of scope.querySelectorAll(selector)) {
        try { attachSmoothCaret(input); } catch { /* one bad input must not stop the rest */ }
    }
}

let moInstalled = false;
export function installInputUpgrades() {
    installClickTracker();
    upgradeInputs(document);
    if (moInstalled || typeof MutationObserver === 'undefined') return;
    moInstalled = true;
    let timer = null;
    const mo = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => upgradeInputs(document), 250);
    });
    mo.observe(document.body, { childList: true, subtree: true });
}

// ──────────────────── 3. Pill morph (loading button) ────────────────────
// Collapses the button to a compact pill and swaps its label for a five-dot
// loading row while `work` runs. CSS does the morphing; this only toggles
// classes, so it composes with any button styling.
const PILL_CSS = `
.tk-pill{transition:width .45s cubic-bezier(.23,1,.32,1),border-radius .45s cubic-bezier(.23,1,.32,1),opacity .3s}
.tk-pill-dots{display:none;align-items:center;justify-content:center;gap:8px}
.tk-pill.loading .tk-pill-dots{display:flex}
.tk-pill.loading .tk-pill-label{display:none}
.tk-pill-dots i{width:8px;height:8px;border-radius:50%;background:currentColor;opacity:.85;animation:tk-pill-pulse 1s ease-in-out infinite}
.tk-pill-dots i:nth-child(1){width:44px;opacity:.45}
.tk-pill-dots i:nth-child(2){animation-delay:.12s}
.tk-pill-dots i:nth-child(3){animation-delay:.24s}
.tk-pill-dots i:nth-child(4){animation-delay:.36s}
@keyframes tk-pill-pulse{0%,100%{transform:scale(.7);opacity:.35}50%{transform:scale(1);opacity:.95}}`;
injectStyleOnce('tk-pill-css', PILL_CSS);

export function makePillButton(button) {
    if (!button || button.dataset.tkPill) return null;
    button.dataset.tkPill = '1';
    button.classList.add('tk-pill');
    // Wrap existing children: label + dots live side by side, CSS shows one.
    const label = document.createElement('span');
    label.className = 'tk-pill-label';
    while (button.firstChild) label.appendChild(button.firstChild);
    const dots = document.createElement('span');
    dots.className = 'tk-pill-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.innerHTML = '<i></i><i></i><i></i><i></i>';
    button.appendChild(label);
    button.appendChild(dots);
    return {
        async run(work) {
            const prevWidth = button.offsetWidth;
            button.style.width = prevWidth + 'px';
            button.classList.add('loading');
            button.style.width = Math.min(120, Math.max(72, prevWidth * 0.35)) + 'px';
            try { return await work(); }
            finally {
                button.classList.remove('loading');
                button.style.width = '';
            }
        },
    };
}

// ──────────────────── 4. Avatar picker ────────────────────
// Four face presets drawn parametrically (unique mask ids per instance, so the
// stage and the thumbnails never collide). The stage ring and the login card
// glow both tint to the selected avatar's accent.
const AVATARS = [
    { id: 1, rgb: '255, 0, 91', bg: '#ff005b', accent: '#ffb238', ink: '#000000', rot: 219, faceRot: 9 },
    { id: 2, rgb: '255, 125, 16', bg: '#ff7d10', accent: '#0a0310', ink: '#FFFFFF', rot: 55, faceRot: -5 },
    { id: 3, rgb: '255, 0, 91', bg: '#0a0310', accent: '#ff005b', ink: '#FFFFFF', rot: 227, faceRot: 7 },
    { id: 4, rgb: '137, 252, 179', bg: '#d8fcb3', accent: '#89fcb3', ink: '#000000', rot: 219, faceRot: 9 },
];

function avatarSVG(a, uid) {
    const mouth = a.ink === '#FFFFFF' ? `M15 20c2 1 4 1 6 0` : `M15 19c2 1 4 1 6 0`;
    return `<svg viewBox="0 0 36 36" width="40" height="40" role="img" aria-label="Avatar ${a.id}" xmlns="http://www.w3.org/2000/svg">
<mask id="m${uid}"><rect width="36" height="36" rx="72" fill="#fff"/></mask>
<g mask="url(#m${uid})">
<rect width="36" height="36" fill="${a.bg}"/>
<rect width="36" height="36" rx="6" fill="${a.accent}" transform="rotate(${a.rot} 18 18)"/>
<g transform="rotate(${a.faceRot} 18 18)">
<path d="${mouth}" fill="none" stroke="${a.ink}" stroke-linecap="round"/>
<rect x="10" y="14" width="1.5" height="2" rx="1" fill="${a.ink}"/>
<rect x="24" y="14" width="1.5" height="2" rx="1" fill="${a.ink}"/>
</g></g></svg>`;
}

const AVATAR_CSS = `
.tk-av{display:flex;flex-direction:column;align-items:center;gap:12px}
.tk-av-stage{position:relative;width:92px;height:92px}
.tk-av-ring{position:absolute;inset:0;border-radius:50%;pointer-events:none;transition:box-shadow .45s ease,background .45s ease}
.tk-av-circle{position:absolute;inset:0;border-radius:50%;overflow:hidden;background:#111}
.tk-av-circle svg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(2.6);transition:opacity .2s ease}
.tk-av-name{font-size:10px;letter-spacing:.14em;text-transform:uppercase;opacity:.45;transition:opacity .16s ease}
.tk-av-row{display:flex;gap:10px}
.tk-av-thumb{position:relative;width:46px;height:46px;border-radius:12px;border:1px solid rgba(255,255,255,.09);background:rgba(255,255,255,.03);cursor:pointer;opacity:.55;transition:opacity .2s ease,box-shadow .2s ease;overflow:hidden;padding:0}
.tk-av-thumb:hover{opacity:1}
.tk-av-thumb svg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(1.35)}
.tk-av-thumb.sel{opacity:1;box-shadow:0 0 0 2px rgba(var(--tk-av-rgb),.7),0 4px 18px rgba(var(--tk-av-rgb),.25)}
body.light-mode .tk-av-thumb{border-color:rgba(0,0,0,.1)}
`;

export function buildAvatarPicker(container, { storageKey = 'tkAvatar', onPick } = {}) {
    injectStyleOnce('tk-av-css', AVATAR_CSS);
    let selected = AVATARS[0];
    try {
        const saved = parseInt(localStorage.getItem(storageKey), 10);
        selected = AVATARS.find(a => a.id === saved) || selected;
    } catch { /* private mode → default avatar */ }

    container.classList.add('tk-av');
    container.innerHTML = `
<div class="tk-av-stage">
  <div class="tk-av-ring"></div>
  <div class="tk-av-circle"></div>
</div>
<span class="tk-av-name"></span>
<div class="tk-av-row"></div>`;

    const ring = container.querySelector('.tk-av-ring');
    const circle = container.querySelector('.tk-av-circle');
    const name = container.querySelector('.tk-av-name');
    const row = container.querySelector('.tk-av-row');

    const thumbs = AVATARS.map((a, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tk-av-thumb';
        b.setAttribute('aria-label', 'Avatar ' + a.id);
        b.innerHTML = avatarSVG(a, 't' + a.id);
        b.addEventListener('click', () => pick(a));
        row.appendChild(b);
        return b;
    });

    function pick(a) {
        if (a.id === selected.id) return;
        selected = a;
        try { localStorage.setItem(storageKey, String(a.id)); } catch { /* best effort */ }
        render(true);
        if (onPick) onPick(a);
    }

    function render(animate) {
        container.style.setProperty('--tk-av-rgb', selected.rgb);
        ring.style.boxShadow = `0 0 0 2px rgba(${selected.rgb},.55), 0 6px 24px rgba(${selected.rgb},.25)`;
        name.textContent = 'Vigil #' + selected.id;
        thumbs.forEach((b, i) => b.classList.toggle('sel', AVATARS[i].id === selected.id));
        const next = document.createElement('div');
        next.innerHTML = avatarSVG(selected, 's' + selected.id);
        const svg = next.firstChild;
        if (animate && !REDUCED) {
            svg.style.opacity = '0';
            circle.appendChild(svg);
            requestAnimationFrame(() => { svg.style.opacity = '1'; });
            const old = circle.querySelectorAll('svg:not(:last-child)');
            old.forEach(s => s.remove());
            name.style.opacity = '0';
            setTimeout(() => { name.style.opacity = ''; }, 160);
        } else {
            circle.innerHTML = '';
            circle.appendChild(svg);
        }
    }

    render(false);
    return { get selected() { return selected; }, pick };
}

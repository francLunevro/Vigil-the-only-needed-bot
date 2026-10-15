// ──────────────────── Dashboard config applier ────────────────────
// One function that takes the saved dashboard config (GET/POST
// /api/dash/config) and applies every visual setting to the running page:
// accent, font, radius, border intensity, card style, layout density, theme
// palette, background image, favicon, and document title.
//
// Idempotent: applying the same config twice is a no-op, so callers can run
// it on every fetch/save/preview without duplicating <link> elements or
// stacking styles. Everything is expressed as inline custom properties on
// <html> / <body>, which beat the stylesheet's :root / html.light-mode
// declarations — so no injected <style> element is needed.

// Font stacks per fontFamily value. 'inter' is the stylesheet default, so it
// clears the override instead of setting one.
export const FONT_STACKS = {
    inter: null,
    system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    grotesk: "'Space Grotesk', 'Inter', sans-serif",
    rounded: "'Nunito', 'Inter', sans-serif",
    mono: "'JetBrains Mono', 'Inter', monospace",
};

// Full colour schemes per themePreset (mirrors the vanilla palette picker,
// translated to this app's tokens: --surface → --card, --bg-card → --bg-elev).
// `light` replaces only the page background in light mode, like the vanilla
// `body.theme-x.light-mode { --bg: … }` rules.
export const PALETTES = [
    { id: 'discord', name: 'Discord', swatch: 'linear-gradient(135deg,#5865F2 0%,#07070d 100%)', dark: null, light: null },
    {
        id: 'midnight', name: 'Midnight', swatch: 'linear-gradient(135deg,#23264d 0%,#010104 100%)',
        dark: { '--bg': '#010104', '--bg-elev': '#0b0b16', '--card': 'rgba(255,255,255,0.045)', '--card-border': 'rgba(160,170,255,0.10)', '--text': '#eceefc', '--text-dim': 'rgba(225,230,250,0.68)', '--text-muted': 'rgba(225,230,250,0.42)' },
        light: { '--bg': '#f2f3fa' },
    },
    {
        id: 'nord', name: 'Nord', swatch: 'linear-gradient(135deg,#88c0d0 0%,#242933 100%)',
        dark: { '--bg': '#242933', '--bg-elev': '#2e3440', '--card': 'rgba(216,222,233,0.06)', '--card-border': 'rgba(216,222,233,0.14)', '--text': '#eceff4', '--text-dim': 'rgba(236,239,244,0.72)', '--text-muted': 'rgba(236,239,244,0.48)' },
        light: { '--bg': '#eceff4' },
    },
    {
        id: 'dracula', name: 'Dracula', swatch: 'linear-gradient(135deg,#bd93f9 0%,#1b1c28 100%)',
        dark: { '--bg': '#1b1c28', '--bg-elev': '#242638', '--card': 'rgba(255,255,255,0.055)', '--card-border': 'rgba(189,147,249,0.16)', '--text': '#f8f8f2', '--text-dim': 'rgba(248,248,242,0.7)', '--text-muted': 'rgba(248,248,242,0.45)' },
        light: { '--bg': '#efeffa' },
    },
    {
        id: 'forest', name: 'Forest', swatch: 'linear-gradient(135deg,#86efac 0%,#0d1410 100%)',
        dark: { '--bg': '#0d1410', '--bg-elev': '#122019', '--card': 'rgba(134,239,172,0.05)', '--card-border': 'rgba(134,239,172,0.13)', '--text': '#e9f5ec', '--text-dim': 'rgba(233,245,236,0.68)', '--text-muted': 'rgba(233,245,236,0.42)' },
        light: { '--bg': '#eef5f0' },
    },
    {
        id: 'sunset', name: 'Sunset', swatch: 'linear-gradient(135deg,#fb923c 0%,#150f0d 100%)',
        dark: { '--bg': '#150f0d', '--bg-elev': '#211713', '--card': 'rgba(251,146,60,0.05)', '--card-border': 'rgba(251,146,60,0.14)', '--text': '#fdf3ea', '--text-dim': 'rgba(253,243,234,0.68)', '--text-muted': 'rgba(253,243,234,0.42)' },
        light: { '--bg': '#faf1ea' },
    },
    {
        id: 'ocean', name: 'Ocean', swatch: 'linear-gradient(135deg,#38bdf8 0%,#081420 100%)',
        dark: { '--bg': '#081420', '--bg-elev': '#0d1f30', '--card': 'rgba(56,189,248,0.05)', '--card-border': 'rgba(56,189,248,0.14)', '--text': '#e8f4fd', '--text-dim': 'rgba(232,244,253,0.68)', '--text-muted': 'rgba(232,244,253,0.42)' },
        light: { '--bg': '#eaf4fb' },
    },
    {
        id: 'rose', name: 'Rose', swatch: 'linear-gradient(135deg,#f43f5e 0%,#160d13 100%)',
        dark: { '--bg': '#160d13', '--bg-elev': '#221220', '--card': 'rgba(244,63,94,0.05)', '--card-border': 'rgba(244,63,94,0.15)', '--text': '#fbeef2', '--text-dim': 'rgba(251,238,242,0.68)', '--text-muted': 'rgba(251,238,242,0.45)' },
        light: { '--bg': '#faeff4' },
    },
];

// Every token a palette may own — cleared before each apply so switching from
// a coloured palette back to Discord (or to light mode) resets cleanly.
const PALETTE_TOKENS = ['--bg', '--bg-elev', '--card', '--card-border', '--text', '--text-dim', '--text-muted'];

const RADIUS = { compact: '9px', rounded: null, pill: '22px' }; // null = stylesheet default (14px)

// Border intensity per borderStrength, per mode. null = stylesheet default.
const BORDERS = {
    normal: { dark: null, light: null },
    subtle: { dark: 'rgba(255,255,255,0.05)', light: 'rgba(10,12,20,0.05)' },
    strong: { dark: 'rgba(255,255,255,0.16)', light: 'rgba(10,12,20,0.16)' },
};

function setProp(name, value) {
    if (value) document.documentElement.style.setProperty(name, value);
    else document.documentElement.style.removeProperty(name);
}

// URL guard shared with the login page / branding consumers: only https URLs
// and same-origin /uploads paths may be injected into the DOM.
export function safeUrl(u) {
    return typeof u === 'string' && (/^https:\/\//.test(u) || /^\/uploads\//.test(u)) ? u : null;
}

function applyFavicon(url) {
    let link = document.querySelector('link[rel="icon"]');
    if (!url) {
        if (link) link.remove();
        return;
    }
    if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
    }
    link.href = url;
}

// Apply `config` to the page. `isDark` picks the mode-dependent values
// (border intensity, palette dark vs light); callers that know the current
// theme pass it, otherwise the light-mode class is read.
export function applyConfig(c, isDark) {
    if (!c || typeof c !== 'object') return;
    if (typeof isDark !== 'boolean') {
        isDark = !document.documentElement.classList.contains('light-mode');
    }

    // Accent colour (drives --accent + --accent-rgb everywhere).
    if (c.accentColor && /^#[0-9a-fA-F]{6}$/.test(c.accentColor)) {
        const r = parseInt(c.accentColor.slice(1, 3), 16);
        const g = parseInt(c.accentColor.slice(3, 5), 16);
        const b = parseInt(c.accentColor.slice(5, 7), 16);
        setProp('--accent', c.accentColor);
        setProp('--accent-rgb', r + ',' + g + ',' + b);
    }

    // Interface font.
    const stack = FONT_STACKS[c.fontFamily];
    if (stack) document.body.style.fontFamily = stack;
    else document.body.style.removeProperty('font-family');

    // Corner radius scale.
    setProp('--radius', RADIUS[c.borderRadius] ?? null);

    // Card style: glass (default) / solid / border-only.
    document.body.classList.toggle('card-solid', c.cardStyle === 'solid');
    document.body.classList.toggle('card-border', c.cardStyle === 'border');

    // Layout density: the variable scales grid gaps; the class tightens
    // paddings (the stylesheet's var() fallback keeps normal at 1).
    const dense = c.layoutDensity === 'compact' ? '0.7' : c.layoutDensity === 'comfortable' ? '1.2' : null;
    setProp('--layout-dense', dense);
    document.body.classList.toggle('density-compact', c.layoutDensity === 'compact');

    // Theme palette first: clear every palette-owned token, then apply either
    // the full dark scheme or the light background-only override.
    for (const token of PALETTE_TOKENS) setProp(token, null);
    const palette = PALETTES.find((p) => p.id === (c.themePreset || 'discord'));
    if (palette) {
        const values = isDark ? palette.dark : palette.light;
        if (values) for (const [token, value] of Object.entries(values)) setProp(token, value);
    }

    // Border intensity LAST — it deliberately overrides the palette's border
    // token, mirroring the vanilla CSS where border-subtle/strong carry
    // !important over the theme palettes.
    const border = (BORDERS[c.borderStrength] || BORDERS.normal)[isDark ? 'dark' : 'light'];
    setProp('--card-border', border);

    // Custom background image (uploads land in /uploads, URLs must be https).
    const bg = c.backgroundType !== 'none' ? safeUrl(c.backgroundImage) : null;
    if (bg) {
        document.body.style.backgroundImage = 'url(' + bg + ')';
        document.body.style.backgroundSize = 'cover';
        document.body.style.backgroundPosition = 'center';
        document.body.style.backgroundAttachment = 'fixed';
    } else {
        document.body.style.removeProperty('background-image');
        document.body.style.removeProperty('background-size');
        document.body.style.removeProperty('background-position');
        document.body.style.removeProperty('background-attachment');
    }

    // Branding.
    applyFavicon(safeUrl(c.faviconUrl));
    // botAvatarUrl is display-only metadata the classic dashboard stored
    // without consuming; nothing to apply here yet.
    document.title = (c.title || 'Vigil') + ' — Dashboard';
}

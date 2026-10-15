import { useEffect, useRef } from 'react';

// ──────────────────── Ambient background canvas ────────────────────
// Port of the vanilla dashboard's background engines (01-foundation.mjs):
// the same nine effects, in readable form, rendered on one canvas fixed
// behind the app. The accent colour is read live from CSS each frame, so an
// accent change in Customize propagates without a remount. Mouse tracking
// uses document listeners (not React state) to keep the hot path cheap.
//
// Skipped entirely when the user prefers reduced motion — the effect is
// decoration, and the app must stay calm.

function dotsEngine(ctx, api) {
    let dots = [];
    return {
        build(w, h) {
            dots = [];
            const sp = 28;
            for (let r = 0; r < Math.floor(h / sp); r++) {
                for (let c = 0; c < Math.floor(w / sp); c++) {
                    const x = ((w % sp) / 2) + c * sp + sp / 2;
                    const y = ((h % sp) / 2) + r * sp + sp / 2;
                    dots.push({ x, y, ox: x, oy: y });
                }
            }
        },
        frame(w, h) {
            ctx.clearRect(0, 0, w, h);
            const ac = api.accent();
            for (const d of dots) {
                const dx = api.mx - d.ox, dy = api.my - d.oy;
                const di = Math.sqrt(dx * dx + dy * dy);
                const mD = 120;
                let ox = 0, oy = 0;
                if (di < mD) {
                    const f = (1 - di / mD) * 18;
                    const a2 = Math.atan2(dy, dx);
                    ox = -Math.cos(a2) * f;
                    oy = -Math.sin(a2) * f;
                }
                d.x += (d.ox + ox - d.x) * 0.1;
                d.y += (d.oy + oy - d.y) * 0.1;
                ctx.beginPath();
                ctx.arc(d.x, d.y, 1, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(' + ac + ',' + (0.12 + 0.2 * (1 - Math.min(di / 300, 1))) + ')';
                ctx.fill();
                if (di < mD) {
                    ctx.beginPath();
                    ctx.arc(d.x, d.y, 1.6, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(' + ac + ',' + ((1 - di / mD) * 0.4) + ')';
                    ctx.fill();
                }
            }
        },
    };
}

function shapesEngine(ctx, api) {
    let shapes = [];
    let t = 0;
    return {
        build(w, h) {
            shapes = [];
            const sp = 48;
            for (let r = 0; r < Math.ceil(h / sp) + 2; r++) {
                for (let c = 0; c < Math.ceil(w / sp) + 2; c++) {
                    shapes.push({ x: c * sp, y: r * sp, ox: c * sp, oy: r * sp, v: 0.5 + Math.random() * 0.5, ph: Math.random() * Math.PI * 2 });
                }
            }
        },
        frame(w, h) {
            t += 0.008;
            ctx.clearRect(0, 0, w, h);
            const ac = api.accent();
            for (const s of shapes) {
                const dx = api.mx - s.ox, dy = api.my - s.oy;
                const di = Math.sqrt(dx * dx + dy * dy);
                const mD = 160;
                let ox = 0, oy = 0, sc = 1;
                if (di < mD) {
                    const f = 1 - di / mD;
                    const a2 = Math.atan2(dy, dx);
                    ox = -Math.cos(a2) * f * 24;
                    oy = -Math.sin(a2) * f * 24;
                    sc = 1 + f * 0.4;
                }
                s.x += (s.ox + ox - s.x) * 0.06;
                s.y += (s.oy + oy - s.y) * 0.06;
                const ry = s.y + Math.sin(t * s.v + s.ph) * 1.5;
                ctx.save();
                ctx.translate(s.x, ry);
                ctx.scale(sc, sc);
                ctx.globalAlpha = 0.18 + 0.1 * Math.sin(t * 0.5 + s.ph);
                ctx.strokeStyle = 'rgba(' + ac + ',0.3)';
                ctx.lineWidth = 0.8;
                ctx.beginPath();
                ctx.arc(0, 0, 5, 0, Math.PI * 2);
                ctx.stroke();
                ctx.restore();
            }
            ctx.globalAlpha = 1;
        },
    };
}

function glitchEngine(ctx, api) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$&*()-_+=/[]{};:<>.,0123456789';
    let cells = [];
    return {
        build(w, h) {
            cells = [];
            const cols = Math.ceil(w / 16), rows = Math.ceil(h / 20);
            for (let i = 0; i < cols * rows; i++) {
                cells.push({ char: CHARS[(Math.random() * CHARS.length) | 0], target: CHARS[(Math.random() * CHARS.length) | 0], prog: 1 });
            }
        },
        frame(w, h) {
            ctx.clearRect(0, 0, w, h);
            const ac = api.accent();
            // A slice of the grid flips each frame; flipping chars glow
            // brighter while transitioning (vanilla's matrix shimmer).
            const up = Math.max(1, Math.floor(cells.length * 0.03));
            for (let i = 0; i < up; i++) {
                const cell = cells[(Math.random() * cells.length) | 0];
                cell.target = CHARS[(Math.random() * CHARS.length) | 0];
                cell.prog = 0;
            }
            for (const cell of cells) {
                if (cell.prog < 1) {
                    cell.prog += 0.05;
                    if (cell.prog >= 1) cell.char = cell.target;
                }
            }
            const cols = Math.ceil(w / 16);
            ctx.font = '13px monospace';
            ctx.textBaseline = 'top';
            cells.forEach((cell, i) => {
                const alpha = cell.prog < 1 ? 0.03 + cell.prog * 0.27 : 0.08;
                ctx.fillStyle = 'rgba(' + ac + ',' + alpha + ')';
                ctx.fillText(cell.char, (i % cols) * 16, Math.floor(i / cols) * 20);
            });
        },
    };
}

function liquidEngine(ctx, api) {
    let t = 0;
    return {
        build() {},
        frame(w, h) {
            t += 0.01;
            ctx.clearRect(0, 0, w, h);
            const ac = api.accent();
            const step = 18;
            for (let y = 0; y < h; y += step) {
                for (let x = 0; x < w; x += step) {
                    const dx = api.mx - x, dy = api.my - y;
                    const di = Math.sqrt(dx * dx + dy * dy);
                    const dist = Math.sin(x * 0.008 + t) * 4 + Math.cos(y * 0.008 + t * 1.3) * 4;
                    const pull = di < 180 ? (1 - di / 180) * 12 : 0;
                    const offX = dist + Math.cos(dy * 0.01 + t * 0.7) * pull;
                    const offY = Math.sin(dy * 0.008 + t * 1.1) * 4 + Math.sin(dx * 0.01 + t * 0.5) * pull;
                    const sz = 1.5 + Math.sin(x * 0.01 + y * 0.01 + t) * 0.5;
                    ctx.beginPath();
                    ctx.arc(x + offX, y + offY, sz, 0, Math.PI * 2);
                    ctx.fillStyle = 'rgba(' + ac + ',0.07)';
                    ctx.fill();
                }
            }
        },
    };
}

function gridEngine(ctx, api) {
    return {
        build() {},
        frame(w, h) {
            ctx.clearRect(0, 0, w, h);
            const ac = api.accent();
            const cx = w / 2, cy = h / 2;
            const mx = (api.mx - cx) / cx, my = (api.my - cy) / cy;
            const step = 40;
            for (let x = 0; x < w; x += step) {
                const off = mx * 24 * (1 - Math.abs(x - cx) / cx);
                ctx.beginPath();
                ctx.moveTo(x + off, 0);
                ctx.lineTo(x + off, h);
                ctx.strokeStyle = 'rgba(' + ac + ',0.03)';
                ctx.lineWidth = 0.5;
                ctx.stroke();
            }
            for (let y = 0; y < h; y += step) {
                const off = my * 24 * (1 - Math.abs(y - cy) / cy);
                ctx.beginPath();
                ctx.moveTo(0, y + off);
                ctx.lineTo(w, y + off);
                ctx.strokeStyle = 'rgba(' + ac + ',0.03)';
                ctx.lineWidth = 0.5;
                ctx.stroke();
            }
            const grd = ctx.createRadialGradient(api.mx, api.my, 0, api.mx, api.my, 200);
            grd.addColorStop(0, 'rgba(' + ac + ',0.05)');
            grd.addColorStop(1, 'transparent');
            ctx.fillStyle = grd;
            ctx.fillRect(0, 0, w, h);
        },
    };
}

function constellationEngine(ctx, api) {
    const LINK = 130;
    let ps = [];
    return {
        build(w, h) {
            ps = [];
            const N = Math.min(70, Math.floor((w * h) / 22000));
            for (let i = 0; i < N; i++) {
                ps.push({ x: Math.random() * w, y: Math.random() * h, vx: (Math.random() - 0.5) * 0.35, vy: (Math.random() - 0.5) * 0.35, r: 1 + Math.random() * 1.4 });
            }
        },
        frame(w, h) {
            ctx.clearRect(0, 0, w, h);
            const ac = api.accent();
            for (const p of ps) {
                p.x += p.vx;
                p.y += p.vy;
                if (p.x < 0 || p.x > w) p.vx *= -1;
                if (p.y < 0 || p.y > h) p.vy *= -1;
            }
            for (let i = 0; i < ps.length; i++) {
                for (let j = i + 1; j < ps.length; j++) {
                    const dx = ps[i].x - ps[j].x, dy = ps[i].y - ps[j].y;
                    const d = Math.sqrt(dx * dx + dy * dy);
                    if (d < LINK) {
                        ctx.beginPath();
                        ctx.moveTo(ps[i].x, ps[i].y);
                        ctx.lineTo(ps[j].x, ps[j].y);
                        ctx.strokeStyle = 'rgba(' + ac + ',' + ((1 - d / LINK) * 0.14) + ')';
                        ctx.lineWidth = 0.6;
                        ctx.stroke();
                    }
                }
            }
            for (const p of ps) {
                const dx = api.mx - p.x, dy = api.my - p.y;
                const d = Math.sqrt(dx * dx + dy * dy);
                const near = d < 150 ? 1 - d / 150 : 0;
                ctx.beginPath();
                ctx.arc(p.x, p.y, p.r + near * 1.2, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(' + ac + ',' + (0.25 + near * 0.45) + ')';
                ctx.fill();
            }
        },
    };
}

function auroraEngine(ctx, api) {
    let t = 0;
    return {
        build() {},
        frame(w, h) {
            t += 0.004;
            ctx.clearRect(0, 0, w, h);
            const [r, g, b] = api.accent().split(',').map(Number);
            const bands = [[0.25, 140, 0.05], [0.5, 260, 0.04], [0.72, 200, 0.045]];
            for (const [yc, R, al] of bands) {
                const cx = w * (0.5 + 0.32 * Math.sin(t * 1.7 + yc * 9));
                const cy = h * yc + Math.sin(t * 2.3 + yc * 7) * 60;
                const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
                grd.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',' + al + ')');
                grd.addColorStop(1, 'transparent');
                ctx.fillStyle = grd;
                ctx.fillRect(0, 0, w, h);
            }
            ctx.globalCompositeOperation = 'lighter';
            const glow = ctx.createRadialGradient(api.mx, api.my, 0, api.mx, api.my, 180);
            glow.addColorStop(0, 'rgba(' + r + ',' + g + ',' + b + ',0.05)');
            glow.addColorStop(1, 'transparent');
            ctx.fillStyle = glow;
            ctx.fillRect(0, 0, w, h);
            ctx.globalCompositeOperation = 'source-over';
        },
    };
}

function starfieldEngine(ctx, api) {
    let stars = [];
    return {
        build(w, h) {
            stars = [];
            const N = Math.min(160, Math.floor((w * h) / 9000));
            for (let i = 0; i < N; i++) {
                stars.push({ x: Math.random() * w, y: Math.random() * h, z: 0.3 + Math.random() * 0.7, tw: Math.random() * Math.PI * 2 });
            }
        },
        frame(w, h) {
            ctx.clearRect(0, 0, w, h);
            const ac = api.accent();
            const cx = w / 2, cy = h / 2;
            for (const s of stars) {
                s.tw += 0.02;
                // Drift outward from the centre, wrapping at the edges.
                const dx = s.x - cx, dy = s.y - cy;
                s.x += dx * 0.00035 * s.z;
                s.y += dy * 0.00035 * s.z;
                if (s.x < -10) s.x = w + 10;
                if (s.x > w + 10) s.x = -10;
                if (s.y < -10) s.y = h + 10;
                if (s.y > h + 10) s.y = -10;
                const a = (0.12 + 0.3 * s.z) * (0.7 + 0.3 * Math.sin(s.tw));
                const mdx = api.mx - s.x, mdy = api.my - s.y;
                const near = Math.max(0, 1 - Math.sqrt(mdx * mdx + mdy * mdy) / 180);
                ctx.beginPath();
                ctx.arc(s.x, s.y, s.z * 1.3 + near, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(' + ac + ',' + Math.min(0.8, a + near * 0.3) + ')';
                ctx.fill();
            }
        },
    };
}

function wavesEngine(ctx, api) {
    let t = 0;
    return {
        build() {},
        frame(w, h) {
            t += 0.008;
            ctx.clearRect(0, 0, w, h);
            const ac = api.accent();
            const layers = 5;
            for (let l = 0; l < layers; l++) {
                const yBase = h * (0.25 + l * 0.15);
                const amp = 14 + l * 8;
                const spd = 0.5 + l * 0.18;
                const freq = 0.006 - l * 0.0006;
                const alpha = 0.16 - l * 0.022;
                ctx.beginPath();
                for (let x = 0; x <= w; x += 6) {
                    const y = yBase + Math.sin(x * freq + t * spd) * amp + Math.sin(x * freq * 2.7 + t * spd * 1.4) * amp * 0.4;
                    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                }
                ctx.strokeStyle = 'rgba(' + ac + ',' + alpha + ')';
                ctx.lineWidth = 1.2;
                ctx.stroke();
            }
            const grd = ctx.createLinearGradient(0, 0, 0, h);
            grd.addColorStop(0, 'rgba(' + ac + ',0.03)');
            grd.addColorStop(0.5, 'transparent');
            grd.addColorStop(1, 'rgba(' + ac + ',0.02)');
            ctx.fillStyle = grd;
            ctx.fillRect(0, 0, w, h);
        },
    };
}

const ENGINES = {
    dots: dotsEngine,
    shapes: shapesEngine,
    glitch: glitchEngine,
    liquid: liquidEngine,
    grid: gridEngine,
    constellation: constellationEngine,
    aurora: auroraEngine,
    starfield: starfieldEngine,
    waves: wavesEngine,
};

export default function BackgroundCanvas({ style }) {
    const ref = useRef(null);

    useEffect(() => {
        const canvas = ref.current;
        if (!canvas || !style || style === 'none') return undefined;
        const factory = ENGINES[style];
        if (!factory) return undefined;
        // Decoration only — stay calm under reduced motion.
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
        const ctx = canvas.getContext && canvas.getContext('2d');
        if (!ctx) return undefined; // jsdom / test environments

        const mouse = { x: -9999, y: -9999 };
        const api = {
            get mx() { return mouse.x; },
            get my() { return mouse.y; },
            accent() {
                return getComputedStyle(document.documentElement).getPropertyValue('--accent-rgb').trim() || '88,101,242';
            },
        };
        const engine = factory(ctx, api);

        let w = 0, h = 0, raf = 0;
        function resize() {
            w = window.innerWidth;
            h = window.innerHeight;
            const d = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = w * d;
            canvas.height = h * d;
            canvas.style.width = w + 'px';
            canvas.style.height = h + 'px';
            ctx.setTransform(d, 0, 0, d, 0, 0);
            engine.build(w, h);
        }
        function onMove(e) { mouse.x = e.clientX; mouse.y = e.clientY; }
        function onLeave() { mouse.x = -9999; mouse.y = -9999; }
        function loop() {
            if (w > 0 && h > 0) engine.frame(w, h);
            raf = requestAnimationFrame(loop);
        }

        resize();
        window.addEventListener('resize', resize);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseleave', onLeave);
        loop();

        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('resize', resize);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseleave', onLeave);
            ctx.clearRect(0, 0, w, h);
        };
    }, [style]);

    if (!style || style === 'none') return null;
    return <canvas ref={ref} className="bg-canvas" aria-hidden="true" />;
}

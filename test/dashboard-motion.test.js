'use strict';
// The dashboard motion layer (src/dashboard/parts/11-motion.mjs) is pure browser
// API glue, so its value is entirely in how it DEGRADES. These tests pin the
// three theme-sweep paths:
//   1. startViewTransition available -> native snapshot wipe, injected ::view-
//      transition CSS anchored at the point that was clicked,
//   2. startViewTransition missing (Firefox <144, Zen, older Safari) -> the CSS
//      curtain fallback that shrinks the old background into the click point,
//   3. prefers-reduced-motion -> an instant flip with no animation objects.
// They also cover the regression that made the login page sweep from the screen
// centre: click tracking must be armed by importing the module, not only by
// installInputUpgrades() (which the login page never calls).
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { JSDOM } = require('jsdom');

const MOTION = path.join(__dirname, '..', 'src', 'dashboard', 'parts', '11-motion.mjs');
const HTML = '<!doctype html><html><body><input id="field"></body></html>';

const GLOBALS = [
    'window', 'document', 'navigator', 'location', 'history', 'screen',
    'localStorage', 'sessionStorage', 'getComputedStyle', 'matchMedia',
    'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver',
    'Element', 'HTMLElement', 'HTMLInputElement', 'Node', 'CustomEvent',
    'MouseEvent', 'Event', 'innerWidth', 'innerHeight',
];

let importSeq = 0;

// Fresh jsdom + freshly evaluated module per case (the module snapshots the
// feature probes at import time, so the probes have to exist first).
async function loadMotion({ viewTransitions = false, reducedMotion = false } = {}) {
    const dom = new JSDOM(HTML, { pretendToBeVisual: true, url: 'http://localhost/login' });
    const { window } = dom;
    window.matchMedia = () => ({
        matches: reducedMotion, media: '',
        addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    });
    if (viewTransitions) {
        window.document.startViewTransition = (cb) => {
            window.__vtCalls = (window.__vtCalls || 0) + 1;
            cb();
            return { finished: Promise.resolve(), ready: Promise.resolve(), skipTransition() {} };
        };
    } else {
        delete window.document.startViewTransition;
    }
    // jsdom has no Web Animations; record what the fallback asks for instead.
    window.__anims = [];
    window.Element.prototype.animate = function (keyframes, options) {
        const rec = { keyframes, options, el: this, onfinish: null, oncancel: null };
        window.__anims.push(rec);
        return rec;
    };

    for (const k of GLOBALS) {
        if (window[k] === undefined) continue;
        try {
            Object.defineProperty(globalThis, k, { value: window[k], writable: true, configurable: true });
        } catch { /* non-configurable Node global — module probes defensively */ }
    }
    // jsdom's matchMedia is not on window for all versions; make sure the
    // module's probe sees the stub above.
    Object.defineProperty(globalThis, 'matchMedia', { value: window.matchMedia, writable: true, configurable: true });

    const url = pathToFileURL(MOTION).href + '?t=' + (++importSeq);
    const mod = await import(url);
    return { dom, window, mod };
}

// A click sets the sweep origin; MouseEvent carries clientX/Y through jsdom.
function clickAt(window, x, y) {
    window.document.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: x, clientY: y, bubbles: true }));
}

test('native view transition path: sweeps from the last click, even without installInputUpgrades', async (t) => {
    const { dom, window, mod } = await loadMotion({ viewTransitions: true });
    t.after(() => dom.window.close());

    assert.strictEqual(window.__vigilMotion.viewTransitions, true, 'module should report the native path');

    let flipped = 0;
    clickAt(window, 120, 90);
    mod.themeSweep(() => { flipped += 1; });

    assert.strictEqual(flipped, 1, 'apply() must run exactly once');
    assert.strictEqual(window.__vtCalls, 1, 'startViewTransition must be used');
    const css = window.document.getElementById('tk-theme-sweep');
    assert.ok(css, 'sweep CSS must be injected');
    // The regression this guards: the origin used to fall back to the centre.
    assert.match(css.textContent, /circle\(0% at 120px 90px\)/, 'sweep must start at the click point');
    assert.doesNotMatch(css.textContent, /at 50%/, 'must not fall back to the screen centre');
});

test('curtain fallback path: covers, flips, and shrinks into the click point', async (t) => {
    const { dom, window, mod } = await loadMotion({ viewTransitions: false });
    t.after(() => dom.window.close());

    assert.strictEqual(window.__vigilMotion.viewTransitions, false, 'module should report the fallback path');

    let flipped = 0;
    clickAt(window, 200, 40);
    mod.themeSweep(() => { flipped += 1; });

    assert.strictEqual(flipped, 1, 'apply() must still run exactly once');
    assert.strictEqual(window.__anims.length, 1, 'exactly one curtain animation');
    const [rec] = window.__anims;
    assert.match(String(rec.keyframes[1].clipPath), /^circle\(0px at 200px 40px\)$/, 'curtain must shrink into the click point');
    assert.match(String(rec.keyframes[0].clipPath), /^circle\(\d+(\.\d+)?px at 200px 40px\)$/, 'curtain must start covering the viewport');
    assert.strictEqual(rec.options.duration, 550);
    assert.ok(rec.el.isConnected, 'curtain stays in the DOM while animating');

    rec.onfinish();
    assert.ok(!rec.el.isConnected, 'curtain must be removed when the animation finishes');
});

test('reduced motion: instant flip, no animation objects at all', async (t) => {
    const { dom, window, mod } = await loadMotion({ viewTransitions: true, reducedMotion: true });
    t.after(() => dom.window.close());

    assert.strictEqual(window.__vigilMotion.reducedMotion, true, 'module should report reduced motion');

    let flipped = 0;
    clickAt(window, 10, 10);
    mod.themeSweep(() => { flipped += 1; });

    assert.strictEqual(flipped, 1, 'apply() must run exactly once');
    assert.strictEqual(window.__vtCalls || 0, 0, 'no view transition under reduced motion');
    assert.strictEqual(window.__anims.length, 0, 'no curtain animation under reduced motion');
    assert.strictEqual(window.document.getElementById('tk-theme-sweep'), null, 'no sweep CSS injected');
});

test('a throwing apply() still leaves no curtain behind', async (t) => {
    const { dom, window, mod } = await loadMotion({ viewTransitions: false });
    t.after(() => dom.window.close());

    let removed = false;
    clickAt(window, 30, 30);
    assert.throws(() => mod.themeSweep(() => { throw new Error('flip failed'); }), /flip failed/);
    // The animation was scheduled, so the curtain is still connected; driving it
    // to completion must clean it up rather than stranding an overlay.
    const rec = window.__anims[window.__anims.length - 1];
    assert.ok(rec, 'curtain animation must be scheduled even when apply() throws');
    rec.onfinish();
    removed = !rec.el.isConnected;
    assert.ok(removed, 'curtain must not survive a failed flip');
});

test('attachSmoothCaret upgrades a field and is safe to call twice', async (t) => {
    const { dom, window, mod } = await loadMotion({});
    t.after(() => dom.window.close());

    const input = window.document.getElementById('field');
    mod.attachSmoothCaret(input);
    mod.attachSmoothCaret(input);
    assert.strictEqual(input.dataset.tkCaret, '1');
    assert.strictEqual(input.parentElement.className, 'tk-caret-host');
    assert.ok(input.parentElement.querySelector('.tk-caret-bar'), 'caret bar must be inserted');
    assert.strictEqual(window.document.querySelectorAll('.tk-caret-bar').length, 1, 'no duplicate carets');

    mod.upgradeInputs(window.document);
    assert.strictEqual(window.document.querySelectorAll('.tk-caret-bar').length, 1, 'upgradeInputs must skip tracked fields');
});

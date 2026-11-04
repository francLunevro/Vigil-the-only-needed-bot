// The React half of the ticket SLA surface: web/src/screens/Tickets.jsx's
// SlaBadge and SlaOverview, rendered for real.
//
// These are the two presentational pieces the screen exports, and the reason
// they are exported is this file: they take exactly the payload the tickets
// route returns (see test/ticketSla.test.js, which pins that payload on the
// server side), so a renamed field or a dropped prop fails here rather than
// silently rendering "—" in production.
//
// The component is loaded through Vite's SSR module loader — the same JSX
// transform the production build uses — and rendered with react-dom/server, the
// pattern test/dashboard-react-memberfile.test.js established.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

let viteServer = null;
let SlaBadge = null;
let SlaOverview = null;

const MIN = 60000;
const HOUR = 60 * MIN;

before(async () => {
    const { createServer } = await import('vite');
    viteServer = await createServer({
        root: path.join(__dirname, '..'),
        configFile: false,
        logLevel: 'error',
        appType: 'custom',
        server: { middlewareMode: true },
        esbuild: { jsx: 'automatic' },
    });
    const mod = await viteServer.ssrLoadModule('/web/src/screens/Tickets.jsx');
    SlaBadge = mod.SlaBadge;
    SlaOverview = mod.SlaOverview;
});

after(async () => {
    if (viteServer) await viteServer.close();
});

function badge(state) {
    return renderToStaticMarkup(React.createElement(SlaBadge, { state }));
}

function overview(sla) {
    return renderToStaticMarkup(React.createElement(SlaOverview, { sla }));
}

// The shape the tickets route sends (src/dashboard-backend/parts/09-tickets.js):
// the resolved config, the window of statistics exactly as getTicketSlaStats
// returns it, and the open queue. Copied from that function on purpose — if one
// side renames a field, this test is where it shows up.
function payload() {
    return {
        enabled: true,
        config: { enabled: true, firstResponseMinutes: 60, alertAfterMinutes: 120, alertChannelId: null },
        stats: {
            config: { enabled: true, firstResponseMinutes: 60, alertAfterMinutes: 120, alertChannelId: null },
            enabled: true,
            windowDays: 30,
            targetMs: HOUR,
            alertAfterMs: 2 * HOUR,
            generatedAt: Date.now(),
            responded: { count: 7, averageMs: 42 * MIN, medianMs: 30 * MIN, withinTarget: 5, late: 2, slowestMs: 6 * HOUR },
            unanswered: { open: 2, oldestWaitMs: 3 * HOUR, overTarget: 1 },
            breaches: { total: 3, respondedLate: 2, openOverdue: 1 },
            open: { total: 2, waiting: 1, overdue: 1, claimed: 1, averageWaitMs: 90 * MIN, oldestWaitMs: 3 * HOUR },
        },
        waits: [
            { id: 't1', ticketNumber: 12, creatorTag: 'Member#0001', panelTypeName: 'Support', state: 'overdue', waitedMs: 3 * HOUR, responded: false, claimerId: null },
            { id: 't2', ticketNumber: 13, creatorTag: 'Member#0002', panelTypeName: null, state: 'waiting', waitedMs: 25 * MIN, responded: false, claimerId: 'staff-1' },
        ],
    };
}

test('the badge names every SLA state and renders nothing without one', () => {
    assert.match(badge('waiting'), /Waiting/);
    assert.match(badge('overdue'), /Overdue/);
    assert.match(badge('met'), /On time/);
    assert.match(badge('late'), /Late/);
    assert.strictEqual(badge(null), '', 'a ticket with no SLA state adds no badge');
});

test('the overview renders the response times, the breaches and the waiting queue', () => {
    const html = overview(payload());

    // The numbers the staff actually make decisions on.
    assert.match(html, /<span>Target<\/span><strong>1h 0m<\/strong>/);
    assert.match(html, /<span>Answered<\/span><strong>7<\/strong>/);
    assert.match(html, /<span>Average response<\/span><strong>42m<\/strong>/);
    assert.match(html, /<span>Median response<\/span><strong>30m<\/strong>/);
    assert.match(html, /<span>Answered in target<\/span><strong>5<\/strong>/);
    assert.match(html, /<span>Breaches<\/span><strong>3<\/strong>/);
    assert.match(html, /<span>Waiting now<\/span><strong>1<\/strong>/);
    assert.match(html, /<span>Overdue now<\/span><strong>1<\/strong>/);
    assert.match(html, /<span>Oldest open<\/span><strong>3h 0m<\/strong>/);

    // The window and the breach breakdown are stated in words, not implied.
    assert.match(html, /Last 30 days/);
    assert.match(html, /alert after 2h 0m/);
    assert.match(html, /2 answered late, 1 still unanswered past the target/);

    // One row per waiting ticket, with its own wait and state.
    assert.match(html, /#12 Member#0001/);
    assert.match(html, /waiting 3h 0m/);
    assert.match(html, /#13 Member#0002/);
    assert.match(html, /waiting 25m · claimed/);
    assert.strictEqual((html.match(/Overdue/g) || []).length, 2, 'the overdue ticket is badged');
    assert.ok(html.includes('Waiting'), 'and the fresh one is badged waiting');
});

test('the overview distinguishes "off", "no data" and "nothing waiting"', () => {
    const off = overview({ enabled: false, stats: {}, waits: [] });
    assert.match(off, /Response-time tracking is off for this server/);
    assert.doesNotMatch(off, /Average response/, 'an off feature renders no statistics');

    const missing = overview(undefined);
    assert.match(missing, /did not return SLA data/);

    const none = payload();
    none.stats.open = { total: 0, waiting: 0, overdue: 0, claimed: 0, averageWaitMs: null, oldestWaitMs: null };
    none.stats.breaches = { total: 0, respondedLate: 0, openOverdue: 0 };
    none.stats.unanswered = { open: 0, oldestWaitMs: null, overTarget: 0 };
    none.stats.responded = { count: 0, averageMs: null, medianMs: null, withinTarget: 0, late: 0, slowestMs: null };
    none.waits = [];
    const idle = overview(none);
    assert.match(idle, /No ticket is waiting for a first response right now/);
    assert.match(idle, /<span>Oldest open<\/span><strong>—<\/strong>/, 'no wait is a dash, not NaN');
    assert.match(idle, /<span>Target<\/span><strong>1h 0m<\/strong>/);
});

test('no target configured still shows measured times', () => {
    const noTarget = payload();
    noTarget.stats.targetMs = null;
    noTarget.config.firstResponseMinutes = null;
    const html = overview(noTarget);
    assert.match(html, /<span>Target<\/span><strong>no target<\/strong>/);
    assert.match(html, /<span>Average response<\/span><strong>42m<\/strong>/);
});

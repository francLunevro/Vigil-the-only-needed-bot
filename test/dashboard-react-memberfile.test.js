// The React half of the member file: web/src/screens/ServerModTools.jsx's
// MemberFileView, rendered for real.
//
// The dashboard is JSX, so this file compiles the real component through
// Vite's SSR module loader (the same transform the production build uses) and
// renders it with react-dom/server. That keeps the test on the actual screen
// rather than a copy of its markup — a rename or a dropped prop fails here.
//
// It covers the three states the card can be in: a populated file, a member
// with nothing on record, and a payload from a server that did not send
// `memberFile` at all.
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

let viteServer = null;
let MemberFileView = null;

const DAY = 86400000;

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
    const mod = await viteServer.ssrLoadModule('/web/src/screens/ServerModTools.jsx');
    MemberFileView = mod.MemberFileView;
});

after(async () => {
    if (viteServer) await viteServer.close();
});

function render(props) {
    return renderToStaticMarkup(React.createElement(MemberFileView, props));
}

const MEMBER = { tag: 'Target#0001', joinedAt: Date.now() - 5 * DAY, isBot: false };
const INVITES = { total: 2 };

function populatedFile() {
    const now = Date.now();
    return {
        timeline: [
            {
                kind: 'case', at: now - 2 * DAY, id: '#case-3', caseNumber: 3,
                title: 'ban case #3', detail: 'raiding the general channel',
                actor: 'Mod#0001', active: true,
            },
            {
                kind: 'warning', at: now - 3 * DAY, id: 'w1',
                title: 'Warning', detail: 'spamming in #general',
                actor: 'Mod#0002', active: false,
            },
            {
                kind: 'note', at: now - DAY, id: 'n1',
                title: 'Staff note', detail: 'watch this one',
                actor: 'Mod#0001', active: false,
            },
        ],
        summaries: {
            warnings: { total: 4, latestAt: now - 3 * DAY },
            cases: { total: 2, loaded: 1, active: 1, byAction: { ban: 1 } },
            notes: { total: 1, latestAt: now - DAY },
            reports: { total: 1, pending: 1 },
            appeals: { total: 0, pending: 0 },
            tickets: { total: 3, open: 1 },
        },
        activePunishments: [
            { type: 'ban', caseNumber: 3, since: now - 2 * DAY, reason: 'raiding', until: now + DAY },
        ],
        errors: [],
        truncated: false,
    };
}

test('a populated file renders the counts, the open punishment and the timeline', () => {
    const html = render({ member: MEMBER, invites: INVITES, file: populatedFile() });

    // Identity and the per-system totals.
    assert.match(html, /Target#0001/);
    assert.match(html, /2 invite/);
    for (const label of ['Warnings', 'Cases', 'Notes', 'Reports', 'Appeals', 'Tickets']) {
        assert.ok(html.includes(label), label + ' is counted');
    }
    assert.match(html, /<strong>4<\/strong> Warnings/, 'the warning total is the true one');
    assert.match(html, /1 active/, 'open cases are called out');
    assert.match(html, /1 pending/, 'pending reports are called out');
    assert.match(html, /1 open/, 'open tickets are called out');

    // The active punishment, with its case number and expiry.
    assert.match(html, /ban \(case #3\)/);
    assert.match(html, /raiding/);

    // One row per event, each naming its system, its detail, its actor and when.
    assert.match(html, /ban case #3/);
    assert.match(html, /Warning/);
    assert.match(html, /Staff note/);
    assert.match(html, /watch this one/);
    assert.match(html, /Mod#0001/);
    assert.match(html, /3d ago|2d ago|1d ago/, 'a relative timestamp is rendered');

    // And the staff-only promise is stated where staff can read it.
    assert.match(html, /\/memberfile/);
});

test('a member with nothing on record renders the empty state, not a blank card', () => {
    const file = populatedFile();
    file.timeline = [];
    file.activePunishments = [];
    for (const key of Object.keys(file.summaries)) file.summaries[key] = { total: 0 };

    const html = render({ member: MEMBER, invites: INVITES, file });

    assert.match(html, /Nothing on file/);
    assert.match(html, /<strong>0<\/strong> Warnings/);
    assert.ok(!html.includes('ban (case #3)'), 'no punishment is invented');
});

test('a payload without memberFile says so instead of throwing', () => {
    const html = render({ member: MEMBER, invites: INVITES, file: undefined });
    assert.match(html, /Member file unavailable/);
});

test('truncated and failed reads are admitted in the card', () => {
    const file = populatedFile();
    file.truncated = true;
    file.errors = ['reports'];

    const html = render({ member: MEMBER, invites: INVITES, file });

    assert.match(html, /capped per system/);
    assert.match(html, /Could not read: reports/);
});

test('a member who has left the server still shows their stored history', () => {
    const html = render({ member: null, invites: { total: 0 }, file: populatedFile() });
    assert.match(html, /Not in this server/);
    assert.match(html, /ban case #3/);
});

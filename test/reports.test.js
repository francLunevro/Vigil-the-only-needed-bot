// Tests for the member report system: reports module CRUD + dashboard
// review-queue endpoints (/api/server/:id/reports).
const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reports-test-'));
process.env.DATA_DIR = tmp;
process.env.UPLOADS_DIR = path.join(tmp, 'uploads');

const { createDashboard, setDashboardClient } = require('../src/dashboard');
const { closeDb, getDb } = require('../src/db');
const reports = require('../src/reports');

setDashboardClient({
    guilds: { cache: new Map([['g1', { id: 'g1' }], ['g3', { id: 'g3' }]]) },
}, 'test-password');

const app = createDashboard();
const server = http.createServer(app);

function request(method, p, { body, headers } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port: PORT, path: p, method,
            headers: {
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                ...headers,
            },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function login() {
    const res = await request('POST', '/api/login', { body: { password: 'test-password' } });
    assert.strictEqual(res.status, 200, 'login should succeed');
    return (res.headers['set-cookie'] || [''])[0].split(';')[0];
}

let PORT;
let cookie;

after(async () => {
    closeDb();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('setup: server listening + login', async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    PORT = server.address().port;
    cookie = await login();
});

// ─── Module unit tests ───

test('reports: createReport stores fields and returns a pending report', () => {
    const rep = reports.createReport('g1', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'spamming links', 'check this out https://evil.example', 'msg1');
    assert.ok(rep.id);
    assert.strictEqual(rep.status, 'pending');
    assert.strictEqual(rep.guild_id, 'g1');
    assert.strictEqual(rep.reporter_id, 'u1');
    assert.strictEqual(rep.target_tag, 'Bob#5678');
    assert.strictEqual(rep.message_content, 'check this out https://evil.example');
    assert.strictEqual(rep.message_id, 'msg1');
    assert.ok(rep.created_at);
});

test('reports: getReports filters by status and orders newest first', () => {
    reports.createReport('g1', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'first');
    const older = reports.createReport('g1', 'u1', 'Alice#1234', 'u3', 'Carol#0001', 'second');
    reports.updateReportStatus(older.guild_id, older.id, 'approved', 'Mod#1');
    const pending = reports.getReports('g1', 'pending');
    assert.strictEqual(pending.length, 2);
    const approved = reports.getReports('g1', 'approved');
    assert.strictEqual(approved.length, 1);
    assert.strictEqual(approved[0].id, older.id);
    // Newest first: the third report (created last) is first
    const all = reports.getReports('g1');
    assert.ok(all[0].created_at >= all[1].created_at);
});

test('reports: updateReportStatus rejects invalid statuses', () => {
    const rep = reports.createReport('g1', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'x');
    assert.throws(() => reports.updateReportStatus(rep.guild_id, rep.id, 'nonsense'), /Invalid status/);
});

test('reports: updateReportStatus records reviewer, note, and case id', () => {
    const rep = reports.createReport('g1', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'x');
    getDb().prepare("INSERT INTO mod_cases (id, guild_id, case_number, user_id, moderator_id, moderator_tag, action_type, created_at) VALUES (?, ?, 1, 'target', 'mod', 'Moderator', 'warn', ?)").run('case-42', rep.guild_id, Date.now());
    const ok = reports.updateReportStatus(rep.guild_id, rep.id, 'approved', 'Mod#1', 'looks bad', 'case-42');
    assert.strictEqual(ok, true);
    const updated = reports.getReport(rep.guild_id, rep.id);
    assert.strictEqual(updated.status, 'approved');
    assert.strictEqual(updated.reviewed_by, 'Mod#1');
    assert.strictEqual(updated.review_note, 'looks bad');
    assert.strictEqual(updated.case_id, 'case-42');
    assert.ok(updated.reviewed_at);
});

test('reports: deleteReport removes and reports false for unknown ids', () => {
    const rep = reports.createReport('g1', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'x');
    assert.strictEqual(reports.deleteReport(rep.guild_id, rep.id), true);
    assert.strictEqual(reports.getReport(rep.guild_id, rep.id), undefined);
    assert.strictEqual(reports.deleteReport('g1', 'does-not-exist'), false);
});

test('reports: getReportCount respects status filter', () => {
    reports.createReport('g2', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'x');
    reports.createReport('g2', 'u1', 'Alice#1234', 'u3', 'Carol#0001', 'y');
    const dismissed = reports.createReport('g2', 'u1', 'Alice#1234', 'u4', 'Dave#9999', 'z');
    reports.updateReportStatus(dismissed.guild_id, dismissed.id, 'dismissed', 'Mod#1');
    assert.strictEqual(reports.getReportCount('g2'), 3);
    assert.strictEqual(reports.getReportCount('g2', 'pending'), 2);
    assert.strictEqual(reports.getReportCount('g2', 'dismissed'), 1);
    assert.strictEqual(reports.getReportCount('g2', 'approved'), 0);
    assert.strictEqual(reports.getReportCount('nowhere'), 0);
});

// ─── Dashboard endpoints ───

test('reports API: rejects unauthenticated requests', async () => {
    // Fail-closed tenant guard rejects before auth, so this is 403 not 401.
    const res = await request('GET', '/api/server/g1/reports');
    assert.strictEqual(res.status, 403);
});

test('reports API: GET returns reports and stats', async () => {
    const rep = reports.createReport('g3', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'bad words', 'hello world', 'm1');
    const list = await request('GET', '/api/server/g3/reports', { headers: { Cookie: cookie } });
    assert.strictEqual(list.status, 200);
    const body = JSON.parse(list.body);
    assert.ok(Array.isArray(body.reports));
    assert.ok(body.reports.some(r => r.id === rep.id));

    const stats = await request('GET', '/api/server/g3/reports/stats', { headers: { Cookie: cookie } });
    const s = JSON.parse(stats.body);
    assert.strictEqual(s.pending, 1);
    assert.strictEqual(s.total, 1);
});

test('reports API: PUT approves a report with review note', async () => {
    const rep = reports.createReport('g3', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'bad words');
    const res = await request('PUT', '/api/server/g3/reports/' + rep.id, {
        body: { status: 'approved', reviewedBy: 'Mod#1', reviewNote: 'action taken' },
        headers: { Cookie: cookie },
    });
    assert.strictEqual(res.status, 200);
    const updated = reports.getReport(rep.guild_id, rep.id);
    assert.strictEqual(updated.status, 'approved');
    assert.strictEqual(updated.reviewed_by, process.env.OWNER_ID || 'dashboard');
    assert.strictEqual(updated.review_note, 'action taken');
});

test('reports API: PUT rejects invalid status', async () => {
    const rep = reports.createReport('g3', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'bad words');
    const res = await request('PUT', '/api/server/g3/reports/' + rep.id, {
        body: { status: 'exploded' },
        headers: { Cookie: cookie },
    });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(JSON.parse(res.body), { error: 'Invalid status' });
    assert.strictEqual(reports.getReport(rep.guild_id, rep.id).status, 'pending');
});

test('reports API: DELETE removes a report', async () => {
    const rep = reports.createReport('g3', 'u1', 'Alice#1234', 'u2', 'Bob#5678', 'bad words');
    const res = await request('DELETE', '/api/server/g3/reports/' + rep.id, { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(reports.getReport(rep.guild_id, rep.id), undefined);
});

test('reports API: unknown report returns 404', async () => {
    const res = await request('DELETE', '/api/server/g3/reports/nope', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 404);
});

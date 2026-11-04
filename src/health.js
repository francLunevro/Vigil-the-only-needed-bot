// ──────────────────── Health probe ────────────────────
// /health is what hosts and uptime monitors call, so it must check the two
// things it claims rather than reporting a hard-coded "ok": the database (a
// real query) and the Discord client (isReady()). It used to answer
// `db: 'ok'` without touching the database at all.
//
// The status codes are deliberately asymmetric:
//   · database unreadable → 503, because nothing can be served without it
//   · bot not ready       → 200 with status 'degraded', because a Discord
//     outage or reconnect is transient and restarting the process for it
//     would drop sessions, timers and in-flight dashboard requests
// A probe that fails on every Discord blip is worse than no probe.
const { getDb } = require('./db');

function databaseAnswerable(db) {
    try {
        (db || getDb()).prepare('SELECT 1 AS ok').get();
        return true;
    } catch {
        return false;
    }
}

function buildHealth({ db, client, uptimeSeconds = process.uptime(), now = Date.now() } = {}) {
    const dbOk = databaseAnswerable(db);
    const botReady = !!(client && typeof client.isReady === 'function' && client.isReady());
    const status = dbOk ? (botReady ? 'ok' : 'degraded') : 'error';

    return {
        ok: dbOk,
        httpStatus: dbOk ? 200 : 503,
        body: {
            status,
            botReady,
            uptime: Math.round(uptimeSeconds),
            db: dbOk ? 'ok' : 'error',
            timestamp: now,
        },
    };
}

module.exports = { buildHealth };

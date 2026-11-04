// ──────────────────── Graceful shutdown ────────────────────
// The signal handler used to stop timers, close SQLite and call process.exit(0)
// in one synchronous tick. A dashboard request mid-write, a ticket close's
// transcript snapshot or a webhook send in flight was simply killed with the
// process — and a second signal ran the whole thing again.
//
// This sequence stops new work first, waits (bounded) for in-flight requests,
// destroys the Discord client, and only then closes the database:

const DEFAULT_TIMEOUT_MS = 10000;

function createShutdown({
    server,
    client,
    closeDb,
    stopTimers = [],
    log = () => {},
    exit = (code) => process.exit(code),
    timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
    let running = null;

    function closeServer() {
        if (!server || typeof server.close !== 'function') return Promise.resolve();
        return new Promise((resolve) => {
            let settled = false;
            const finish = () => {
                if (settled) return;
                settled = true;
                resolve();
            };
            const timer = setTimeout(() => {
                // A request that never finishes must not hold the process open
                // forever: drop the remaining sockets and carry on.
                try { server.closeAllConnections?.(); } catch { /* best effort */ }
                finish();
            }, timeoutMs);
            if (typeof timer.unref === 'function') timer.unref();
            try {
                server.close(finish);
                // Idle keep-alive sockets have no work in flight; without this
                // close() waits for their keep-alive timeout instead of the
                // requests that actually matter.
                server.closeIdleConnections?.();
            } catch {
                finish();
            }
        });
    }

    async function run(signal) {
        log('[Bot] Received ' + signal + '. Shutting down gracefully...');
        for (const stop of stopTimers) {
            try { stop(); } catch { /* one broken timer must not block the exit */ }
        }
        await closeServer();
        try {
            if (client && typeof client.destroy === 'function') await client.destroy();
        } catch { /* the gateway may already be gone */ }
        try { closeDb(); } catch { /* already closed */ }
        log('[Bot] Goodbye!');
        return 0;
    }

    // One shutdown per process: a second signal — or /shutdown racing SIGTERM —
    // joins the first instead of closing the database twice.
    return function shutdown(signal = 'SIGTERM') {
        if (!running) {
            running = run(signal)
                .then((code) => {
                    exit(code);
                    return code;
                })
                .catch((err) => {
                    try { log('[Bot] Shutdown failed: ' + (err && err.message ? err.message : err)); } catch { /* logging is optional */ }
                    exit(1);
                    return 1;
                });
        }
        return running;
    };
}

// The Discord /shutdown command needs the same sequence, so index.js exposes
// its handler here. Without one (unit tests, a partial embed) the command does
// nothing rather than killing its host.
function requestShutdown(signal = 'command') {
    if (typeof global.gracefulShutdown === 'function') return global.gracefulShutdown(signal);
    return null;
}

module.exports = { createShutdown, requestShutdown, DEFAULT_TIMEOUT_MS };

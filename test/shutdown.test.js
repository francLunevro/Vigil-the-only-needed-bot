// The signal handler used to stop timers, close SQLite and call process.exit(0)
// synchronously — a dashboard request mid-write or a ticket close's transcript
// snapshot died with the process, and a second signal re-ran the whole thing.
//
// src/shutdown.js is the sequence both SIGTERM and /shutdown now use: stop the
// sweeps, stop accepting connections, wait (bounded) for in-flight requests,
// destroy the gateway, then close the database and exit once.
const { test } = require('node:test');
const assert = require('node:assert');

const { createShutdown, requestShutdown } = require('../src/shutdown');

function makeServer({ hold = false } = {}) {
    const calls = [];
    const server = {
        calls,
        release: null,
        close(cb) {
            calls.push('close');
            if (hold) server.release = cb;
            else cb();
        },
        closeIdleConnections() { calls.push('idle'); },
        closeAllConnections() { calls.push('force'); },
    };
    return server;
}

function makeHarness({ hold = false, timeoutMs = 1000, destroy } = {}) {
    const order = [];
    const server = makeServer({ hold });
    const exits = [];
    const shutdown = createShutdown({
        server,
        client: {
            destroy: async () => {
                order.push('client.destroy');
                if (destroy) await destroy();
            },
        },
        closeDb: () => { order.push('closeDb'); },
        stopTimers: [
            () => order.push('timer1'),
            () => order.push('timer2'),
        ],
        log: () => {},
        exit: (code) => { exits.push(code); order.push('exit'); },
        timeoutMs,
    });
    return { shutdown, server, exits, order };
}

test('a signal stops timers, drains the server, then closes the database', async () => {
    const h = makeHarness();
    const code = await h.shutdown('SIGTERM');

    assert.strictEqual(code, 0);
    assert.deepStrictEqual(h.order, ['timer1', 'timer2', 'client.destroy', 'closeDb', 'exit']);
    assert.ok(h.server.calls.includes('close'));
    assert.ok(h.server.calls.includes('idle'), 'idle keep-alive sockets are dropped so close() can finish');
    assert.deepStrictEqual(h.exits, [0]);
});

test('in-flight requests finish before the database is closed', async () => {
    const h = makeHarness({ hold: true });
    let finished = false;
    const running = h.shutdown('SIGTERM').then(() => { finished = true; });

    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(finished, false, 'shutdown waits for the outstanding request');
    assert.deepStrictEqual(h.order, ['timer1', 'timer2'], 'nothing after the server close runs yet');
    assert.ok(h.server.release, 'server.close() was called');

    h.server.release();
    await running;
    assert.deepStrictEqual(h.order, ['timer1', 'timer2', 'client.destroy', 'closeDb', 'exit']);
});

test('a request that never finishes is force-closed at the timeout', async () => {
    const h = makeHarness({ hold: true, timeoutMs: 20 });
    const code = await h.shutdown('SIGTERM');

    assert.strictEqual(code, 0);
    assert.ok(h.server.calls.includes('force'), 'remaining sockets are dropped after the grace period');
    assert.deepStrictEqual(h.order, ['timer1', 'timer2', 'client.destroy', 'closeDb', 'exit']);
});

test('a second signal joins the first instead of shutting down twice', async () => {
    const h = makeHarness();
    const first = h.shutdown('SIGTERM');
    const second = h.shutdown('SIGINT');
    assert.strictEqual(first, second, 'both signals share one shutdown promise');
    await Promise.all([first, second]);

    assert.deepStrictEqual(h.order, ['timer1', 'timer2', 'client.destroy', 'closeDb', 'exit'],
        'timers, client and database are touched exactly once');
    assert.deepStrictEqual(h.exits, [0]);
});

test('a failing gateway destroy still closes the database and exits', async () => {
    const h = makeHarness({ destroy: async () => { throw new Error('gateway already gone'); } });
    const code = await h.shutdown('SIGTERM');
    assert.strictEqual(code, 0);
    assert.deepStrictEqual(h.order, ['timer1', 'timer2', 'client.destroy', 'closeDb', 'exit']);
});

test('a throwing timer stop does not block the rest of the sequence', async () => {
    const order = [];
    const shutdown = createShutdown({
        server: makeServer(),
        client: null,
        closeDb: () => order.push('closeDb'),
        stopTimers: [() => { throw new Error('bad timer'); }, () => order.push('timer2')],
        log: () => {},
        exit: () => order.push('exit'),
    });
    await shutdown('SIGINT');
    assert.deepStrictEqual(order, ['timer2', 'closeDb', 'exit']);
});

test('/shutdown has no handler to call in a bare process', () => {
    const previous = global.gracefulShutdown;
    delete global.gracefulShutdown;
    try {
        assert.strictEqual(requestShutdown('shutdown command'), null);
        let signal = null;
        global.gracefulShutdown = (s) => { signal = s; return Promise.resolve(0); };
        requestShutdown('shutdown command');
        assert.strictEqual(signal, 'shutdown command', '/shutdown uses the registered graceful path');
    } finally {
        if (previous === undefined) delete global.gracefulShutdown;
        else global.gracefulShutdown = previous;
    }
});

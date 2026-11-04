const { createHash } = require('node:crypto');

const MAX_ATTEMPTS = 3;
const STALE_DISPATCH_MS = 5 * 60 * 1000;

function deliveryNonce(kind, id, dueAt) {
    return createHash('sha256').update(JSON.stringify([kind, id, dueAt])).digest('hex').slice(0, 25);
}

// A timeout, connection failure or server error can hide an accepted write.
function wasRejected(error) {
    return [400, 401, 403, 404, 429].includes(error?.status);
}

function retryAt(attempts, now = Date.now()) {
    return now + 30000 * 2 ** (attempts - 1);
}

module.exports = { MAX_ATTEMPTS, STALE_DISPATCH_MS, deliveryNonce, wasRejected, retryAt };

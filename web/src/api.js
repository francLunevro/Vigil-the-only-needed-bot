// Thin JSON client for the bot's dashboard API.
//
// The React app is served by the same process that owns the API, so every call
// is same-origin and the existing session cookie authenticates it. No token
// juggling, no CORS, no separate auth model — the vanilla frontend's contract
// is preserved exactly.

export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

async function request(method, path, body) {
    const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    // The session expired or was revoked. Authentication is still owned by the
    // existing /login page, so hand the browser back to it.
    if (res.status === 401) {
        window.location.href = '/login';
        throw new ApiError('Not authenticated', 401);
    }

    const text = await res.text();
    let data = null;
    if (text) {
        try { data = JSON.parse(text); } catch { data = null; }
    }

    if (!res.ok) {
        throw new ApiError((data && data.error) || res.statusText || 'Request failed', res.status);
    }
    return data;
}

export const api = {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body === undefined ? {} : body),
    put: (path, body) => request('PUT', path, body === undefined ? {} : body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path, body) => request('DELETE', path, body),
};

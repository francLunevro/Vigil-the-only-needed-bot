// Vite config for the React dashboard.
//
// Build output is plain static assets (no SSR, no server), which the bot's own
// Express process serves — so production stays a single Node process, exactly
// like the vanilla frontend it replaces. In dev, `npm run dev:web` serves HMR
// and proxies /api to the running bot on PORT (default 3000).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    root: here,
    // The React app owns the site root: it is served at / and /login by the
    // bot's Express process. (It lived under /app/ while it was being ported,
    // and that path now redirects to / — see src/dashboard-backend/parts/11-ops.js.)
    base: '/',
    plugins: [react()],
    build: {
        outDir: resolve(here, 'dist'),
        emptyOutDir: true,
        // The CSP forbids inline scripts, so keep assets as real files and
        // avoid Vite's dev-oriented inlining heuristics.
        assetsInlineLimit: 0,
        sourcemap: true,
    },
    server: {
        port: 5173,
        proxy: {
            '/api': 'http://localhost:' + (process.env.PORT || 3000),
        },
    },
});

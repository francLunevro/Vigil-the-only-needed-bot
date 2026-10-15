# Native dashboard — pre-React-default backup

A byte-for-byte snapshot of the **original (vanilla) dashboard** taken
immediately before the React dashboard became the default UI on `/`.

| | |
|---|---|
| Taken from | `main` @ `48b60e0` (working tree with the migration applied only to the backup) |
| Contents | `src/dashboard/` — the whole vanilla frontend (HTML, CSS, `login.mjs`, the 13 `parts/*.mjs` modules) |
| | `src/dashboard.js` — the module entry the vanilla UI is mounted through (its `require('./dashboard-backend')` resolves once the file is back in `src/`, not inside this snapshot) |
| | `serving/11-ops.js.pre-react-default` — snapshot of the Express part that decides which UI owns `/`, taken before the flip |
| Files | 19 |
| Bytes | 660498 |
| Manifest | `MANIFEST.sha256` (SHA-256 of each file, paths relative to this directory) |

## Verify it

From inside this directory:

```bash
sha256sum -c MANIFEST.sha256
```

Every line should print `OK` and the command should exit `0`. The hashes were
computed from the original files, so a passing check proves the copies are
byte-identical to what was serving `/` before the migration.

## Restore it

The vanilla frontend is **not deleted** by the migration — it still lives at
`src/dashboard/` and still ships in the repo. There are two levels of recovery,
cheapest first.

**1. Go back to the original UI without touching code (30 seconds).**

```bash
DASHBOARD_UI=legacy npm start
```

On Railway / Docker / Discloud, set the environment variable `DASHBOARD_UI` to
`legacy` and redeploy. That serves the vanilla dashboard at `/` and `/login`
exactly as before, and unsetting it puts the React UI back. No build step, no
revert, no data change.

**2. Restore the files themselves** (only needed if a future change deletes or
edits `src/dashboard/`).

```bash
# from the repo root
cp -R backups/native-dashboard-pre-react/src/. src/
# optionally, re-apply the pre-migration routing decision as well:
diff -u backups/native-dashboard-pre-react/serving/11-ops.js.pre-react-default \
        src/dashboard-backend/parts/11-ops.js
```

Restoring only the frontend files is safe: the vanilla UI is self-contained
(`index.html` loads `/static/parts/00-entry.mjs`) and its API contract has not
changed — the React app talks to the identical JSON API.

## Notes

- No secrets, tokens, databases or uploaded files are included. Everything here
  is frontend source that shipped in the public repo.
- This directory is committed on purpose, so it survives a fresh clone.

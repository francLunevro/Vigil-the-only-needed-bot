# Changelog

Notable changes per release. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`/ban` confirmation was broken whenever "delete messages" was chosen.**
  The custom-ID parser folded the trailing `clear` flag into the target user
  ID (`<id>_clear`), so the ban lookup failed after the confirmation embed.
- **Poll vote updates corrupted the embed.** `spliceFields` was called with an
  array instead of spread arguments, so every vote rewrote the field objects.
- **The dashboard's embed-colour setting did nothing.** The server route wrote
  `cfg.embed_color` while the config layer persists `embedColor`, so the value
  was dropped silently; the server-detail response also never returned the
  colour. Colours are now normalised in one place on the way in and out.
- **`moderation` and `applications` logging could not be configured from
  Discord.** `/log channel` and `/log toggle` hardcoded 16 of the 18 categories
  in two places; both choice lists are now generated from `LOG_CATEGORIES`, and
  a test fails if they ever diverge again.
- **The dashboard's Rate Limits panel was decorative.** The values it saved
  were never read by any limiter, and the "Mod Actions" bucket was not enforced
  at all. All four buckets (global, login, api, mod actions) now read the saved
  config, destructive mod routes get their own tighter bucket, and saving takes
  effect immediately instead of after a cache window.
- **Retention deleted the newest rows under ties.** `message_log`, `error_logs`
  and `bot_activity` pruned with `ORDER BY <timestamp> DESC` and no tiebreaker,
  so a burst of events sharing one millisecond dropped the wrong end of the
  table. All three now order by `..., id DESC`.
- **Timed polls never finalized after a restart.** `/poll` with a duration
  scheduled its own finalize with a `setTimeout`, which dies with the process —
  so a restart between poll creation and the end time left the poll open
  forever: buttons still live, votes still counting, no result ever posted.
  Auto-end is now a sweeper over the `polls` table (every 30s, plus a boot
  sweep for anything that came due while offline), the same restart-safe
  pattern as giveaways. `/poll`'s ~55-line inline finalize was deleted and is
  now the single `endPoll` implementation, so live tallies, dashboards, and
  auto-end can no longer disagree.
- **`/shutdown` was rate-limited despite its zero cooldown.** `0 || DEFAULT`
  turned the explicit "no cooldown" override into the 3-second default.
- **The rate-limit exemption list never matched.** Inside `app.use('/api/', …)`
  Express strips the mount prefix, so comparing `req.path` against
  `/api/login` was dead code; paths are resolved from `originalUrl` now.
- **Adding a dashboard user from the dashboard produced an account nobody could
  log into.** `/api/dash/users/add` discarded the access token it had just
  minted, so the token was shown to no one (and could never be recovered — only
  its hash is stored), while the UI reported "Failed to add user" for a row that
  had in fact been created. The `showAccessToken` modal had been written to
  display exactly this value and was unreachable. The route now returns the
  token and its expiry once, and a test covers add → log in.
- **`src/dashboard/login.mjs` was linted by nothing** — it fell outside both
  ESLint configs. The browser config now covers every dashboard module.

### Changed

- Node 20 is no longer supported (EOL April 2026; the pinned `better-sqlite3`
  no longer publishes a Node 20 prebuild). `engines` is `>=22`, CI runs
  22/24/26, and the Docker image is `node:24-slim`.
- The Docker image installs with `npm ci --omit=dev` (lockfile-exact) instead of
  `npm install`, and now declares a `HEALTHCHECK` against `/health`.
- Request bodies are capped at 1 MB everywhere except the bulk-import route,
  which keeps its own 25 MB parser.
- Message-log retention is throttled to one prune every few minutes per guild
  instead of running a sort + subquery on every deleted/edited message.
- Added a runtime warning when an `updateGuildConfig` updater sets a key the
  persistence layer doesn't know about (the class of bug that made the colour
  setting silent).
- **Dashboard sessions and rate-limit windows moved out of process memory into
  SQLite** (`dashboard_sessions`, `rate_limit_hits`; migrations run on boot). A
  restart no longer logs every admin out, and a client that had just been
  blocked can't win a fresh budget by catching a deploy. The idle TTL, the
  absolute cap, and per-(bucket, IP) windows all behave exactly as before.
  Discord sessions store only the SHA-256 digest of the `dash_` token they were
  created with, so the new table never holds a replayable credential.

### Added

- `SECURITY.md`, `CHANGELOG.md`, and Dependabot configuration.
- Tests for previously untested high-risk modules: the command pipeline
  (dispatch, guard, cooldowns, usage tracking, error mapping), the permission
  model, rate-limit configuration and enforcement, colour parsing, message-log
  retention, and log-category/command parity.
- `npm run test:coverage` (`node --test --experimental-test-coverage`).
- **A per-session view of who is signed in to the dashboard, with one-click
  revoke.** Settings → Dashboard Access now lists every active session (sign-in
  method, user, when it started, when it expires, and which one is the browser
  you're using). The owner sees all of them; a scoped Discord user sees only
  their own and can only end their own. Sessions are named by a one-way id
  derived from the token, so the panel can revoke a session without the browser
  ever holding a credential — ending the session you're calling from is a
  sign-out, and the UI sends you to the login screen.
- **Dashboard access tokens expire and record their last use.** They now carry a
  90-day expiry (`DASHBOARD_TOKEN_DAYS`; `0` opts out), and the moment a token is
  exchanged for a session is stored as `last_used_at`. Expiry drops the sessions
  a token already created rather than just refusing new logins, and both the
  dashboard's Dashboard Access list and `/dashaccess list` show the expiry and
  last-used date — so a token being used that shouldn't be is visible instead of
  silent. Tokens issued before this change keep working until re-issued.

## [1.1.0]

### Added

- Manual-kick logging, the "Was Here" chip, and an Applications log for
  bots/webhooks.
- Dashboard polish: grouped navigation and a reworked overview.

### Fixed

- Locked `multer` to the patched 2.x line (four high-severity DoS advisories)
  and pinned `jsdom` to a version that keeps the Node support floor honest.

## [1.0.0]

### Added

- First tagged release: moderation with case files, 18-category logging,
  auto-mod, warning thresholds, tickets with transcripts, ban appeals,
  reaction roles and role menus, welcome/goodbye, invite tracking, giveaways,
  polls, temp voice, voice presence, staff notes, analytics, and the web
  dashboard.
- SQLite storage with versioned migrations, scheduled backups, and retention.
- Unified command surfaces: slash and prefix run the same handlers through one
  pipeline.

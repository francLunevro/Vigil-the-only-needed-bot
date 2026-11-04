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
- **A join raid could freeze the server-stats counters at a wrong number.**
  Every `GuildMemberAdd`/`Remove` ran a full refresh, and each refresh renamed
  the counter channel, so Discord's channel-rename budget (roughly two per ten
  minutes per channel) was spent within seconds of a raid; every later rename
  was rejected and the counter sat stale until the next ten-minute sweep.
  Refreshes are now debounced per guild (single events still update immediately,
  bursts collapse into one run) and renames are paced per channel with the
  skipped update re-queued for when the budget refills instead of being dropped.
  Discord's rename limit is no longer a silent failure mode.
- **A `/perm`-granted moderator could act on members who outrank them.** Every
  guard in the moderation commands compared the *bot's* highest role against the
  target — `member.kickable`, `member.moderatable`, "higher than my highest
  role" — and never the invoker's, so a grant was effectively a licence to kick,
  ban, time out or rename anyone below the bot, including administrators above
  the moderator. The same gap let a grant hand out roles above its own rank
  (`/role`, `/temprole`, reaction roles and role menus). One shared guard now
  compares the invoker against the target member and against any role being
  managed; the server owner and bot owner are exempt, acting on yourself isn't a
  hierarchy question, and the confirm buttons re-check at execution time in case
  roles changed between the prompt and the click.
- **A command that failed still charged its cooldown.** The pipeline both
  checked *and wrote* the cooldown window before the handler ran, so any thrown
  error — a Discord blip, an unhandled edge case — left the user waiting out a
  window for work that never happened. Checking is read-only now and the window
  is charged once the handler has actually run. A *refused* attempt is still
  charged, so a user without the grant can't spam the refusal reply.
- **`/logs search` could only find one word at a time.** The whole `keyword`
  argument went into a single `LIKE '%…%'` pattern, so `reply ping` matched
  only where those two words sat next to each other in that order — appending a
  second word to a search that worked usually turned it into zero results. `%`
  and `_` typed into the box were live wildcards (`%` alone listed every row),
  and every match was written into one 4096-character embed description, so a
  search that matched 15 rows silently showed fewer while the count still
  claimed 15. Queries are now split into words and `"quoted phrases"` that must
  each match somewhere in the message text, the author's tag or an attachment
  name; terms are escaped and bound as parameters, and paging reports honestly
  (`newest 50 of 312 matches`).

### Changed

- **`/logs search` results are private and paged.** The reply is ephemeral, so
  only the person who ran the search sees which message was deleted by whom,
  and Previous/Next/Close buttons re-render from the rows that search already
  fetched instead of re-running the query. They refuse anyone but that user, and
  the session expires after fifteen minutes with a message that says so
  (the store is capped, so a long-lived process can't accumulate them). The
  options were rebuilt around finding one entry: `query` (every word must
  match, `"quotes"` keep words together), `user`, `channel`, `action`, and
  `limit` — how many matches to page through, default 50, max 200.
  `;logs search @user dying light` takes the same words positionally.
- **Auto-mod and autoresponder configuration is no longer re-read from SQLite
  for every message.** The message path did five or six round trips per message
  (rules, channel settings, role whitelist, three filter lists) plus the
  custom-command and autoresponder lookups, for data that only changes when a
  moderator edits it. Each read is now cached per guild and dropped by every
  write in the module that owns it — `invalidateAutoModCache` /
  `invalidateCustomCommandsCache`, both exported — so a new filter or a deleted
  autoresponder takes effect on the very next message. Use counters are mirrored
  into the cached row instead of dropping the list, since they change per match.
  A 60-second TTL is the backstop for changes made outside the modules (a
  hand-run SQL fix, a restored database file); a test pins that tradeoff.
- **Commands now declare who can see and use them.** Not one of the ~50
  non-public commands set `default_member_permissions`, so `/kick`, `/ban`,
  `/automod`, `/config` and the bot-owner plumbing were listed in every member's
  command picker in every server. They are now split into two tiers — day-to-day
  moderation needs **Moderate Members**, server configuration and bot plumbing
  need **Manage Server** — and every command is registered guild-only (cooldowns
  and config are per-guild, and the pipeline read `interaction.guild.id` before
  anything else, which threw in a DM).

  Read the tradeoff: Discord enforces this field itself, with Administrator
  holders always bypassing it, so a member granted a command with `/perm` now
  also needs the tier's Discord permission to use the **slash** command. The
  prefix surface is unaffected — Discord has no say there, so a `/perm` grant
  still works as before via the prefix. The full classification lives in
  `src/commandPolicy.js`, and a test fails if a command isn't classified.
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
- **Custom commands and autoresponders.** Servers can now write their own
  prefix commands (`/customcommand add name:rules response:"Be nice."` →
  `;rules`) and trigger-based replies (`/autoresponder add`), matched by
  `contains`, `exact`, `starts with` or `regex`, optionally scoped to a single
  channel and pausable. Responses expand the welcome/goodbye placeholder table
  plus `{channel}` and `{args}`, and can be sent as an embed. Delivery is
  deliberately conservative: a built-in command always beats a same-named
  custom one, only the first matching rule answers a message, bots never
  trigger an autoresponder (so a response containing its own trigger can't
  loop), each rule/member pair is throttled, and outgoing payloads allow user
  mentions but never `@everyone`. Both lists are editable from Discord and from
  a new dashboard section (Manage → Custom Commands).
- **A dependency-free motion layer for the dashboard and login page.** Toggling
  the theme now wipes between dark and light out of the button that was pressed
  (View Transitions where the browser has it, a CSS curtain sweep where it
  doesn't — Firefox before 144, Zen and other lagging forks included), text
  fields get a spring-animated caret in place of the native one, the login
  submit morphs into a pill with a loading row, and the login page gained a
  parametric avatar picker whose glow tints the card. Every piece is opt-out
  under `prefers-reduced-motion` and degrades to plain behaviour when an API is
  missing; `window.__vigilMotion` reports which sweep path the browser is on.
- **Members are told why they were punished, and how to appeal.** A warning,
  timeout, kick, temp-ban or ban now sends the member a private receipt with the
  action, the reason, the case number staff will quote back at them, the
  duration and when it lifts, and the server's appeal instructions — from
  `/warn`, `/timeout`, the kick/ban/temp-ban confirm buttons, the automatic
  warning-threshold punishments and the dashboard's moderation routes alike,
  because all of them go through one `sendPunishmentDm()` (`src/modDm.js`).
  Notifying is strictly best-effort: a closed DM, a blocked bot or a Discord
  outage cannot fail the command or roll the punishment back, a refusal is
  logged as a warning ("Cannot send messages to this user" is an expected
  condition, not an incident) and anything else reaches the error log. Receipts
  are on by default and can be switched off per server, with custom appeal
  instructions, from Server Settings in the dashboard (or
  `POST /api/server/:id/settings`); the moderator stays visible to staff in the
  log-channel embed exactly as before.
- **One staff file per member, in Discord and in the dashboard.** `/memberfile`
  and the dashboard's Mod Tools both open a single view of everything on a
  member: warnings, mod cases and the punishments still running, staff notes,
  reports filed against them, ban appeals and ticket history, merged into one
  newest-first timeline with per-system counts. The composing lives in one place
  (`src/memberFile.js`) and reads each system through the accessor that already
  owns its table — the member file contains no SQL of its own, so a member id
  from another server simply matches nothing and no new permission system
  exists: the command uses the same owner/`/perm` gate and `ModerateMembers`
  permission as every other staff command, and the dashboard route keeps the
  same session and per-server tenant guard. The reply is ephemeral on purpose —
  staff notes are private, and posting them into a channel the member can read
  would break that. The dashboard's member profile route keeps sending the
  `member`, `warnings`, `notes`, `cases` and `invites` fields it always did and
  now also sends the composed `memberFile` alongside them.

- **Ticket SLA: how long a member actually waits for a human, and who to
  chase.** Every ticket now records its *first staff response* — the first
  message in the ticket channel that is neither the member who opened it nor a
  bot — exactly once: the write carries `WHERE first_response_at IS NULL`, so two
  staff replying at the same moment still produce one timestamp and nothing later
  can overwrite it. Migration 0043 adds those columns plus `sla_alerted_at` and a
  per-guild `ticket_sla_config`. The thresholds (a first-response target, an
  alert delay, and where alerts go) are per server and editable from the Tickets
  screen in the dashboard or `POST /api/server/:id/tickets/config`, which refuses
  out-of-range values rather than clamping them — a UI bug shows up as an error
  instead of a plausible wrong number. When a ticket passes the alert threshold,
  staff get one embed in the ticket log channel (or the channel you choose), and
  that alert is marked on the row, so it never repeats — including across a
  restart: the sweeper re-reads the `tickets` table on boot and every 60s like
  giveaways and polls, catching tickets that came due while the bot was offline,
  and an alert it could not post is retried instead of being written off. The
  wait and its state (waiting / overdue / on time / late) appear where tickets
  are already read: the ticket channel states the target, the claim and close log
  embeds carry the waited and first-response times, and the dashboard's Tickets
  screen adds a per-ticket badge and a response-time panel with the average,
  median, breach count and the age of the open queue. The ticket API keeps its
  shape — the SLA data arrives as additive fields.

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

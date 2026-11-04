# Dashboard route and object authorization matrix

P1-03 working-tree snapshot. This is an inventory of direct Express method registrations, plus middleware and asset boundaries below. Source anchors are for this snapshot. Rows identify declared guards and the related ownership review. A row or test-family reference does not establish that every branch was independently exercised.

## Authorization model

- **Valid cookie** means the active dashboard session and current Vigil-issued credential are checked. **Owner cookie** means installation password or the configured Discord installation owner. Password sessions are shared installation authority. They are not individual operator identities.
- **Grant** means a stored Vigil guild grant, not a live Discord membership or permission. Installation owners bypass guild grants. The Express guild mount checks the decoded parameter, including mixed-case routes. Discord REST actions can still depend on the bot permission and hierarchy.
- **Read/write** means an explicit `records:read` or `records:write` capability for an account listed in `DASHBOARD_STAFF_CAPABILITIES`. Existing unlisted staff retain their existing rights. The setting is a restriction layered over each named account?s guild grants.
- Body validation, runtime checks, and Discord REST authorization can impose additional restrictions beyond the route column.

## Ownership and test evidence

| Key | Ownership and cross-guild risk | Test evidence |
|---|---|---|
| R | Reports, appeals and notes use guild predicates. Report case links require the same guild. Member profile aggregates by guild and member. Protect record paths independently of raw URL case. | p103-security, dashboard-tenant-scoping, reports, banAppeals, reports-appeals-e2e, memberFile |
| T | Panels use guild plus panel ID. Types require guild plus parent plus type ID. Ticket summaries query guild rows. | dashboard-tenant-scoping, ticket-race-transcript, ticketSla |
| L | Role-menu options require an unambiguous parent in the guild. Mutating a message also checks stored channel and bot authorship. Reaction roles use guild and configured identifiers. | dashboard-tenant-scoping, dashboard-audit-trail, interactions |
| G | Owner global actions resolve the giveaway by ID across the installation by design. Storage transitions bind the loaded guild and expected status. Scoped listing uses grants. | giveaways, dashboard-audit-trail. No dedicated concurrent reroll fixture. |
| V | Bearer tokens are issued by the installation owner. Scope names limit endpoint capability. Current tokens do not have per-guild restrictions. Record queries use requested guild and limits. | publicApi |
| S | Scoped aggregate results and SSE use current guild grants, including event-time revalidation. Guildless events are owner-only. | dashboard-tenant-scoping, activity-feed |
| A | Owner manages users, guild grants, token issuance, assets and bot settings. Session list/revoke additionally enforces session ownership for scoped users. Uploaded images are public branding assets. | dashboard-auth, dashboard-session-hardening, dashboard-token-security, p103-security |
| O | Installation-wide backup/import/export/error/audit routes require owner authority. Verify each handler for any narrower public probe or scoped summary. | dashboard-import, health-check, db, dashboard-audit-trail |
| P | Scoped reminder requests bind the session user instead of accepting another account ID. Owner operations are installation-wide. | dashboard-tenant-scoping, dashboard-audit-trail |
| F | Verify object lookup inside the granted guild, plus owner restrictions for destructive Discord moderation where applicable. Several routes use guild caches or route-side ownership checks. Storage and Discord failure injection is incomplete. | dashboard, dashboard-manage-routes, modHierarchy, dashboard-tenant-scoping |
| X | Inspect handler-specific filtering and authority. Global routes are not covered by the server mount. | Coverage varies. No blanket verification asserted. |

## Route inventory

| Method | Path | Authentication | Guild access | Capability / ownership key | Source |
|---|---|---|---|---|---|
| POST | /api/import/all | Owner cookie | Handler-specific | O / installation operational data | 02-auth.js:107 |
| POST | /api/login | Password or Vigil credential | Handler-specific | A / account, installation or asset | 02-auth.js:113 |
| POST | /api/logout | Public or optional cookie | Handler-specific | A / account, installation or asset | 02-auth.js:156 |
| GET | /api/branding | Owner cookie | Handler-specific | A / account, installation or asset | 02-auth.js:164 |
| GET | /api/dash/users | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:26 |
| POST | /api/dash/users/add | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:30 |
| POST | /api/dash/users/remove | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:46 |
| GET | /api/dash/sessions | Valid cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:66 |
| POST | /api/dash/sessions/revoke | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:89 |
| GET | /api/dash/users/guilds | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:109 |
| POST | /api/dash/users/guilds | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:116 |
| POST | /api/upload | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:141 |
| GET | /api/dash/config | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:173 |
| POST | /api/dash/config | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:176 |
| GET | /api/status | Valid cookie | Grant-filtered where scoped | S / scoped counts, owner host data | 03-dash-admin.js:182 |
| POST | /api/bot/name | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:221 |
| POST | /api/bot/avatar | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:231 |
| POST | /api/bot/presence | Owner cookie | Handler-specific | A / account, installation or asset | 03-dash-admin.js:247 |
| GET | /api/servers | Valid cookie | Grant-filtered where scoped | S / guild list | 04-servers.js:23 |
| POST | /api/server/:id/settings | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:38 |
| GET | /api/server/:id/roles | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:75 |
| GET | /api/server/:id/channels | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:96 |
| GET | /api/server/:id/audit | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:121 |
| POST | /api/server/:id/log/config | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:148 |
| POST | /api/server/:id/log/config/batch | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:177 |
| POST | /api/server/:id/prefix | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:200 |
| GET | /api/server/:id/greetings | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:213 |
| POST | /api/server/:id/greetings/:type | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:224 |
| GET | /api/server/:id/members | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:254 |
| GET | /api/server/:id/webhooks | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:279 |
| POST | /api/server/:id/webhooks | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:304 |
| DELETE | /api/server/:id/webhooks/:webhookId | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:323 |
| GET | /api/server/:id/invites | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:341 |
| GET | /api/server/:id | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:356 |
| GET | /api/server/:id/members/search | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 04-servers.js:406 |
| GET | /api/server/:id/member/:userId/profile | Valid cookie | Grant (owner bypass) | records:read / R | 04-servers.js:432 |
| POST | /api/server/:id/mod/warn | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:22 |
| POST | /api/server/:id/mod/kick | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:53 |
| POST | /api/server/:id/mod/ban | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:83 |
| POST | /api/server/:id/mod/timeout | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:110 |
| GET | /api/server/:id/temp-roles | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:152 |
| POST | /api/server/:id/temp-roles | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:169 |
| DELETE | /api/server/:id/temp-roles | Owner cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:195 |
| GET | /api/server/:id/notes | Valid cookie | Grant (owner bypass) | records:read / R | 05-moderation.js:216 |
| POST | /api/server/:id/notes | Valid cookie | Grant (owner bypass) | records:write / R | 05-moderation.js:236 |
| DELETE | /api/server/:id/notes/:noteId | Valid cookie | Grant (owner bypass) | records:write / R | 05-moderation.js:249 |
| GET | /api/server/:id/warning-thresholds | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:259 |
| POST | /api/server/:id/warning-thresholds | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:270 |
| DELETE | /api/server/:id/warning-thresholds | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:288 |
| GET | /api/server/:id/ban-appeals | Valid cookie | Grant (owner bypass) | records:read / R | 05-moderation.js:305 |
| GET | /api/server/:id/ban-appeals/stats | Valid cookie | Grant (owner bypass) | records:read / R | 05-moderation.js:317 |
| POST | /api/server/:id/ban-appeals | Valid cookie | Grant (owner bypass) | records:write / R | 05-moderation.js:333 |
| PUT | /api/server/:id/ban-appeals/:appealId | Valid cookie | Grant (owner bypass) | records:write / R | 05-moderation.js:349 |
| DELETE | /api/server/:id/ban-appeals/:appealId | Valid cookie | Grant (owner bypass) | records:write / R | 05-moderation.js:371 |
| GET | /api/server/:id/reports | Valid cookie | Grant (owner bypass) | records:read / R | 05-moderation.js:392 |
| GET | /api/server/:id/reports/stats | Valid cookie | Grant (owner bypass) | records:read / R | 05-moderation.js:404 |
| PUT | /api/server/:id/reports/:reportId | Valid cookie | Grant (owner bypass) | records:write / R | 05-moderation.js:420 |
| DELETE | /api/server/:id/reports/:reportId | Valid cookie | Grant (owner bypass) | records:write / R | 05-moderation.js:471 |
| GET | /api/server/:id/modstats | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:492 |
| GET | /api/server/:id/messages | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:526 |
| GET | /api/server/:id/messages/export | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:558 |
| GET | /api/server/:id/raidmode | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:592 |
| POST | /api/server/:id/raidmode | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:605 |
| GET | /api/server/:id/auditlog | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 05-moderation.js:656 |
| GET | /api/server/:id/reaction-roles | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:20 |
| POST | /api/server/:id/reaction-roles | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:39 |
| DELETE | /api/server/:id/reaction-roles | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:59 |
| POST | /api/server/:id/reaction-roles/message | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:76 |
| GET | /api/server/:id/role-menus | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:104 |
| GET | /api/server/:id/role-menus/:messageId/options | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:127 |
| POST | /api/server/:id/role-menus | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:148 |
| POST | /api/server/:id/role-menus/:messageId/options | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:176 |
| DELETE | /api/server/:id/role-menus/:messageId/options | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:200 |
| PUT | /api/server/:id/role-menus/:messageId/publish | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:218 |
| DELETE | /api/server/:id/role-menus/:messageId | Valid cookie | Grant (owner bypass) | L / role menu parent or reaction guild keys | 06-engagement.js:259 |
| GET | /api/reminders | Valid cookie | Handler-specific | P / reminder account owner | 06-engagement.js:293 |
| POST | /api/reminders | Valid cookie | Handler-specific | P / reminder account owner | 06-engagement.js:307 |
| DELETE | /api/reminders/:id | Valid cookie | Handler-specific | P / reminder account owner | 06-engagement.js:333 |
| GET | /api/giveaways | Valid cookie | Handler-specific | G / giveaway record and Discord channel | 06-engagement.js:352 |
| POST | /api/giveaways/create | Owner cookie | Handler-specific | G / giveaway record and Discord channel | 06-engagement.js:374 |
| POST | /api/giveaways/end | Owner cookie | Handler-specific | G / giveaway record and Discord channel | 06-engagement.js:411 |
| POST | /api/giveaways/cancel | Owner cookie | Handler-specific | G / giveaway record and Discord channel | 06-engagement.js:429 |
| POST | /api/giveaways/reroll | Owner cookie | Handler-specific | G / giveaway record and Discord channel | 06-engagement.js:443 |
| POST | /api/polls/create | Owner cookie | Handler-specific | X / see handler and notes below | 06-engagement.js:462 |
| POST | /api/polls/end | Owner cookie | Handler-specific | X / see handler and notes below | 06-engagement.js:533 |
| POST | /api/announcements/create | Owner cookie | Handler-specific | X / see handler and notes below | 06-engagement.js:547 |
| GET | /api/server/:id/custom-commands | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 06-engagement.js:577 |
| POST | /api/server/:id/custom-commands | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 06-engagement.js:590 |
| DELETE | /api/server/:id/custom-commands/:name | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 06-engagement.js:602 |
| GET | /api/server/:id/autoresponders | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 06-engagement.js:614 |
| POST | /api/server/:id/autoresponders | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 06-engagement.js:628 |
| PATCH | /api/server/:id/autoresponders/:rid | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 06-engagement.js:640 |
| DELETE | /api/server/:id/autoresponders/:rid | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 06-engagement.js:651 |
| GET | /api/server/:id/voice-presence | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:19 |
| POST | /api/server/:id/voice-presence/join | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:34 |
| POST | /api/server/:id/voice-presence/move | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:53 |
| POST | /api/server/:id/voice-presence/leave | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:73 |
| POST | /api/server/:id/voice-presence/status | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:87 |
| POST | /api/server/:id/voice-presence/restore | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:102 |
| GET | /api/server/:id/temp-voice | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:117 |
| POST | /api/server/:id/temp-voice/triggers | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:135 |
| DELETE | /api/server/:id/temp-voice/triggers | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:153 |
| POST | /api/server/:id/temp-voice/config | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:169 |
| POST | /api/server/:id/temp-voice/panels | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:185 |
| DELETE | /api/server/:id/temp-voice/panels | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:206 |
| POST | /api/server/:id/temp-voice/panels/refresh | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:222 |
| POST | /api/server/:id/temp-voice/cleanup | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 07-voice.js:236 |
| GET | /api/server/:id/automod | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 08-automod.js:25 |
| POST | /api/server/:id/automod/rules | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 08-automod.js:72 |
| POST | /api/server/:id/automod/filters | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 08-automod.js:88 |
| DELETE | /api/server/:id/automod/filters | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 08-automod.js:112 |
| POST | /api/server/:id/automod/filters/batch | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 08-automod.js:128 |
| POST | /api/server/:id/automod/channels | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 08-automod.js:144 |
| GET | /api/server/:id/automod/export | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 08-automod.js:163 |
| POST | /api/server/:id/automod/import | Valid cookie | Grant (owner bypass) | F / guild settings, moderation, Discord cache or guild data | 08-automod.js:177 |
| GET | /api/server/:id/tickets | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:37 |
| POST | /api/server/:id/tickets/config | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:135 |
| POST | /api/server/:id/tickets/panels | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:170 |
| PUT | /api/server/:id/tickets/panels/:panelId | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:193 |
| DELETE | /api/server/:id/tickets/panels/:panelId | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:214 |
| POST | /api/server/:id/tickets/panels/:panelId/send | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:228 |
| POST | /api/server/:id/tickets/panels/:panelId/types | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:246 |
| PUT | /api/server/:id/tickets/panels/:panelId/types/reorder | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:271 |
| PUT | /api/server/:id/tickets/panels/:panelId/types/:typeId | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:289 |
| DELETE | /api/server/:id/tickets/panels/:panelId/types/:typeId | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:305 |
| POST | /api/server/:id/tickets/panels/:panelId/clone | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:321 |
| PUT | /api/server/:id/tickets/panels/:panelId/count | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:336 |
| PUT | /api/server/:id/tickets/panels/:panelId/config | Valid cookie | Grant (owner bypass) | T / ticket configuration and panel/type ownership | 09-tickets.js:355 |
| GET | /api/activity/timeline | Valid cookie | Grant-filtered where scoped | S / SSE or analytics guild filters | 10-insights.js:17 |
| GET | /api/analytics/servers/compare | Valid cookie | Grant-filtered where scoped | S / SSE or analytics guild filters | 10-insights.js:45 |
| GET | /api/stats/commands/heatmap | Valid cookie | Grant-filtered where scoped | S / SSE or analytics guild filters | 10-insights.js:65 |
| GET | /api/stats/aggregate | Valid cookie | Grant-filtered where scoped | S / SSE or analytics guild filters | 10-insights.js:85 |
| GET | /api/stats/commands | Valid cookie | Grant-filtered where scoped | S / SSE or analytics guild filters | 10-insights.js:118 |
| GET | /api/stats/export | Valid cookie | Grant-filtered where scoped | S / SSE or analytics guild filters | 10-insights.js:159 |
| GET | /api/activity | Valid cookie | Grant-filtered where scoped | S / SSE or analytics guild filters | 10-insights.js:185 |
| GET | /api/system | Owner cookie | Handler-specific | O / installation operational data | 10-insights.js:193 |
| GET | /api/commands | Valid cookie | Handler-specific | X / see handler and notes below | 10-insights.js:310 |
| GET | /api/events | Valid cookie | Grant-filtered where scoped | S / SSE or analytics guild filters | 10-insights.js:324 |
| GET | /api/insights/:id | Valid cookie | Grant-filtered where scoped | S / SSE or analytics guild filters | 10-insights.js:372 |
| GET | /api/tokens | Owner cookie | Handler-specific | A / account, installation or asset | 11-ops.js:25 |
| POST | /api/tokens | Owner cookie | Handler-specific | A / account, installation or asset | 11-ops.js:29 |
| DELETE | /api/tokens/:id | Owner cookie | Handler-specific | A / account, installation or asset | 11-ops.js:39 |
| GET | /api/ratelimit/config | Owner cookie | Handler-specific | X / see handler and notes below | 11-ops.js:50 |
| POST | /api/ratelimit/config | Owner cookie | Handler-specific | X / see handler and notes below | 11-ops.js:54 |
| GET | /api/errors | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:73 |
| DELETE | /api/errors | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:93 |
| GET | /health | Public | No guild access | O / health probe | 11-ops.js:106 |
| GET | /metrics | Public | Installation aggregates | O / restrict exposure at ingress | 11-ops.js:112 |
| GET | /api/backups | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:185 |
| POST | /api/backups | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:189 |
| GET | /api/backups/download/:name | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:195 |
| DELETE | /api/backups/:name | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:203 |
| GET | /api/export/all | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:211 |
| POST | /api/import/all | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:283 |
| GET | /api/audit-trail | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:373 |
| GET | /api/errors/alert | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:395 |
| POST | /api/errors/alert | Owner cookie | Handler-specific | O / installation operational data | 11-ops.js:420 |
| GET | / | Public or optional cookie | Handler-specific | X / see handler and notes below | 11-ops.js:472 |
| GET | /login | Public or optional cookie | Handler-specific | X / see handler and notes below | 11-ops.js:476 |
| GET | /api/v1/me | Bearer, null | Installation token | V / API-token scope and guild predicates | 12-public-api.js:88 |
| GET | /api/v1/servers | Bearer, 'read:servers' | Installation token | V / API-token scope and guild predicates | 12-public-api.js:99 |
| GET | /api/v1/servers/:id | Bearer, 'read:servers' | Installation token | V / API-token scope and guild predicates | 12-public-api.js:108 |
| GET | /api/v1/servers/:id/stats | Bearer, 'read:stats' | Installation token | V / API-token scope and guild predicates | 12-public-api.js:117 |
| GET | /api/v1/servers/:id/logs | Bearer, 'read:logs' | Installation token | V / API-token scope and guild predicates | 12-public-api.js:164 |

Direct registrations inventoried: 164.

## Middleware and deployment boundaries

- The 25 MB import parser is separately registered behind cookie and owner checks. Smaller API bodies are rate limited before parsing.
- Metrics is a public aggregate probe. Restrict it at ingress if installation-level counts and host metrics should remain private.
- React and legacy static assets have separate serving rules. Uploaded branding images are public, filename-restricted, served with nosniff and a sandbox policy. Static assets do not grant API authority.
- SSE uses cookie auth at connect time and revalidates stored session and grant state during delivery. A reverse proxy can still buffer stream output if configured to ignore upstream headers.
- The readiness of an ingress policy depends on its topology. Keep the origin private, normalize forwarded headers at the ingress, and configure only the proxy addresses needed for that installation.

## Operator compatibility

- Set `TRUST_PROXY=0` for direct access. Unset trusts loopback only. For containers or separate proxy hosts, set a comma-separated list of exact proxy IPs or narrowly scoped CIDRs. Trust-all values `1` and `true` fail startup and require migration. The proxy must overwrite forwarding headers.
- To restrict a named staff account without changing its existing guild grants, set `DASHBOARD_STAFF_CAPABILITIES={"123456789012345678":["records:read"]}` and restart. Use both capabilities for read/write access, or an empty list to deny both. This setting currently covers notes, reports, appeals and the member profile only. Unlisted accounts retain existing grant behavior.
- Avatar URLs must be HTTPS Discord CDN avatar or attachment URLs. Uploads support PNG, JPEG, GIF and WebP with a 10 MiB file limit, 16 million decoded pixels across frames and a shared 100 MiB directory quota. Remove unused files offline when the quota is reached. Sharp uses a native binary. Install optional platform packages on supported hosts.
- Restoring a snapshot also restores historical credential, session and grant state. Treat snapshots as sensitive and plan revocation and rotation before opening a restored instance to traffic.

## Offline restore drill

1. Work in an isolated data directory with the bot disconnected. Preserve a copy of the current data directory for rollback.
2. Copy a candidate snapshot to staging. Open it read-only with SQLite, run quick_check and verify critical tables and representative guild rows. Reject corrupt or incompatible candidates before replacing anything.
3. With the database stopped, install the verified candidate as bot.db in an empty data directory. Do not mix it with WAL or SHM files from the previous database. Verify application data and migrations against fixtures.
4. If checks fail, keep the service offline and restore the saved directory. Review credential state before reopening network access.

The test uses temporary files and a standalone database. Host shutdown, native package deployment on other operating systems, and off-host storage are separate operational checks.

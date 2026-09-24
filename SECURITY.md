# Security Policy

## Supported versions

Only the latest release on `main` is supported. Fixes land on `main` and are
tagged; older tags do not receive backports.

| Version | Supported |
|---|---|
| Latest `main` / newest tag | ✅ |
| Older tags | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's
[Security Advisories](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" on the Security tab), or by DM to the maintainer on
Discord if you already have a channel open.

Please include:

- What you did, what happened, and what you expected
- Affected version/commit and how you deployed it (Railway / Docker / VPS)
- Whether the bot owner's Dashboard credentials or `BOT_TOKEN` are required
- A proof of concept if you have one

**Never include live tokens, your `DATA_DIR` database, or other people's
personal data in a report.** Redact first.

Expect an acknowledgement within a few days. This is a self-hosted hobby
project maintained by one person, so please be patient — but security reports
are treated as the top priority.

## Threat model — what this project does and does not defend

Vigil is a single-tenant, self-hosted bot: the operator is trusted, and the
dashboard is expected to be internet-reachable (usually behind a TLS proxy).

**In scope**

- The dashboard HTTP surface (`src/dashboard-backend/`): authentication,
  session handling, tenant scoping, rate limiting, uploads, bulk import/export
- Command handling for both surfaces (slash + prefix), including the permission
  model in `src/permissions.js` and the shared pipeline
- Auto-mod bypasses (rule/filter/exemption logic)
- Data-handling bugs: leaked tokens, SQL injection, path traversal, XSS in the
  dashboard, unsafe deserialization
- Privilege escalation between dashboard users (a scoped Discord user gaining
  access to a guild they were not granted)

**Out of scope**

- Anyone who already holds `BOT_TOKEN`, `DASHBOARD_PASSWORD`, a `dash_` access
  token, or shell access to the host. Those are root-equivalent by design.
- A compromised Discord account that is already the owner or an authorised
  moderator.
- Denial of service through sheer traffic volume against your own host.
- Anything that requires the operator to paste attacker-controlled config into
  `/api/import/all` — the importer validates identifiers, but a backup file is
  still trusted input by definition.

## Hardening already in place (so you don't report it as a bug)

- Constant-time dashboard password comparison; session tokens are 32 random
  bytes, stored server-side, `HttpOnly` + `SameSite=Strict`, `Secure` behind TLS
- Discord dashboard users authenticate with a hashed, revocable access token and
  are re-verified on every request; revocation kills live sessions immediately
- Access tokens are stored only as SHA-256 digests, and a session keeps that
  digest rather than the token itself — so a leaked database or backup can't be
  replayed against the login route. Tokens expire 90 days after issue by default
  (`DASHBOARD_TOKEN_DAYS`; `0` disables it), expiry also drops the sessions a
  token created, and the dashboard surfaces when each token was last used
- Fail-closed tenant scoping: a scoped user with no grants sees nothing. The
  guard is a single global middleware over `/api/server/:id/*` so new routes
  cannot forget it
- CSP without `'unsafe-inline'` in `script-src`, plus `frame-ancestors 'none'`
- Sessions can be revoked individually from the dashboard. The owner sees every
  live session (each named by a one-way id, never by the token itself) and can
  end one; a scoped user sees only their own and can only end their own — the
  ownership check is server-side, so a scoped user holding an owner's session id
  still gets a 403
- Every limiter is per-IP and configurable from the dashboard: a global ceiling,
  a login bucket (10/min by default), an API bucket, and a tighter bucket for
  destructive mod actions. `TRUST_PROXY` defaults to trusting forwarded headers
  only from loopback/link-local/private peers, so a bare VPS can't be bypassed
  with a spoofed `X-Forwarded-For`
- Parameterised SQL throughout; the bulk importer validates table names against
  a hardcoded allowlist and filters columns against the live schema
- Uploads are extension-filtered and size-capped; token values are only ever
  returned once, at creation

## Known operational constraints

These are documented trade-offs, not vulnerabilities — but they matter if you
expose the dashboard publicly:

- **Sessions and rate limits are stored in the same SQLite file as the rest of
  the data.** They survive a restart and stay consistent across processes, so
  replicas must share the database file (a shared filesystem or network mount).
- **The dashboard password is a single shared secret with full owner powers**
  (including token creation and bulk import). Use a long unique password, and
  prefer `dash_` access tokens for scoped users over handing out the password.
- **Ranked data is only as safe as your `DATA_DIR`.** Point it at a persistent
  volume and keep it out of your image/backups you don't control.

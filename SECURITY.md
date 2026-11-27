# Security policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x (latest release) | Yes |
| Older / unreleased branches | No |

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub: go to the repository's **Security** tab and choose **Report a vulnerability**
(<https://github.com/bemoshiur/Super-Simple-ERP-ssERP/security/advisories/new>).

Include what you found, how to reproduce it, the version or commit, and the impact you expect. Please do not include real
customer data or live credentials.

What to expect: an acknowledgement as soon as a maintainer can look (this is a volunteer project, so there is no guaranteed
response time; our targets are an acknowledgement within 72 hours and a fix plan within 14 days, see
[docs/MAINTAINING.md](docs/MAINTAINING.md#security-response)), a discussion in the private advisory, a fix, and credit in the release notes if you want it. Please give us
reasonable time to release a fix before disclosing publicly.

## Scope

In scope: authentication and sessions, authorization and permission checks, company data isolation, the installer,
injection and XSS, money or serial-number integrity bugs, and secrets handling.

Out of scope: problems that need an already-compromised server or database, missing hardening on a deployment you operate
(for example HTTPS or a database exposed to the internet), and denial of service by sheer traffic volume.

## Operating ssERP safely

See the "Security notes" section of the [README](README.md): keep `.env` files out of git, use a strong `AUTH_SECRET` and
`INSTALL_TOKEN`, set `TRUSTED_PROXY=true` only behind a proxy that overwrites forwarded headers, and back up your database.

## Dependency audit

Checked for v0.1.0 (2026-11-28) with `npm audit`:

- **Production dependencies** (`npm audit --omit=dev`): **0 known vulnerabilities** after upgrading Next.js to 16.4.6
  (which also brings patched `postcss` and `sharp`).
- **Development-only, accepted:** 4 moderate advisories in an old `esbuild` that `drizzle-kit` pulls in through
  `@esbuild-kit/*` (GHSA-67mh-4wv8-2f99: the esbuild **dev server** can be read by any website). ssERP never runs that dev
  server; `drizzle-kit` only bundles the schema when a developer runs `npm run db:generate`. Nothing from it ships in the
  app. `npm audit fix --force` would downgrade drizzle-kit to an incompatible version, so this is accepted until
  drizzle-kit drops `@esbuild-kit`.

## Built-in hardening (v0.1.0)

- HTTP headers: `nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy` (camera for this site only), HSTS on Vercel or with `HSTS=1` (with `includeSubDomains`: every
  subdomain must serve HTTPS too, for a year after a browser saw the header), and a report-only
  Content-Security-Policy (`CSP_ENFORCE=1` at build time enforces it). See `next.config.ts` for the exact policy and the
  `'unsafe-inline'` tradeoff.
- No runtime requests to third-party hosts (icons are bundled; fonts are self-hosted by `next/font`).
- bcrypt cost 12 (older cost-10 hashes are upgraded on login; known side effect: during the transition, the first successful
  login of a not-yet-upgraded account takes one extra bcrypt hash, a timing difference that only tells an observer that
  the correct password was just used for an old account, which the successful login already reveals), DB-backed login throttling with an HMAC subkey, session
  revocation, secret-looking fields stripped from the activity log, no peer takeover between same-permission users.

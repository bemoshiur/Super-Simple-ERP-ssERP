# Release Process

How a new ssERP version is published. The maintainer checklist with every detail is
[docs/RELEASING.md](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/docs/RELEASING.md); the rules are in
[GOVERNANCE.md](https://github.com/bemoshiur/Super-Simple-ERP-ssERP/blob/main/GOVERNANCE.md).

## Versioning

ssERP uses [Semantic Versioning](https://semver.org/).

| Version change | Before 1.0.0 (now) | From 1.0.0 |
| --- | --- | --- |
| Patch (0.1.0 to 0.1.1) | Fixes only; no manual steps beyond `npm run db:migrate` | Same |
| Minor (0.1 to 0.2) | Features; **may include breaking changes**, always listed in the CHANGELOG with upgrade steps | Features, backwards compatible |
| Major | Not used yet | Breaking changes |

Pre-releases carry a suffix such as `0.2.0-rc.1`. There is no fixed schedule: a version is released when a useful set
of changes is ready and the checklist passes; security fixes are released as soon as they are ready.

## Steps

1. **Release pull request.** Bump the version (`npm version X.Y.Z --no-git-tag-version`, plus `CITATION.cff`), move the
   CHANGELOG's `[Unreleased]` section under the new version and date, and list migrations and upgrade steps.
2. **All checks green** locally and in CI: lint, typecheck, unit tests, database tests, end-to-end test, build,
   licence guard and docs link check.
3. **Tag** `vX.Y.Z` on `main` and push the tag.
4. **The release workflow** checks that the tag matches `package.json`, re-runs the fast checks and the build, and
   creates the GitHub Release with notes generated from merged pull requests, grouped into Security, Breaking changes,
   Features, Fixes, Docs, Dependencies and Maintenance. Versions below 1.0.0 are marked as pre-releases. No build
   artefacts are attached; ssERP is deployed from source.
5. **Post-release checks:** a fresh install and an upgrade from the previous version both work, and
   `/api/health?db=1` reports `"migrations": "ok"`.
6. **Docs:** README, this wiki (synced from `docs/wiki/` with `scripts/sync-wiki.sh`) and `SECURITY.md` supported
   versions are current.

## Unverified-infrastructure gate

As of v0.1.0 the maintainers have not run these end to end: the Neon serverless driver path, the Vercel one-click
deploy, `docker build` / Compose, and camera scanning and label printing on real devices. Release notes must not call
them tested until someone has verified them and the result is recorded.

## What users should do on a new release

1. Read the release notes and CHANGELOG entry.
2. Back up the database.
3. Run `npm run db:migrate` from the new version, then deploy it.

Details: [Upgrading and Backups](Upgrading-and-Backups).

## Security releases

Vulnerabilities are handled in private security advisories. The fix ships as a patch release, then the advisory is
published (with a CVE when appropriate) and the reporter is credited if they wish. Targets: acknowledgement within 72
hours and a fix plan within 14 days; these are targets for a volunteer project, not guarantees.

## Withdrawn releases

A broken release is fixed forward with a new patch version; tags are never moved or deleted. If a release must be
withdrawn, it is marked as a pre-release with a warning at the top of its notes and of its CHANGELOG entry.

Last verified against v0.1.0.

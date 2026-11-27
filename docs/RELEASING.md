# Releasing ssERP

The checklist a maintainer follows to publish a version. Versioning rules are in
[GOVERNANCE.md](../GOVERNANCE.md#releases-and-versioning). The automation is
[.github/workflows/release.yml](../.github/workflows/release.yml).

## 1. Decide the version

- `0.x.y` patch (`0.1.0` to `0.1.1`): fixes only, no manual upgrade steps beyond `npm run db:migrate`.
- `0.x` minor (`0.1` to `0.2`): features; may contain breaking changes before 1.0.0, each listed in the CHANGELOG
  with upgrade steps.
- Pre-releases use a suffix: `0.2.0-rc.1`.

## 2. Prepare the release pull request

On a branch `chore/release-X.Y.Z`:

1. Bump the version without creating a tag: `npm version X.Y.Z --no-git-tag-version` (updates `package.json` and
   `package-lock.json`). Also update `version` in [CITATION.cff](../CITATION.cff).
2. In [CHANGELOG.md](../CHANGELOG.md), rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (the real date), add a
   fresh empty `## [Unreleased]` above it, and update the comparison links at the bottom.
3. List new migrations (`drizzle/00NN_*.sql`) and any configuration change in the CHANGELOG entry, with upgrade steps.
4. Run everything CI runs, locally:

   ```bash
   npm ci
   npm run check:theme -- --identifiers && npm run check:docs
   npm run lint && npx tsc --noEmit && npm test
   npm run test:db          # needs initdb/pg_ctl
   npm run test:e2e         # needs initdb/pg_ctl and `npx playwright install chromium`
   npm run build
   ```

5. Open the pull request, wait for green CI and merge it into `main`.

## 3. Tag

From an up-to-date `main`:

```bash
git switch main && git pull --ff-only
git tag -a vX.Y.Z -m "ssERP vX.Y.Z"
git push origin vX.Y.Z
```

The tag must equal `v` + the `package.json` version, or the release workflow stops.

## 4. What the workflow does

1. Checks the tag against `package.json`.
2. Runs the licence guard, docs link check, lint, typecheck, unit tests and a production build.
3. Creates a GitHub Release named `ssERP vX.Y.Z` with notes generated from the merged pull requests, grouped by label
   into Security, Breaking changes, Features, Fixes, Docs, Dependencies and Maintenance
   ([.github/release.yml](../.github/release.yml)). Versions below 1.0.0 and versions with a `-` suffix are marked
   **pre-release**.
4. Attaches nothing: ssERP is deployed from source (Vercel, `npm run build`, Docker).

Afterwards, edit the release text if needed: paste the CHANGELOG section and highlight migrations and breaking changes.

## 5. Post-release verification

Do these before announcing the release:

- [ ] The release page exists and links to the right tag; the pre-release flag is correct.
- [ ] A fresh local install from the tag works: `./install.sh` or `npm ci && npm run setup`, sign in, record a purchase
      with serials, sell one, look it up.
- [ ] An upgrade from the previous release works: back up, `npm run db:migrate` from the new tag, start the app, the
      pending-migration banner is gone and `/api/health?db=1` reports `"migrations": "ok"`.
- [ ] Docs are current: README, wiki pages touched by the change (run `scripts/sync-wiki.sh` after merging wiki
      source changes), `SECURITY.md` supported versions.

### Infrastructure gate (not yet verified by the maintainers)

The following paths have **not** been run end to end by the maintainers as of v0.1.0. Until someone has verified
one and recorded the result (an issue or a CHANGELOG note), keep it listed as unverified in the README's "Project
status" and do not describe it as tested in release notes:

- [ ] **Neon**: the serverless driver path (automated tests run on plain PostgreSQL only).
- [ ] **Vercel**: the one-click deploy button, the Neon Marketplace integration's variable names, the web installer on
      a Vercel URL, the 60 s `maxDuration` of the bulk import page on the chosen plan.
- [ ] **Docker**: `docker build` / `docker compose up -d --build`, the bundled `postgres` profile and the `migrate`
      service.
- [ ] **Devices**: camera scanning on real phones and label printing on real label printers (verified only in
      desktop browsers so far).

When a path is verified, note the version, date and environment in the CHANGELOG and remove it from the README list.

## If something goes wrong

- A broken release is fixed forward with a new patch version. Do not move or delete a published tag.
- If a release must be withdrawn (for example a data-integrity bug), mark it as a pre-release, add a warning at the
  top of its notes and of the CHANGELOG entry, and publish the fix as soon as possible.
- Migrations are forward-only. A bad migration is corrected by a new migration, never by editing a committed one.

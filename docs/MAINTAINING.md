# Maintaining ssERP

How maintainers triage, review and respond. Decision rules are in [GOVERNANCE.md](../GOVERNANCE.md); releases in
[RELEASING.md](RELEASING.md).

## Labels

The full set lives in [.github/labels.yml](../.github/labels.yml) and is applied with `scripts/sync-labels.sh`.

| Group | Labels | Use |
| --- | --- | --- |
| Type | `bug`, `enhancement`, `documentation`, `question`, `security`, `dependencies`, `ci`, `performance`, `refactor` | What kind of change; drives the release-note categories |
| Status | `needs-triage`, `needs-info`, `confirmed`, `blocked`, `in-progress`, `wontfix`, `duplicate`, `stale` | Where it stands |
| Priority | `p0-critical`, `p1-high`, `p2-medium`, `p3-low` | How soon |
| Area | `area:inventory`, `area:sales`, `area:purchases`, `area:accounting`, `area:reports`, `area:auth`, `area:installer`, `area:ui`, `area:docs`, `area:db`, `area:i18n`, `area:docker` | Which part of the code |
| Community | `good first issue`, `help wanted`, `roadmap`, `breaking-change`, `pinned` | Contribution and planning |

## Triage

New issues arrive with `needs-triage` (the issue forms add it). For each one:

1. **Security?** If it describes a vulnerability, do not discuss details in public. Ask the reporter to use a private
   advisory, hide or edit sensitive content, and follow the security process below.
2. **Secrets or customer data?** Edit them out of the issue (and ask the reporter to rotate any leaked credential).
3. **Complete?** If the version, install type or steps are missing, add `needs-info` and ask. Issues in `needs-info`
   with no answer are handled by the stale workflow.
4. **Reproduce** on a fresh install with `npm run seed:demo`. If reproduced, add `confirmed`.
5. **Classify:** one type label, one or more `area:*` labels and a priority:
   - `p0-critical`: data loss, wrong money or stock figures, a serial sold twice, a permission or tenancy leak, install
     broken for everyone.
   - `p1-high`: a main workflow is broken with no workaround.
   - `p2-medium`: a bug with a workaround, or a valuable improvement.
   - `p3-low`: polish.
6. **Route:** questions go to Discussions when it is enabled; duplicates are closed with a link (`duplicate`); ideas
   already on the roadmap get `roadmap`; small, well-scoped tasks get `good first issue` or `help wanted`.
7. Remove `needs-triage`.

## Reviewing pull requests

Check the pull request template's checklist, then in particular:

- [ ] **Authorize first, company scope everywhere.** Every new server action or route handler goes through `guarded` /
      `guardedBranch` (or calls `authorize`) before reading input; every query and join filters by the session's
      company; no company or branch id is read from the client.
- [ ] **Branch scope.** New exported data-layer functions are classified in `src/server/branch-scope-registry.test.ts`;
      branch-owned reads take a `BranchFilter`.
- [ ] **Money.** Integer minor units through `src/server/money.ts`; totals recomputed server-side.
- [ ] **Locks and state.** Lock order respected; unit status only changes through `src/server/serials.ts`.
- [ ] **Cost visibility.** Cost and profit fields omitted server-side for viewers without profit visibility.
- [ ] **Migrations.** New file only; generated SQL reviewed; works on an existing database with data (backfills,
      `NOT NULL` with defaults); no extension that needs superuser rights.
- [ ] **Tests.** Unit tests for logic, `*.db.test.ts` for anything touching the database, locking, money or serial
      state; a regression test for bug fixes.
- [ ] **Logging.** Errors go through `safeLog`; nothing logs secrets, password hashes or query parameters.
- [ ] **Docs.** README, wiki sources (`docs/wiki/`) and the CHANGELOG `[Unreleased]` section are updated.
- [ ] **Licences.** New dependencies have a licence on the dependency-review allow-list; no copied theme code
      (`npm run check:theme`).

Prefer squash merges with a Conventional Commit title (`feat(sales): ...`), and label the pull request so it lands in
the right release-note category.

## Dependency updates

Dependabot opens grouped minor/patch updates weekly ([.github/dependabot.yml](../.github/dependabot.yml)). Merge them
when CI is green. Major versions of core frameworks are ignored by Dependabot and upgraded by a maintainer in a
dedicated pull request with migration notes. Security updates are handled with priority.

## Security response

Reports arrive as private security advisories ([SECURITY.md](../SECURITY.md)). These are **targets**, not guarantees;
the project is volunteer-run:

| Step | Target |
| --- | --- |
| Acknowledge the report | within 72 hours |
| Assess severity and share a fix plan (or explain why it is not a vulnerability) | within 14 days |
| Release a fix | as soon as it is ready; critical issues take priority over all other work |

Process: confirm and score the issue in the advisory, develop the fix in the advisory's private fork, request a CVE
through the advisory when appropriate, release a patch version, publish the advisory, and credit the reporter if they
wish.

## Wiki

The wiki is generated from `docs/wiki/`. Edit the sources in a pull request; after merging, a maintainer runs
`scripts/sync-wiki.sh` to publish. Edits made directly in the wiki UI are overwritten by the next sync.

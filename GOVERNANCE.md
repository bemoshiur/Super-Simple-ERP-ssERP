# Governance

ssERP is a small, **maintainer-led** project. This page says who decides what, how, and how that can change.

## Roles

- **Maintainer.** Today the project has one maintainer, the repository owner
  ([@bemoshiur](https://github.com/bemoshiur)), listed in [.github/CODEOWNERS](.github/CODEOWNERS). Maintainers triage
  issues, review and merge pull requests, cut releases, handle security reports and enforce the
  [Code of Conduct](CODE_OF_CONDUCT.md).
- **Contributors.** Anyone who opens an issue, answers a question, improves the docs or sends a pull request.
- **Users.** Shops and developers running ssERP. Their bug reports and feature requests shape the roadmap.

## How decisions are made

1. Most decisions happen in the open, in an issue, discussion or pull request.
2. Small changes (bug fixes, docs, minor improvements) are decided by the reviewing maintainer.
3. Larger changes (new modules, schema redesigns, new dependencies, anything that changes how money, stock, serial
   status or permissions work, or anything labelled `breaking-change`) start as an issue or discussion that explains
   the problem and the proposal. A maintainer records the decision there before the work is merged.
4. The maintainers aim for consensus. When there is none, the maintainers decide; while there is a single maintainer,
   that maintainer has the final say.
5. The [contribution invariants](CONTRIBUTING.md#invariants-every-change-must-keep) (company scoping, authorize
   first, exact money, lock order, append-only migrations, ...) are not up for case-by-case exceptions. Changing one
   needs its own issue and a documented decision.

## Becoming a maintainer

Maintainers are invited, based on sustained, high-quality contributions: several merged pull requests that respect
the invariants, helpful reviews or triage, and good judgement about data integrity and security. An existing
maintainer proposes the invitation in a discussion or issue; it takes effect when it is accepted and the new
maintainer is added to `.github/CODEOWNERS`. Maintainers who become inactive for a long time may be moved to an
emeritus list, with thanks.

## Releases and versioning

- ssERP follows [Semantic Versioning](https://semver.org/). Release steps are in [docs/RELEASING.md](docs/RELEASING.md).
- **Before 1.0.0** (the current 0.x series), minor versions (0.1 to 0.2) may contain breaking changes to
  configuration, behaviour or the database schema. They are always listed in [CHANGELOG.md](CHANGELOG.md) under a
  clear heading, with upgrade steps. Patch versions (0.1.0 to 0.1.1) only contain fixes and never need manual steps
  beyond running the migrations.
- From 1.0.0 on, breaking changes only happen in major versions.
- **Cadence.** There is no fixed schedule. A release is cut when a useful set of changes is ready and the release
  checklist passes. Security fixes are released as soon as a fix is ready.
- Database migrations are forward-only: there are no down migrations. Back up before upgrading (see the README,
  "Upgrading").

## Deprecation policy

- A feature, setting or environment variable that will be removed or changed incompatibly is first marked
  **deprecated** in the CHANGELOG and the docs, and where possible the app or a script warns about it.
- It keeps working for at least one further minor release before it is removed (before 1.0.0) or until the next
  major release (from 1.0.0 on).
- Security problems are the exception: an unsafe behaviour may be removed immediately, with a CHANGELOG entry under
  "Security".

## Code of Conduct

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Reports go privately to the maintainers as
described there.

## Changes to this document

Changes to governance are proposed as a pull request against this file and stay open for at least one week for
comments before a maintainer merges them.

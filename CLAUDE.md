# CLAUDE.md

@AGENTS.md

## Claude Code notes

- The shared guide above (`AGENTS.md`) is the source of truth for commands, structure and invariants. Keep this file thin.
- Before finishing a change run: `npm run lint && npx tsc --noEmit && npm test`; for anything touching the database, locking, money or serial state also run `npm run test:db`. Report honestly if you could not run a suite.
- Git writes may need the sandbox relaxed; `npm run test:db` / `npm run test:e2e` need `initdb` and a writable temp dir.
- Open a pull request into `main` (it is protected); do not push to `main` or force-push. Use the commit message style in `AGENTS.md`.
- For multi-step features, write a short plan first, make one logical commit per step, and verify each step with the relevant suite.

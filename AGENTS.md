# Kalki Engineering Instructions

- Treat the local `docs/00-*.md` through `docs/09-*.md` suite as the implementation specification even though `docs/` is intentionally not committed.
- Keep TrueForge as an external pinned dependency. Do not patch its source from this repository.
- Use the contracts in `packages/contracts` for every API, database, MCP, and UI boundary.
- Test runs may write sandbox artifacts but must never publish rows to formal workbook tables.
- Production requires an explicit recorded answer and matching task, schema, and pipeline hashes.
- Generated operators write records through `kalki_runtime`; they do not write directly to SQLite.
- Never assume a sandbox path such as `/workspace`. Resolve all task paths from the current working directory.
- Keep secrets in environment variables. Never place them in tasks, artifacts, generated skills, or logs.
- Build repository history in small dependency-ordered commits. Stage only files and hunks belonging to the current change.
- Do not push substantive work directly to `main`. Use a pull request, respond to Qodo findings, and rerun the review after fixes.
- Kalki is a general research platform. Tesla is an acceptance fixture, never a shared-code product boundary.
- The human and TrueForge agent must observe the same persistent Playwright browser context through the Research workspace.
- Prefer narrow modules around real ownership boundaries. Do not add more behavior to `index.ts` or `WorkbookService` when a focused existing or adjacent module owns it.
- Judge agent changes with an end-to-end task and the usefulness of its result, not only tool success or test counts.
- Keep local implementation progress in `docs/product-progress.md` and `docs/product-changelog.md`; `docs/` remains ignored.

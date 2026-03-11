# Repository Guidelines

## Project Structure & Module Organization

`bin/clawlens.ts` is the CLI entrypoint. Core application code lives in `src/`: `cli.ts` parses commands, `github.ts` handles GitHub sync, `store.ts` manages the local SQLite index, `semantic.ts` covers dataset/bootstrap flows, and `lib/` holds lower-level helpers. Tests live beside the code as `src/**/*.test.ts`. Runtime data is local-first: the default SQLite index is written under `~/.cache/clawlens/repos/`, and semantic dataset output defaults to `data/semantic/`.

## Build, Test, and Development Commands

Use Node `>=22` and `pnpm@10`.

- `pnpm clawlens --help` runs the CLI through `tsx`.
- `pnpm clawlens sync --full --repo openclaw/openclaw` refreshes a local PR index.
- `pnpm test` runs the Vitest suite.
- `pnpm typecheck` runs strict TypeScript checks with `tsc --noEmit`.
- `pnpm format` checks formatting with `oxfmt`.
- `pnpm format:fix` rewrites files to the repo format.

Documented commands were verified in this workspace; currently `pnpm test` has one existing timeout in `src/semantic.test.ts`, while `pnpm typecheck` and `pnpm format` pass.

## Coding Style & Naming Conventions

This repo uses ESM TypeScript, strict compiler settings, semicolons, and double quotes. Follow the existing style: camelCase for functions/variables, PascalCase for types/classes, and descriptive file names such as `semantic.ts` or `sqlite-vec.ts`. Keep tests next to the module they cover. Run `pnpm format:fix` before submitting changes instead of hand-formatting.

## Testing Guidelines

Vitest runs in a Node environment and only picks up `src/**/*.test.ts`. Add regression tests for behavior changes, especially around CLI parsing, GitHub retry logic, SQLite storage, and semantic ranking flows. Prefer narrow test data and deterministic assertions. Run `pnpm test`, then `pnpm typecheck` for touched code before opening a PR.

## Commit & Pull Request Guidelines

Git history currently uses Conventional Commits (`feat:`, `fix:`, `test:`). Keep subjects imperative and scoped, for example `fix: stabilize semantic bootstrap split selection`. PRs should explain the user-visible or workflow impact, list verification commands, and link the related issue or PR context. Include sample CLI output when a change affects command behavior.

## Security & Configuration Tips

Do not commit local SQLite caches, generated datasets, tokens, or GitHub CLI credentials. This project depends on `gh` access for sync operations, so prefer mocks or local fixtures in tests over live network calls.

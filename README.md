# clawlens

`claw-maintainer-tui` is the repo. `clawlens` is the CLI and TUI shipped from it.

This tool is a local-first OpenClaw maintainer cockpit:

- sync PR and issue metadata into SQLite
- search PRs and issues with exact, FTS, and optional vector-backed ranking
- cross-reference issues to PRs and PRs to issues
- inspect cluster candidates and merge-readiness facts
- triage a priority inbox and local watch/ignore state in the terminal
- build and benchmark semantic review datasets

The CLI only syncs when you ask it to. Search and TUI flows read from the local index by default and use `gh` for sync/refresh operations.

## Backend behavior

The local store keeps PRs, issues, labels, comments, review facts, and derived issue links in SQLite. Cross-reference commands use exact `pr_linked_issues` matches first, then fill remaining result slots with fuzzy search. Exact matches are ordered by link-source strength, open state, and recency so linked PRs and issues rank above text-only neighbors.

Issue sync limits count accepted issue rows, not raw GitHub `/issues` rows. Pull requests returned by that endpoint are skipped before the limit is consumed, so `--max-issues` fetches the requested number of real issues when enough are available.

Cluster recovery keeps live GitHub work bounded. Independent search variants run with limited concurrency, duplicate candidate PR numbers are hydrated once, and semantic-only cluster decisions are cached in memory until the seed or candidate signatures change.

## Requirements

- Node `>=22`
- `pnpm@10`
- `gh` authenticated for the target GitHub repo

## Quick start

```bash
pnpm install
pnpm clawlens --help
pnpm clawlens sync --full --repo openclaw/openclaw
pnpm clawlens sync-issues --full --repo openclaw/openclaw
pnpm clawlens tui --repo openclaw/openclaw
```

Useful follow-up commands:

```bash
pnpm clawlens search 'label:"size: XS" marker spoofing'
pnpm clawlens issue-search 'state:open marker spoofing'
pnpm clawlens xref-issue 41789
pnpm clawlens cluster-pr 41793 --refresh
pnpm clawlens status --repo openclaw/openclaw
```

## Verify

```bash
pnpm verify
pnpm gate:backend
```

`pnpm verify` runs typecheck, tests, and formatting checks. `pnpm gate:backend` runs typecheck plus the backend-focused coverage gate for store, GitHub, semantic, and lower-level helper paths while excluding the TUI surface.

## Install as `clawlens`

From the repo root:

```bash
pnpm link --global
```

Then run:

```bash
clawlens tui --repo openclaw/openclaw
clawlens search 'marker spoofing'
clawlens status --repo openclaw/openclaw
```

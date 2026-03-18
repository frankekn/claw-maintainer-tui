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
```

This runs typecheck, tests, and formatting checks.

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

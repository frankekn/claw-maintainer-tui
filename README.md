# clawlens

Local GitHub search and triage CLI.

Purpose:

- sync PR metadata, labels, and optional discussion into local SQLite
- run exact, lexical, and semantic PR search from local data
- build and benchmark semantic query sets

Current scope:

- PR indexing
- semantic eval tooling

Planned scope:

- issue indexing
- issue to PR cross-checks
- duplicate and cluster analysis across issues and PRs

## Quick start

```bash
pnpm install
pnpm clawlens sync --full --repo openclaw/openclaw
pnpm clawlens tui --repo openclaw/openclaw
pnpm clawlens search 'label:"size: XS" marker spoofing'
pnpm clawlens show 35983
```

The CLI only syncs when you ask it to. Search always reads from the local SQLite index.

`pnpm clawlens tui` launches the keyboard-first terminal workspace for PR search, issue search, cross-reference, clustering, status, and manual sync actions against a single local repo database.

## Install as `clawlens`

From the repo root, link the local package once:

```bash
pnpm link --global
```

Then launch it directly:

```bash
clawlens tui --repo openclaw/openclaw
clawlens search 'marker spoofing'
clawlens status --repo openclaw/openclaw
```

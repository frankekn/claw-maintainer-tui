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
pnpm clawlens search 'label:"size: XS" marker spoofing'
pnpm clawlens show 35983
```

The CLI only syncs when you ask it to. Search always reads from the local SQLite index.

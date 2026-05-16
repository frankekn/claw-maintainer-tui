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

## Rate-limit-aware sync

The TUI and CLI route sync through a deterministic in-app planner (`selectSyncDecision`) that inspects the local watermark, the GitHub rate-limit snapshot, and the active TUI mode before picking a sync mode. This keeps recent work visible without exhausting GitHub quota on large repos, while still allowing the legacy `store.sync` path as a rollback.

The planner picks between four modes:

- `hot`: when there is no watermark yet, or the watermark is older than the staleness threshold. Fetches recent PRs/issues ordered by `updated desc` and upserts summaries only. Does not advance `last_sync_watermark` and does not trigger PR hydration or fact prewarm.
- `incremental`: when the watermark is set and fresher than the staleness threshold. Existing delta sync behavior.
- `backfill`: chosen opportunistically after the primary mode when quota is healthy, the backfill cursor is still open, and no completion sentinel is recorded. Walks older history in small page batches and persists a cursor.
- `skipped`: when remaining quota is below the hard reserve, regardless of manual override. The CLI exits `0` and the TUI surfaces `SKIPPED RESERVE` so auto-sync retries when quota recovers.

### CLI flags

Default `pnpm clawlens sync` and `pnpm clawlens sync-issues` behavior is unchanged. Two new flags drive the planner directly:

```bash
pnpm clawlens sync --hot --repo openclaw/openclaw
pnpm clawlens sync --backfill --repo openclaw/openclaw
pnpm clawlens sync-issues --hot --repo openclaw/openclaw
pnpm clawlens sync-issues --backfill --repo openclaw/openclaw
```

`--full`, `--hot`, and `--backfill` are mutually exclusive. The TUI runs the planner automatically; manual `s` and `S` keys still trigger it.

### Status output

`pnpm clawlens status` now prints the new meta keys alongside the existing watermarks:

```
pr_hot_sync_at: 2026-05-16T00:18:23.000Z
issue_hot_sync_at: 2026-05-16T00:18:24.000Z
pr_backfill_cursor: 7
pr_backfill_completed_at: (none)
issue_backfill_cursor: (none)
issue_backfill_completed_at: 2026-05-15T18:02:11.000Z
```

### Tunables

The planner exposes a few constants in `src/sync-planner.ts`:

- `STALE_WATERMARK_MS = 15 * 60 * 1000` (15 minutes): watermarks within this window stay on `incremental`; older ones flip to `hot` on the next tick.
- `RATE_LIMIT_RESERVE = 100`: hard floor of remaining GitHub requests. Any decision below this becomes `skipped` with `reason: "rate_limit_reserve"`.
- `RATE_LIMIT_BACKFILL_FLOOR = 500`: minimum remaining quota required before `backfill` is eligible.

### Rollback

Set `CLAWLENS_SYNC_PLANNER=off` in the environment to bypass the planner entirely. Both the CLI and the TUI short-circuit to the legacy `store.sync({ full: false })` / `store.syncIssues({ full: false })` paths, ignore `--hot`/`--backfill`, and do not write the new hot/backfill meta keys.

```bash
CLAWLENS_SYNC_PLANNER=off pnpm clawlens tui --repo openclaw/openclaw
```

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

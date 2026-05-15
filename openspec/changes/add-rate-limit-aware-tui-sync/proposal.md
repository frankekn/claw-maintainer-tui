# Proposal: Add rate-limit-aware TUI sync planner

## Why

On openclaw-scale repos (~3000 issues and ~5000 PRs), the current TUI sync flow biases work toward the oldest history because full sync calls `listAllPullRequests`/`listAllIssues` ordered by `created` ascending without `newestFirst`, and the TUI landing views default to `state:open`. As a result, maintainers can see only old issues and PRs even after a successful sync, while expensive PR hydration and fact prewarm work can drain GitHub API quota before the user-visible working set is fresh.

The goal of this change is to keep the existing local-first TUI usable on huge repos by making sync **rate-limit-aware** and **UI-priority-first**: refresh recent and visible work first, hydrate selectively, and backfill old history opportunistically without burning the user's GitHub quota.

## Why this belongs in this repo

This repo already owns the seams this change needs:

- `PullRequestDataSource` and `IssueDataSource` in `src/types.ts` expose paginated and `since`-based sync entry points.
- `src/store/sync-workflow.ts` already distinguishes summary refresh from hydrated PR refresh and tracks `lastSyncWatermark` meta keys.
- `src/tui/controller.ts` already maintains a per-entity metadata sync job queue with manual/auto triggers, progress events, and idle replay.
- `src/tui/data-service.ts` is the single TUI entry point that calls `store.sync`/`store.syncIssues`.
- A rate-limit snapshot is already fetched via `GhCliPullRequestDataSource.getRateLimitStatus` and rendered in the TUI header.

This change extends those seams instead of introducing a parallel sync engine.

## What Changes

- Add a deterministic in-app **sync planner** that selects the next sync action based on a rate-limit budget, recency of the local cache, and what the user is currently viewing.
- Add a **hot metadata sync** path that fetches recent PRs and issues ordered by `updated desc` and upserts summaries only, without triggering PR hydration, comment sync, or fact prewarm.
- Add **resumable historical backfill** that walks older history in small page batches, with persisted cursors per entity and explicit completion meta keys.
- Add a rate-limit **budget** abstraction with hard reserve, low/moderate/healthy bands, and dynamic per-job concurrency.
- Update the TUI default search landing queries from `state:open` to `state:all` for PR/issue/Explore views so newly closed/merged work is visible. Keep Inbox and Watchlist open-only because those are triage surfaces.
- Update the TUI sync UI so manual `s`/`S` triggers run the planner instead of a single fixed strategy, and the existing progress badges can report `hot`, `incremental`, `full`, and `backfill` modes.

This change is additive. No spec under `openspec/specs/` exists yet, so no requirements are modified.

## Capabilities

### New Capabilities

- `local-sync-planner`: A local-first, rate-limit-aware planner that decides between hot metadata sync, incremental delta sync, and resumable historical backfill for PRs and issues in the TUI/CLI, and that prioritizes refreshing UI-visible rows over backfilling old history.

### Modified Capabilities

<!-- None. There are no existing specs under openspec/specs/. -->

## Impact

- **Code**: `src/types.ts` (data-source options), `src/github.ts` (`updated` sort), `src/store/sync-workflow.ts` (hot and backfill workflows), `src/store.ts` (planner entry points, new meta keys, hot/backfill methods), `src/tui/data-service.ts`, `src/tui/effects.ts`, `src/tui/controller.ts`, `src/tui/listing.ts`, `src/tui/format/detail.ts`, `src/tui/types.ts`.
- **CLI**: optional `sync --hot` and `sync --backfill` flags exposed through `src/cli.ts`. Default `pnpm clawlens sync` behavior is unchanged.
- **Storage**: additive meta keys only (`pr_hot_sync_at`, `pr_backfill_cursor`, `pr_backfill_completed_at`, and issue equivalents). No table changes.
- **External dependencies**: no new dependencies. Uses existing `gh` rate limit and REST endpoints.
- **Tests**: new tests under `src/github.test.ts`, `src/store.test.ts`, `src/tui/controller.test.ts`, and any planner module that lands.

## Goals

- Make the TUI useful within seconds on a fresh clone of openclaw-scale repos.
- Avoid burning GitHub API quota on expensive hydration when only metadata freshness is needed.
- Keep all behavior deterministic and unit-testable without live GitHub calls.
- Preserve the existing CLI commands, meta keys, and TUI keybindings.

## Non-Goals

- Replacing the local SQLite store or the existing `PrIndexStore` API surface.
- Rewriting sync against GraphQL.
- Adding ETag/conditional-request caching in this iteration.
- Auto-hydrating every cached PR or issue.
- Driving sync from an LLM agent or external coordination server (the central API change tracks that separately).
- Changing Inbox/Watchlist semantics, which are intentionally `state:open`-only.

## Rollout Phases

### Phase 0 — OpenSpec scaffolding

Land this proposal, the spec, the design, and the task list. No application code changes.

### Phase 1 — Foundations

Add `updated` sort to data-source options, add the budget helper, and add new meta keys to the store schema and status snapshot. Keep all existing flows unchanged.

### Phase 2 — Planner module (pure)

Implement `selectSyncDecision` as a pure function over a snapshot. Constants `RATE_LIMIT_RESERVE`, `RATE_LIMIT_BACKFILL_FLOOR`, and `STALE_WATERMARK_MS` land here. The module has no I/O dependencies, so it unblocks unit tests for the workflows that follow.

### Phase 3 — Hot metadata sync

Implement `syncHotPullRequests` and `syncHotIssues` in the store and a `hot` mode in the sync workflows. Wire them through `StoreBackedTuiDataService` as the planner's `hot` dispatcher target.

### Phase 4 — Resumable backfill

Implement cursored historical backfill (using the new `startPage` data-source option), persist cursors, and add idle-triggered backfill slices. Only run when quota is healthy.

### Phase 5 — UI freshness defaults

Switch search landing defaults to `state:all`, update landing copy, and add regression tests for the new defaults.

### Phase 6 — CLI parity

Expose `sync --hot` and `sync --backfill` so operators can drive the same planner phases from the CLI for scripting and testing.

## Risks

- **Watermark regression**: if hot sync incorrectly advances `last_sync_watermark`, incremental sync could miss intermediate updates. Mitigation: hot sync MUST NOT advance `last_sync_watermark`; it only touches `*_hot_sync_at`.
- **Rate-limit budget thrash**: aggressive auto-sync could still exhaust quota. Mitigation: hard reserve, per-job concurrency cap, and refusal to run when quota is below the reserve.
- **User confusion from `state:all` default**: maintainers who relied on the previous open-only default may see closed/merged rows mixed in. Mitigation: explicit `state:open` query still works, landing copy is updated, Inbox/Watchlist stay open-only.
- **Backfill stall**: if the cursor is never advanced past a bad page, backfill could loop. Mitigation: persist a monotonic page number and a `pr_backfill_completed_at` sentinel; surface backfill state in `status`.
- **gh CLI rate limit unavailable**: `getRateLimitStatus` may return `null`. Mitigation: planner treats `null` as moderate and avoids backfill.

## Rollback

If the planner causes regressions:

- Set a feature flag or environment override (e.g. `CLAWLENS_SYNC_PLANNER=off`) that forces the legacy `store.sync({ full: false })` path in `StoreBackedTuiDataService`.
- Hot sync, backfill, and the new meta keys remain read-only and harmless if the planner is bypassed.
- Landing query defaults can be reverted to `state:open` independently because they live in `src/tui/listing.ts`.

## Success Criteria

- On a fresh DB for a repo with thousands of issues/PRs, the TUI shows recent rows within one hot sync pass rather than after a full historical sync.
- Manual `s` and `S` in the TUI never push GitHub quota below the configured reserve.
- `pnpm clawlens status` reports hot sync timestamps and backfill completion state.
- Existing tests for incremental/full sync still pass without modification.

## Open Questions Explicitly Resolved Here

- **Hot sync size**: default to ~500 PRs and ~500 issues per hot pass, configurable later. This keeps round trips bounded at roughly 5 pages of 100 per entity.
- **Backfill batch size**: `BACKFILL_PAGES_PER_SLICE = 2` pages per idle slice, only when quota remaining is at or above `RATE_LIMIT_BACKFILL_FLOOR = 500`.
- **Staleness boundary**: `STALE_WATERMARK_MS = 15 * 60 * 1000` (15 minutes). Watermarks within that window keep the planner on `incremental`; older watermarks flip the planner to `hot` on the next tick.
- **Inbox vs Search landings**: Inbox/Watchlist stay `state:open`. PR/Issue/Explore landings change to `state:all`.

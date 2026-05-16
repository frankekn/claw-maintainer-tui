# Tasks: Rate-limit-aware TUI sync planner

> Task sections are ordered by dependency, not by the proposal's phase list. The pure planner module (§2) lands before workflow branches (§3, §4) because it has no I/O and unblocks unit tests for those workflows.

## 1. Foundations

- [ ] 1.1 Extend `PullRequestDataSource.listAllPullRequests` and `IssueDataSource.listAllIssues` option types in `src/types.ts` to accept `sort?: "created" | "updated"`, `direction?: "asc" | "desc"`, and `startPage?: number` (1-based, defaults to `1`) while preserving the existing `newestFirst` default. When both `newestFirst` and `sort`/`direction` are provided, explicit `sort`/`direction` wins.
- [ ] 1.2 Update `GhCliPullRequestDataSource.listAllPullRequests` and `listAllIssues` in `src/github.ts` to forward `sort`/`direction` into the REST URL and to start the paging loop from `startPage` instead of always `1`.
- [ ] 1.3 Add new meta key constants in `src/store.ts`: `META_PR_HOT_SYNC_AT`, `META_ISSUE_HOT_SYNC_AT`, `META_PR_BACKFILL_CURSOR`, `META_PR_BACKFILL_COMPLETED_AT`, `META_ISSUE_BACKFILL_CURSOR`, `META_ISSUE_BACKFILL_COMPLETED_AT`.
- [ ] 1.4 Extend `StatusSnapshot` in `src/types.ts` with `prHotSyncAt`, `issueHotSyncAt`, `prBackfillCursor`, `prBackfillCompletedAt`, `issueBackfillCursor`, `issueBackfillCompletedAt` and populate them in `PrIndexStore.status()`.
- [ ] 1.5 Extend `SyncSummary` in `src/types.ts`: widen `mode` to `"full" | "incremental" | "hot" | "backfill" | "skipped"`, change `lastSyncAt` and `lastSyncWatermark` to `string | null`, and add optional `reason?: "rate_limit_reserve" | "already_fresh" | "backfill_complete"` and `nextBackfillCursor?: number | null`. Adjust all existing producers (`syncPullRequestsWorkflow`, `syncIssuesWorkflow`, `printSyncSummary`) to keep returning strings for `full` / `incremental` and to handle null safely in consumers.
- [ ] 1.6 Add a `TuiDataService` / `TuiEffects` option `options?.trigger?: "manual" | "auto"` in `src/tui/types.ts`, `src/tui/effects.ts`, and `src/tui/data-service.ts` for `syncPrs`/`syncIssues`. Default to `"manual"` to preserve existing callers.

### Verification

- [ ] 1.7 Run `pnpm typecheck`.
- [ ] 1.8 Run `pnpm test` and confirm existing tests still pass with the widened `SyncSummary`.

## 2. Planner module

- [ ] 2.1 Create `src/sync-planner.ts` exporting `selectSyncDecision(input: PlannerSnapshot): PlannerDecision` as a pure function.
- [ ] 2.2 Export band constants: `RATE_LIMIT_RESERVE = 100`, `RATE_LIMIT_BACKFILL_FLOOR = 500`, and the staleness threshold `STALE_WATERMARK_MS = 15 * 60 * 1000`.
- [ ] 2.3 Implement band logic: reserve (`remaining < RATE_LIMIT_RESERVE`), moderate (`< RATE_LIMIT_BACKFILL_FLOOR`), healthy (`>= RATE_LIMIT_BACKFILL_FLOOR`); null snapshot treated as moderate.
- [ ] 2.4 Implement freshness rules using `STALE_WATERMARK_MS`:
  - no `lastSyncWatermark` → prefer `hot`; `full` only with `manualOverride: "full"`,
  - watermark set and `now - lastSyncAt <= STALE_WATERMARK_MS` → `incremental`,
  - watermark set and `now - lastSyncAt > STALE_WATERMARK_MS` → `hot`,
  - `backfill` may be picked only after the chosen mode and only when quota is healthy, cursor is open, and completion sentinel is null.
- [ ] 2.5 Support `manualOverride` for `--hot`, `--backfill`, `--full`, defaulting `null` for normal flows; reserve-band MUST still skip overrides and return a `skip` decision with `reason: "rate_limit_reserve"`.
- [ ] 2.6 Plumb `activeTuiMode` (`"pr-search" | "issue-search" | "cross-search" | "inbox" | "watchlist" | null`) into the snapshot; list modes with stale watermark MUST prefer `hot` over `backfill` in the same tick.
- [ ] 2.7 Add `src/sync-planner.test.ts` with deterministic unit tests covering: every band × freshness combination, the `STALE_WATERMARK_MS` boundary (one ms below and one ms above), manual override × reserve, manual override × healthy, and the list-mode-vs-non-list-mode ordering.

### Verification

- [ ] 2.8 Run `pnpm test src/sync-planner.test.ts` and confirm full branch coverage.
- [ ] 2.9 Run `pnpm typecheck`.

## 3. Hot metadata sync workflow

- [ ] 3.1 Add a `hot` branch in `syncPullRequestsWorkflow` (`src/store/sync-workflow.ts`) that calls `listAllPullRequests({ sort: "updated", direction: "desc", limit: HOT_PR_LIMIT })`, upserts summaries via `upsertPullRequestSummary(pr, "partial")`, and writes only `META_PR_HOT_SYNC_AT` (never `META_LAST_SYNC_WATERMARK`).
- [ ] 3.2 Add the corresponding `hot` branch in `syncIssuesWorkflow` for issues, writing only `META_ISSUE_HOT_SYNC_AT`.
- [ ] 3.3 Add `PrIndexStore.syncHotPullRequests` and `syncHotIssues` methods that wrap the new workflow branches, skip `prewarmPullRequestFacts`, and return a `SyncSummary` with `mode: "hot"`.
- [ ] 3.4 Add unit tests in `src/store.test.ts` proving:
  - hot sync requests `sort=updated&direction=desc`,
  - hot sync does not call `hydratePullRequest`/`fetchPullRequestFacts`/`getIssueComments`,
  - `last_sync_watermark` and `issue_last_sync_watermark` are untouched,
  - the returned summary has `mode: "hot"` and a non-null `processedPrs`/`processedIssues`.

### Verification

- [ ] 3.5 Run `pnpm test`.
- [ ] 3.6 Run `pnpm typecheck`.

## 4. Resumable backfill workflow

- [ ] 4.1 Add a `backfill` branch in `syncPullRequestsWorkflow` that reads `META_PR_BACKFILL_CURSOR` (default `1`), fetches `BACKFILL_PAGES_PER_SLICE = 2` pages from `listAllPullRequests({ sort: "created", direction: "asc", startPage: cursor })`, upserts summaries, advances the cursor only after each page is fully processed, and sets `META_PR_BACKFILL_COMPLETED_AT` when a page returns fewer than `PAGE_SIZE` items.
- [ ] 4.2 Mirror the issue backfill branch using `listAllIssues` with the same `startPage` cursor.
- [ ] 4.3 Expose `PrIndexStore.runBackfillSlice({ entity: "prs" | "issues", ... })` for the planner and CLI and return a `SyncSummary` with `mode: "backfill"` and `nextBackfillCursor` set to the new cursor (or `null` once completion sentinel is written).
- [ ] 4.4 Add unit tests covering cursor advancement, completion sentinel, idempotence on retry after a thrown error mid-page, and that `nextBackfillCursor` matches the persisted meta key.

### Verification

- [ ] 4.5 Run `pnpm test`.
- [ ] 4.6 Run `pnpm typecheck`.

## 5. TUI integration

- [ ] 5.1 Update `StoreBackedTuiDataService.syncPrs` and `syncIssues` in `src/tui/data-service.ts` to act as the planner dispatcher: build a `PlannerSnapshot` from `store.status()` + `this.rateLimit()` + `options?.trigger`, call `selectSyncDecision`, and dispatch the resulting `run`/`skip` outcome to the right store method. Synthesize a `SkippedSyncSummary` locally for `skip` decisions (no new store method required).
- [ ] 5.2 Add the `CLAWLENS_SYNC_PLANNER` env flag in `src/tui/data-service.ts`; when its value is exactly `"off"`, short-circuit to today's `store.sync({ full: false })` / `store.syncIssues({ full: false })` without calling `selectSyncDecision` or touching new meta keys. Add a unit test asserting both branches.
- [ ] 5.3 Thread `trigger: "auto" | "manual"` from `TuiController.queueMetadataSync` through `TuiEffects.syncPrs/syncIssues` into the data service so the planner can distinguish manual and auto sync.
- [ ] 5.4 Update `TuiController.drainMetadataJobs` to compute `totalKnown`, `lastCompletedAt`, `nextAutoUpdateAt`, and the running-rerun decision per `summary.mode`:
  - `incremental`: existing behavior,
  - `full`: existing behavior,
  - `hot`: `totalKnown = processed + skipped` is allowed but not required; `lastCompletedAt` advances if non-null,
  - `backfill`: `totalKnown = null`; surface `nextBackfillCursor` in the job progress label,
  - `skipped`: do NOT advance `nextAutoUpdateAt`; surface `reason` in the job message so the auto-sync retries when quota recovers.
- [ ] 5.5 Update `src/tui/format/chrome.ts` (or wherever sync job badges live) to display "HOT", "BACKFILL N", and "SKIPPED RESERVE" labels.
- [ ] 5.6 Add controller tests in `src/tui/controller.test.ts` for each new `summary.mode` covering the bookkeeping rules in 5.4.

### Verification

- [ ] 5.7 Run `pnpm test src/tui`.
- [ ] 5.8 Run `pnpm typecheck`.

## 6. UI freshness defaults

- [ ] 6.1 Change `pr-search`, `issue-search`, and `cross-search` defaults in `src/tui/listing.ts` from `state:open` to `state:all`.
- [ ] 6.2 Update landing titles and messages in `src/tui/listing.ts` and `src/tui/format/detail.ts` from "open PRs/issues" to "recent cached PRs/issues".
- [ ] 6.3 Confirm Inbox and Watchlist landings still pass `listPriorityInbox`/`listWatchlist` unchanged.
- [ ] 6.4 Update existing TUI tests that asserted `state:open` was the default to expect `state:all` for the three search modes only. Add a regression test that the landing detail string contains "recent cached" for `pr-search` and `issue-search`.

### Verification

- [ ] 6.5 Run `pnpm test src/tui`.
- [ ] 6.6 Run `pnpm typecheck`.

## 7. CLI parity

- [ ] 7.1 Add `--hot` and `--backfill` flags to `parseArgs` in `src/cli.ts` for `sync` and `sync-issues`, with mutual exclusion against `--full`.
- [ ] 7.2 Route `--hot` through `selectSyncDecision` with `manualOverride: "hot"` and dispatch the resulting decision (calling `store.syncHotPullRequests` / `store.syncHotIssues` on `run.hot`, printing a `skipped` summary on `skip`).
- [ ] 7.3 Route `--backfill` through `selectSyncDecision` with `manualOverride: "backfill"` and dispatch to `store.runBackfillSlice(...)` on `run.backfill` or print a `skipped` summary with the appropriate reason on `skip`.
- [ ] 7.4 Honor `CLAWLENS_SYNC_PLANNER=off` in the CLI by short-circuiting to today's `store.sync` / `store.syncIssues` regardless of the flag.
- [ ] 7.5 Update `printSyncSummary` in `src/cli.ts` to render the new `mode` values, the optional `reason`, and `nextBackfillCursor`. On a `skip` decision the CLI MUST exit `0`.
- [ ] 7.6 Update `clawlens status` output to print `pr_hot_sync_at`, `issue_hot_sync_at`, backfill cursors, and completion sentinels.
- [ ] 7.7 Add CLI parse tests in `src/cli.test.ts` for `--hot`, `--backfill`, the mutual-exclusion error message, and the reserve-skipped output format.

### Verification

- [ ] 7.8 Run `pnpm clawlens --help` and confirm it shows the new flags.
- [ ] 7.9 Run `pnpm test src/cli.test.ts`.
- [ ] 7.10 Run `pnpm typecheck`.

## 8. End-to-end validation

- [ ] 8.1 Run `pnpm verify` (typecheck + tests + format).
- [ ] 8.2 Manually exercise `pnpm clawlens sync --hot --repo openclaw/openclaw` against a fresh local DB and confirm hot rows appear in the TUI without triggering hydration.
- [ ] 8.3 Manually run `pnpm clawlens sync --backfill --repo openclaw/openclaw` and confirm the cursor advances and `status` reports it.
- [ ] 8.4 Run the TUI with `CLAWLENS_SYNC_PLANNER=off pnpm clawlens tui --repo openclaw/openclaw` to confirm rollback path keeps the legacy behavior and does not write hot/backfill meta keys.
- [ ] 8.5 Update `README.md` with a short section on the new sync modes, the staleness threshold, and the rollback env var.

### Verification

- [ ] 8.6 Run `pnpm verify` one final time.
- [ ] 8.7 Confirm `openspec validate add-rate-limit-aware-tui-sync --strict` still passes after any spec adjustments made during implementation.

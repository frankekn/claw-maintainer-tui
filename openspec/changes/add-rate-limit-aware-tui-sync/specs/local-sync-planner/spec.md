# Local Sync Planner

## ADDED Requirements

### Requirement: The TUI sync entry points MUST route through a rate-limit-aware planner

The system MUST select a sync mode (`hot`, `incremental`, `full`, or `backfill`) at every manual and auto sync entry point based on a deterministic planner that consults the latest known GitHub API rate limit, the per-entity local freshness watermarks, and the user's currently active TUI mode. This requirement applies to both pull requests and issues.

#### Scenario: Manual sync uses the planner

- **WHEN** the maintainer presses `s` or `S` in the TUI
- **THEN** the sync job dispatcher MUST ask the planner for the next mode
- **AND** the resulting `SyncSummary` MUST report that mode in its `mode` field

#### Scenario: Auto sync uses the planner

- **GIVEN** the planner is enabled
- **WHEN** the TUI auto-sync timer fires for stale PR or issue metadata
- **THEN** the queued metadata job MUST run the planner-selected mode for that entity
- **AND** the planner MUST NOT pick `full` for auto sync when an `incremental` watermark already exists

### Requirement: The SyncSummary type MUST represent hot, backfill, and skipped outcomes

`SyncSummary.mode` MUST be extended to `"full" | "incremental" | "hot" | "backfill" | "skipped"`, `lastSyncAt` and `lastSyncWatermark` MUST be nullable so that `skipped` and `backfill` outcomes can omit them, and the summary MUST optionally carry `reason?: "rate_limit_reserve" | "already_fresh" | "backfill_complete"` and `nextBackfillCursor?: number | null`. This requirement applies to both pull requests and issues.

#### Scenario: Hot summary reports hot mode and processed counts

- **WHEN** the planner runs a `hot` PR sync that touches 312 PRs and skips 0
- **THEN** the returned `SyncSummary` MUST have `mode: "hot"`
- **AND** `processedPrs` MUST equal `312`
- **AND** `lastSyncWatermark` MUST be unchanged from before the hot pass

#### Scenario: Backfill summary reports the next cursor

- **WHEN** the planner runs a `backfill` slice that advances the cursor from `12` to `14`
- **THEN** the returned `SyncSummary` MUST have `mode: "backfill"`
- **AND** `nextBackfillCursor` MUST equal `14`

#### Scenario: Skipped summary reports a reason without timestamps

- **GIVEN** rate-limit remaining is below the hard reserve
- **WHEN** the planner returns a `skip` decision and the dispatcher constructs the summary
- **THEN** the returned `SyncSummary` MUST have `mode: "skipped"`
- **AND** `reason` MUST equal `"rate_limit_reserve"`
- **AND** `lastSyncAt` MAY be `null`

### Requirement: Hot metadata sync MUST fetch newest-updated items first without hydrating

When the planner selects `hot`, the system MUST request items from GitHub ordered by `updated desc`, MUST upsert only summary fields (title, body, labels, state, timestamps, base/head ref for PRs), and MUST NOT trigger PR hydration, comment sync, or fact prewarm. This requirement applies to both pull requests and issues.

#### Scenario: Hot PR sync uses updated-desc ordering

- **WHEN** the planner selects `hot` for pull requests
- **THEN** the data source MUST request `repos/{owner}/{name}/pulls?state=all&sort=updated&direction=desc`
- **AND** the workflow MUST stop after fetching the configured hot page budget

#### Scenario: Hot issue sync uses updated-desc ordering

- **WHEN** the planner selects `hot` for issues
- **THEN** the data source MUST request `repos/{owner}/{name}/issues?state=all&sort=updated&direction=desc`
- **AND** the workflow MUST skip rows that have a `pull_request` marker

#### Scenario: Hot sync does not hydrate PRs

- **GIVEN** a PR is touched by hot sync
- **WHEN** hot sync completes
- **THEN** no call to `hydratePullRequest`, `fetchPullRequestFacts`, or PR comment endpoints MUST be made for that PR as part of the hot sync workflow

### Requirement: Hot metadata sync MUST NOT advance the incremental watermark

Hot metadata sync MUST persist its own `*_hot_sync_at` meta key but MUST NOT mutate the existing `last_sync_watermark` or `issue_last_sync_watermark` keys, so that a subsequent incremental sync still detects every change since the last full or incremental pass. This requirement applies to both pull requests and issues.

#### Scenario: Hot sync writes hot timestamp only

- **GIVEN** the store has `last_sync_watermark = "2026-03-10T12:00:00Z"`
- **WHEN** a `hot` PR sync completes
- **THEN** the store MUST have `pr_hot_sync_at` set to a fresh ISO timestamp
- **AND** the store MUST still report `last_sync_watermark = "2026-03-10T12:00:00Z"`

#### Scenario: Incremental still catches missed updates

- **GIVEN** a PR was updated between the last incremental watermark and a later hot sync
- **WHEN** a subsequent incremental sync runs
- **THEN** the incremental workflow MUST detect that PR via `listChangedPullRequestsSince` using the unchanged `last_sync_watermark`

### Requirement: The planner MUST respect a GitHub API rate-limit budget with a hard reserve

The planner MUST refuse to schedule work that would push the GitHub core API remaining quota below a configured hard reserve, MUST select less expensive modes as remaining quota drops, and MUST use a fixed staleness threshold to decide between `hot` and `incremental` when a watermark exists. The default hard reserve MUST be `100` and the default staleness threshold MUST be 15 minutes (`STALE_WATERMARK_MS = 900_000`). This requirement applies to both pull requests and issues.

#### Scenario: Low quota falls back to cache

- **GIVEN** the latest rate-limit snapshot reports `remaining < 100`
- **WHEN** the planner is asked for the next sync mode
- **THEN** it MUST return a `skip` decision with reason `rate_limit_reserve`
- **AND** the TUI MUST display the cached rows with a warning badge

#### Scenario: Moderate quota chooses hot only

- **GIVEN** the latest rate-limit snapshot reports `100 <= remaining < 500`
- **WHEN** the planner is asked for the next sync mode for an entity with stale metadata
- **THEN** it MUST select `hot`
- **AND** it MUST NOT select `backfill` in the same planner tick

#### Scenario: Healthy quota allows backfill slices

- **GIVEN** the latest rate-limit snapshot reports `remaining >= 500`
- **AND** the entity has an unfinished backfill cursor
- **WHEN** the planner is asked for the next sync mode after a successful hot or incremental pass
- **THEN** it MAY select `backfill` for one bounded slice

#### Scenario: Missing rate-limit data is treated as moderate

- **GIVEN** `getRateLimitStatus` returns `null` or throws
- **WHEN** the planner is asked for the next sync mode
- **THEN** it MUST behave as if quota is moderate
- **AND** it MUST NOT schedule `backfill`

#### Scenario: Fresh watermark prefers incremental

- **GIVEN** quota is healthy
- **AND** `lastSyncWatermark` is set
- **AND** `now - lastSyncAt <= STALE_WATERMARK_MS`
- **WHEN** the planner is asked for the next sync mode
- **THEN** it MUST select `incremental`
- **AND** it MUST NOT select `hot` solely because the user is on a list view

#### Scenario: Stale watermark prefers hot

- **GIVEN** quota is healthy
- **AND** `lastSyncWatermark` is set
- **AND** `now - lastSyncAt > STALE_WATERMARK_MS`
- **WHEN** the planner is asked for the next sync mode
- **THEN** it MUST select `hot`
- **AND** the next planner tick MAY select `incremental` once the hot pass completes

### Requirement: Historical backfill MUST be resumable per entity

The system MUST persist a monotonic backfill cursor per entity, MUST advance the cursor only after a page is fully processed, and MUST stop scheduling backfill once a `*_backfill_completed_at` sentinel is set. This requirement applies to both pull requests and issues.

#### Scenario: Backfill resumes from cursor via startPage

- **GIVEN** the store has `pr_backfill_cursor = 12` and no `pr_backfill_completed_at`
- **WHEN** the planner runs a backfill slice for PRs
- **THEN** the workflow MUST call `listAllPullRequests({ sort: "created", direction: "asc", startPage: 12 })`
- **AND** the cursor MUST advance only after the page is fully upserted

#### Scenario: Backfill completion is sticky

- **GIVEN** the store has `pr_backfill_completed_at` set
- **WHEN** the planner evaluates whether to schedule backfill
- **THEN** it MUST NOT pick `backfill` for that entity
- **AND** it MUST NOT clear the completion sentinel automatically

### Requirement: The planner MUST prioritize freshening visible TUI rows over historical backfill

When the user's active TUI mode is a list mode (`pr-search`, `issue-search`, `cross-search`, `inbox`, or `watchlist`) and the local watermark age exceeds `STALE_WATERMARK_MS`, the planner MUST select `hot` (or `incremental` when quota only allows that band) before scheduling `backfill`. The rule MUST NOT cause additional per-row hydration; it only changes mode ordering on the planner snapshot. This requirement applies to both pull requests and issues.

#### Scenario: Stale list view prefers hot before backfill

- **GIVEN** the user is viewing the Inbox
- **AND** quota is healthy
- **AND** `now - lastSyncAt > STALE_WATERMARK_MS`
- **AND** the entity has an unfinished backfill cursor
- **WHEN** the planner is asked for the next sync mode
- **THEN** it MUST select `hot`
- **AND** it MUST NOT select `backfill` in the same tick

#### Scenario: Fresh list view defers backfill until incremental settles

- **GIVEN** the user is viewing the PR search landing
- **AND** quota is healthy
- **AND** `now - lastSyncAt <= STALE_WATERMARK_MS`
- **WHEN** the planner is asked for the next sync mode
- **THEN** it MUST select `incremental`
- **AND** the next tick MAY select `backfill`

### Requirement: The CLI MUST expose planner modes for scripting

The `clawlens sync` and `clawlens sync-issues` commands MUST accept `--hot` and `--backfill` flags that route through the planner as `manualOverride: "hot"` or `manualOverride: "backfill"`, MUST honor the same hard reserve as the TUI, and MUST keep the default flag-less behavior backward compatible. This requirement applies to both pull requests and issues.

#### Scenario: --hot forces hot mode

- **WHEN** the operator runs `clawlens sync --hot --repo owner/name`
- **AND** quota is healthy or moderate
- **THEN** the CLI MUST invoke the planner with `manualOverride: "hot"`
- **AND** the printed summary MUST report `mode: hot`

#### Scenario: --backfill runs one bounded slice

- **WHEN** the operator runs `clawlens sync --backfill --repo owner/name`
- **AND** backfill is incomplete and quota is healthy
- **THEN** the CLI MUST invoke the planner with `manualOverride: "backfill"`
- **AND** the printed summary MUST include the new cursor value via `nextBackfillCursor`

#### Scenario: --hot honors the hard reserve

- **GIVEN** the latest rate-limit snapshot reports `remaining < 100`
- **WHEN** the operator runs `clawlens sync --hot --repo owner/name`
- **THEN** the CLI MUST print a `skipped` summary including `reason: rate_limit_reserve`
- **AND** the CLI MUST exit with status `0`

#### Scenario: Default sync still works

- **WHEN** the operator runs `clawlens sync --repo owner/name` without new flags
- **THEN** the CLI MUST run the existing incremental sync behavior
- **AND** it MUST NOT call hot or backfill workflows

### Requirement: The TUI status snapshot MUST surface planner state

The `status()` snapshot consumed by the TUI MUST include the hot sync timestamps and backfill cursors/completion sentinels per entity so the header and Status pane can communicate why the UI is showing older data. This requirement applies to both pull requests and issues.

#### Scenario: Status snapshot includes hot timestamps

- **WHEN** `status()` is called after a hot PR sync
- **THEN** the returned object MUST include a non-null `prHotSyncAt`
- **AND** the TUI header MUST be able to render its relative age

#### Scenario: Status snapshot includes backfill state

- **WHEN** `status()` is called while PR backfill is in progress
- **THEN** the returned object MUST include `prBackfillCursor` and `prBackfillCompletedAt = null`
- **AND** the Status pane MUST render those values in its existing rows list

### Requirement: TUI search landing views MUST default to recent cached rows across all states

The PR search, issue search, and Explore landing views MUST default their cached query to `state:all` so newly closed or merged work is visible immediately after a hot or incremental sync, and explicit `state:open`, `state:closed`, and `state:merged` queries MUST continue to work. This requirement applies to both pull requests and issues, and it does NOT apply to Inbox or Watchlist, which intentionally surface only `state:open` priority candidates.

#### Scenario: PR search landing shows state:all

- **WHEN** the user activates PR search with no query
- **THEN** the landing rows MUST come from `search("state:all", browseLimit)`
- **AND** the landing title MUST describe "recent cached PRs" rather than "open PRs"

#### Scenario: Issue search landing shows state:all

- **WHEN** the user activates Issue search with no query
- **THEN** the landing rows MUST come from `searchIssues("state:all", browseLimit)`
- **AND** the landing title MUST describe "recent cached issues" rather than "open issues"

#### Scenario: Inbox landing is unchanged

- **WHEN** the user activates Inbox
- **THEN** the landing rows MUST continue to come from `listPriorityInbox`, which is open-only by design

### Requirement: The planner module MUST be deterministic and unit-testable

The planner MUST be a pure decision function over an input snapshot (rate-limit, freshness watermarks, hot timestamps, backfill cursor, active TUI mode, manual override) and MUST NOT depend on live network calls. This requirement applies to both pull requests and issues.

#### Scenario: Same input yields same decision

- **GIVEN** two planner calls with identical input snapshots
- **WHEN** the planner is invoked
- **THEN** both calls MUST return the same decision

#### Scenario: Planner has no GitHub dependency

- **WHEN** the planner is exercised in tests
- **THEN** it MUST be callable without `GhCliPullRequestDataSource` or any other I/O dependency

### Requirement: The planner integration MUST be disable-able via a runtime feature flag

Setting the environment variable `CLAWLENS_SYNC_PLANNER=off` MUST make `StoreBackedTuiDataService.syncPrs`/`syncIssues` and the CLI `sync`/`sync-issues` commands fall back to today's legacy behavior (`store.sync({ full: false })` and `store.syncIssues({ full: false })`), MUST NOT invoke `selectSyncDecision`, and MUST NOT touch any new meta keys. This requirement applies to both pull requests and issues.

#### Scenario: Flag off bypasses the planner

- **GIVEN** `CLAWLENS_SYNC_PLANNER=off`
- **WHEN** the TUI runs `syncPrs` for any trigger
- **THEN** the system MUST call `store.sync({ full: false })`
- **AND** it MUST NOT call `selectSyncDecision`
- **AND** the returned summary MUST have `mode: "incremental"` or `"full"` exactly as it does today

#### Scenario: Flag off keeps CLI legacy behavior

- **GIVEN** `CLAWLENS_SYNC_PLANNER=off`
- **WHEN** the operator runs `clawlens sync --repo owner/name`
- **THEN** the CLI MUST run the legacy `store.sync({ full: false })` path
- **AND** it MUST NOT touch hot or backfill meta keys

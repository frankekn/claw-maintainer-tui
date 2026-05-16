/**
 * Pure decision function for the TUI/CLI sync planner.
 *
 * Given a deterministic snapshot of rate-limit state, per-entity freshness
 * watermarks, the active TUI mode, and an optional manual override, the
 * planner returns either a `run` decision (with a chosen mode) or a `skip`
 * decision (with a reason).
 *
 * The module is intentionally self-contained: it has no I/O, no `Date.now()`
 * calls (the caller supplies `now`), and no dependency on the rest of the
 * codebase. This makes the planner trivially unit-testable and lets the
 * caller layer in workflow/dispatch concerns on top of a stable contract.
 */

export const RATE_LIMIT_RESERVE = 100;
export const RATE_LIMIT_BACKFILL_FLOOR = 500;
export const STALE_WATERMARK_MS = 15 * 60 * 1000;

export type PlannerEntity = "prs" | "issues";
export type PlannerTrigger = "manual" | "auto";
export type PlannerMode = "hot" | "incremental" | "full" | "backfill";
export type PlannerSkipReason = "rate_limit_reserve" | "already_fresh" | "backfill_complete";
export type PlannerActiveTuiMode =
  | "pr-search"
  | "issue-search"
  | "cross-search"
  | "inbox"
  | "watchlist"
  | null;

export type PlannerRateLimit = { limit: number; remaining: number; resetAt: string } | null;

export type PlannerFreshness = {
  lastSyncAt: string | null;
  lastSyncWatermark: string | null;
  hotSyncAt: string | null;
  backfillCursor: number | null;
  backfillCompletedAt: string | null;
};

export type PlannerSnapshot = {
  entity: PlannerEntity;
  trigger: PlannerTrigger;
  manualOverride: PlannerMode | null;
  rateLimit: PlannerRateLimit;
  freshness: PlannerFreshness;
  activeTuiMode: PlannerActiveTuiMode;
  now: number;
};

export type PlannerDecision =
  | { kind: "run"; mode: PlannerMode; reason: string }
  | { kind: "skip"; reason: PlannerSkipReason };

type Band = "reserve" | "moderate" | "healthy";

const LIST_MODES: ReadonlySet<PlannerActiveTuiMode> = new Set<PlannerActiveTuiMode>([
  "pr-search",
  "issue-search",
  "cross-search",
  "inbox",
  "watchlist",
]);

function computeBand(rateLimit: PlannerRateLimit): Band {
  if (rateLimit === null) {
    return "moderate";
  }
  if (rateLimit.remaining < RATE_LIMIT_RESERVE) {
    return "reserve";
  }
  if (rateLimit.remaining < RATE_LIMIT_BACKFILL_FLOOR) {
    return "moderate";
  }
  return "healthy";
}

function parseIsoMs(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function latestParsedMs(values: ReadonlyArray<string | null>): number | null {
  let latest: number | null = null;
  for (const value of values) {
    const parsed = parseIsoMs(value);
    if (parsed === null) {
      continue;
    }
    latest = latest === null ? parsed : Math.max(latest, parsed);
  }
  return latest;
}

function isListMode(mode: PlannerActiveTuiMode): boolean {
  return LIST_MODES.has(mode);
}

function naturalMode(
  freshness: PlannerFreshness,
  now: number,
): { mode: PlannerMode; watermarkFresh: boolean; bootstrapFresh: boolean } {
  if (freshness.lastSyncWatermark === null) {
    const bootstrapMs = latestParsedMs([freshness.hotSyncAt, freshness.lastSyncAt]);
    const bootstrapFresh = bootstrapMs !== null && now - bootstrapMs <= STALE_WATERMARK_MS;
    return { mode: "hot", watermarkFresh: false, bootstrapFresh };
  }
  const lastSyncMs = parseIsoMs(freshness.lastSyncAt);
  if (lastSyncMs === null) {
    return { mode: "hot", watermarkFresh: false, bootstrapFresh: false };
  }
  const age = now - lastSyncMs;
  if (age <= STALE_WATERMARK_MS) {
    return { mode: "incremental", watermarkFresh: true, bootstrapFresh: false };
  }
  return { mode: "hot", watermarkFresh: false, bootstrapFresh: false };
}

export function selectSyncDecision(input: PlannerSnapshot): PlannerDecision {
  const band = computeBand(input.rateLimit);

  // Reserve band: always skip, even when an explicit override is set.
  if (band === "reserve") {
    return { kind: "skip", reason: "rate_limit_reserve" };
  }

  const { manualOverride, freshness, activeTuiMode } = input;

  // Manual override path. Reserve has already been handled above.
  if (manualOverride !== null) {
    if (manualOverride === "backfill" && freshness.backfillCompletedAt !== null) {
      return { kind: "skip", reason: "backfill_complete" };
    }
    if (manualOverride === "hot") {
      return { kind: "run", mode: "hot", reason: "manual_override_hot" };
    }
    if (manualOverride === "incremental") {
      return { kind: "run", mode: "incremental", reason: "manual_override_incremental" };
    }
    if (manualOverride === "full" && band === "healthy") {
      return { kind: "run", mode: "full", reason: "manual_override_full" };
    }
    if (manualOverride === "backfill" && band === "healthy") {
      return { kind: "run", mode: "backfill", reason: "manual_override_backfill" };
    }
    // Override was not honored by the current band (e.g. moderate band blocks
    // `full` and `backfill`). Fall through to the natural-mode logic so the
    // planner still schedules useful work.
  }

  const natural = naturalMode(freshness, input.now);

  // Backfill consideration replaces a natural `incremental` decision when
  // quota is healthy, the completion sentinel is null, the watermark is fresh,
  // and we are not on a list mode (those views prefer freshening visible rows
  // first). It also follows a recent bootstrap hot pass even without a
  // watermark, because dispatching `incremental` would silently become a full
  // sync while dispatching `hot` again would loop forever. A null cursor is
  // still open and starts at page 1.
  const canConsiderBackfill =
    ((natural.mode === "incremental" && natural.watermarkFresh && !isListMode(activeTuiMode)) ||
      natural.bootstrapFresh) &&
    band === "healthy" &&
    freshness.backfillCompletedAt === null;

  if (canConsiderBackfill) {
    return {
      kind: "run",
      mode: "backfill",
      reason: natural.bootstrapFresh ? "bootstrap_backfill" : "natural_backfill",
    };
  }

  if (natural.bootstrapFresh) {
    return { kind: "skip", reason: "already_fresh" };
  }

  const reason =
    natural.mode === "incremental"
      ? "natural_incremental"
      : freshness.lastSyncWatermark === null
        ? "natural_hot_bootstrap"
        : "natural_hot_stale";

  return { kind: "run", mode: natural.mode, reason };
}

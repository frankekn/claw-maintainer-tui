import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { StoreBackedTuiDataService } from "./data-service.js";
import type { PrIndexStore } from "../store.js";
import type { GhCliPullRequestDataSource } from "../github.js";
import type { RepoRef, StatusSnapshot, SyncSummary } from "../types.js";

type FakeStoreCalls = {
  sync: Array<{ full: boolean; hydrateAll: boolean }>;
  syncIssues: Array<{ full: boolean }>;
  syncHotPullRequests: number;
  syncHotIssues: number;
  runBackfillSlice: Array<{ entity: "prs" | "issues" }>;
};

type RateLimitSnapshot = Awaited<ReturnType<GhCliPullRequestDataSource["getRateLimitStatus"]>>;
type FakeSource = GhCliPullRequestDataSource & { rateLimitCalls: number };

const baseStatus: StatusSnapshot = {
  repo: "openclaw/openclaw",
  lastSyncAt: null,
  lastSyncWatermark: null,
  issueLastSyncAt: null,
  issueLastSyncWatermark: null,
  prHotSyncAt: null,
  issueHotSyncAt: null,
  prBackfillCursor: null,
  prBackfillCompletedAt: null,
  issueBackfillCursor: null,
  issueBackfillCompletedAt: null,
  prCount: 0,
  issueCount: 0,
  labelCount: 0,
  issueLabelCount: 0,
  commentCount: 0,
  docCount: 0,
  vectorEnabled: false,
  vectorAvailable: false,
  embeddingModel: "test",
};

const REPO: RepoRef = { owner: "openclaw", name: "openclaw" };

function makeFakeStore(options?: {
  status?: StatusSnapshot;
  syncResult?: SyncSummary;
  syncIssuesResult?: SyncSummary;
  hotPrsResult?: SyncSummary;
  hotIssuesResult?: SyncSummary;
  backfillResult?: SyncSummary;
}): { store: PrIndexStore; calls: FakeStoreCalls } {
  const calls: FakeStoreCalls = {
    sync: [],
    syncIssues: [],
    syncHotPullRequests: 0,
    syncHotIssues: 0,
    runBackfillSlice: [],
  };
  const defaultSummary = (mode: SyncSummary["mode"], entity: "prs" | "issues"): SyncSummary => ({
    mode,
    entity,
    repo: "openclaw/openclaw",
    processedPrs: 0,
    processedIssues: 0,
    skippedPrs: 0,
    skippedIssues: 0,
    docCount: 0,
    commentCount: 0,
    labelCount: 0,
    vectorAvailable: false,
    lastSyncAt: null,
    lastSyncWatermark: null,
  });
  const store = {
    status: async () => options?.status ?? baseStatus,
    sync: async (params: { full?: boolean; hydrateAll?: boolean }) => {
      calls.sync.push({ full: params.full ?? false, hydrateAll: params.hydrateAll ?? false });
      return options?.syncResult ?? defaultSummary("incremental", "prs");
    },
    syncIssues: async (params: { full?: boolean }) => {
      calls.syncIssues.push({ full: params.full ?? false });
      return options?.syncIssuesResult ?? defaultSummary("incremental", "issues");
    },
    syncHotPullRequests: async () => {
      calls.syncHotPullRequests += 1;
      return options?.hotPrsResult ?? defaultSummary("hot", "prs");
    },
    syncHotIssues: async () => {
      calls.syncHotIssues += 1;
      return options?.hotIssuesResult ?? defaultSummary("hot", "issues");
    },
    runBackfillSlice: async (params: { entity: "prs" | "issues" }) => {
      calls.runBackfillSlice.push({ entity: params.entity });
      return (
        options?.backfillResult ?? {
          ...defaultSummary("backfill", params.entity),
          nextBackfillCursor: 2,
        }
      );
    },
  } as unknown as PrIndexStore;
  return { store, calls };
}

function makeFakeSource(rateLimit: RateLimitSnapshot): FakeSource {
  const source = {
    rateLimitCalls: 0,
    getRateLimitStatus: async () => {
      source.rateLimitCalls += 1;
      return rateLimit;
    },
  } as unknown as FakeSource;
  return source;
}

describe("StoreBackedTuiDataService planner dispatch", () => {
  beforeEach(() => {
    delete process.env.CLAWLENS_SYNC_PLANNER;
  });
  afterEach(() => {
    delete process.env.CLAWLENS_SYNC_PLANNER;
  });

  it("routes PR sync through the planner when CLAWLENS_SYNC_PLANNER is unset", async () => {
    // No watermark → planner returns hot (bootstrap)
    const { store, calls } = makeFakeStore();
    const source = makeFakeSource({
      limit: 5000,
      remaining: 4500,
      resetAt: "2026-03-12T09:00:00.000Z",
    });
    const service = new StoreBackedTuiDataService(store, source, REPO);
    const summary = await service.syncPrs();
    expect(calls.syncHotPullRequests).toBe(1);
    expect(calls.sync).toEqual([]);
    expect(summary.mode).toBe("hot");
  });

  it("routes issue sync through the planner when CLAWLENS_SYNC_PLANNER is unset", async () => {
    const { store, calls } = makeFakeStore();
    const source = makeFakeSource({
      limit: 5000,
      remaining: 4500,
      resetAt: "2026-03-12T09:00:00.000Z",
    });
    const service = new StoreBackedTuiDataService(store, source, REPO);
    const summary = await service.syncIssues();
    expect(calls.syncHotIssues).toBe(1);
    expect(calls.syncIssues).toEqual([]);
    expect(summary.mode).toBe("hot");
  });

  it("keeps rateLimit cached for UI display calls", async () => {
    const { store } = makeFakeStore();
    const source = makeFakeSource({
      limit: 5000,
      remaining: 4500,
      resetAt: "2026-03-12T09:00:00.000Z",
    });
    const service = new StoreBackedTuiDataService(store, source, REPO);
    await service.rateLimit();
    await service.rateLimit();
    expect(source.rateLimitCalls).toBe(1);
  });

  it("fetches fresh rate limits for consecutive planner-backed PR and issue syncs", async () => {
    const { store } = makeFakeStore();
    const source = makeFakeSource({
      limit: 5000,
      remaining: 4500,
      resetAt: "2026-03-12T09:00:00.000Z",
    });
    const service = new StoreBackedTuiDataService(store, source, REPO);
    await service.syncPrs();
    await service.syncIssues();
    expect(source.rateLimitCalls).toBe(2);
  });

  it("synthesizes a skipped summary when the planner returns skip (rate limit reserve)", async () => {
    const { store, calls } = makeFakeStore();
    const source = makeFakeSource({
      limit: 5000,
      remaining: 10,
      resetAt: "2026-03-12T09:00:00.000Z",
    });
    const service = new StoreBackedTuiDataService(store, source, REPO);
    const summary = await service.syncPrs();
    expect(summary.mode).toBe("skipped");
    expect(summary.reason).toBe("rate_limit_reserve");
    expect(summary.lastSyncAt).toBeNull();
    expect(summary.lastSyncWatermark).toBeNull();
    expect(summary.repo).toBe("openclaw/openclaw");
    expect(calls.sync).toEqual([]);
    expect(calls.syncHotPullRequests).toBe(0);
  });

  it("dispatches backfill when watermark is fresh with an open null cursor and healthy quota", async () => {
    const now = Date.now();
    const fresh = new Date(now - 60_000).toISOString();
    const { store, calls } = makeFakeStore({
      status: {
        ...baseStatus,
        lastSyncAt: fresh,
        lastSyncWatermark: fresh,
      },
    });
    const source = makeFakeSource({
      limit: 5000,
      remaining: 4500,
      resetAt: "2026-03-12T09:00:00.000Z",
    });
    const service = new StoreBackedTuiDataService(store, source, REPO);
    const summary = await service.syncPrs();
    expect(summary.mode).toBe("backfill");
    expect(calls.runBackfillSlice).toEqual([{ entity: "prs" }]);
    expect(calls.sync).toEqual([]);
    expect(calls.syncHotPullRequests).toBe(0);
  });

  it("dispatches incremental when watermark is fresh but quota is moderate", async () => {
    const now = Date.now();
    const fresh = new Date(now - 60_000).toISOString();
    const { store, calls } = makeFakeStore({
      status: {
        ...baseStatus,
        lastSyncAt: fresh,
        lastSyncWatermark: fresh,
      },
    });
    const source = makeFakeSource({
      limit: 5000,
      remaining: 200,
      resetAt: "2026-03-12T09:00:00.000Z",
    });
    const service = new StoreBackedTuiDataService(store, source, REPO);
    const summary = await service.syncPrs();
    expect(summary.mode).toBe("incremental");
    expect(calls.sync).toEqual([{ full: false, hydrateAll: false }]);
    expect(calls.runBackfillSlice).toEqual([]);
    expect(calls.syncHotPullRequests).toBe(0);
  });

  it("passes active TUI mode into the planner so list views defer backfill", async () => {
    const fresh = new Date(Date.now() - 60_000).toISOString();
    const statusWithOpenBackfill = {
      ...baseStatus,
      lastSyncAt: fresh,
      lastSyncWatermark: fresh,
      prBackfillCursor: 7,
    };
    const source = makeFakeSource({
      limit: 5000,
      remaining: 4500,
      resetAt: "2026-03-12T09:00:00.000Z",
    });

    const nonList = makeFakeStore({ status: statusWithOpenBackfill });
    await new StoreBackedTuiDataService(nonList.store, source, REPO).syncPrs();
    expect(nonList.calls.runBackfillSlice).toEqual([{ entity: "prs" }]);
    expect(nonList.calls.sync).toEqual([]);

    const listMode = makeFakeStore({ status: statusWithOpenBackfill });
    await new StoreBackedTuiDataService(listMode.store, source, REPO).syncPrs({
      activeTuiMode: "pr-search",
    });
    expect(listMode.calls.sync).toEqual([{ full: false, hydrateAll: false }]);
    expect(listMode.calls.runBackfillSlice).toEqual([]);
  });

  it("falls back to legacy store.sync when CLAWLENS_SYNC_PLANNER='off'", async () => {
    process.env.CLAWLENS_SYNC_PLANNER = "off";
    const { store, calls } = makeFakeStore();
    const source = makeFakeSource({
      limit: 5000,
      remaining: 10,
      resetAt: "2026-03-12T09:00:00.000Z",
    });
    const service = new StoreBackedTuiDataService(store, source, REPO);
    const summary = await service.syncPrs();
    expect(calls.sync).toEqual([{ full: false, hydrateAll: false }]);
    expect(calls.syncHotPullRequests).toBe(0);
    expect(summary.mode).toBe("incremental");
  });

  it("falls back to legacy store.syncIssues when CLAWLENS_SYNC_PLANNER='off'", async () => {
    process.env.CLAWLENS_SYNC_PLANNER = "off";
    const { store, calls } = makeFakeStore();
    const source = makeFakeSource({
      limit: 5000,
      remaining: 10,
      resetAt: "2026-03-12T09:00:00.000Z",
    });
    const service = new StoreBackedTuiDataService(store, source, REPO);
    const summary = await service.syncIssues();
    expect(calls.syncIssues).toEqual([{ full: false }]);
    expect(calls.syncHotIssues).toBe(0);
    expect(summary.mode).toBe("incremental");
  });
});

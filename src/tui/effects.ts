import type {
  IssueSearchResult,
  PrContextBundle,
  SearchResult,
  StatusSnapshot,
  SyncProgressEvent,
  SyncSummary,
} from "../types.js";
import type { TuiDataService } from "./types.js";

export class TuiEffects {
  constructor(private readonly service: TuiDataService) {}

  status(): Promise<StatusSnapshot> {
    return this.service.status();
  }

  rateLimit() {
    return this.service.rateLimit();
  }

  listPriorityQueue(options: { limit: number; scanLimit?: number }) {
    return this.service.listPriorityQueue(options);
  }

  listWatchlist(limit: number) {
    return this.service.listWatchlist(limit);
  }

  search(query: string, limit: number): Promise<SearchResult[]> {
    return this.service.search(query, limit);
  }

  searchIssues(query: string, limit: number): Promise<IssueSearchResult[]> {
    return this.service.searchIssues(query, limit);
  }

  getPrContextBundle(prNumber: number): Promise<PrContextBundle | null> {
    return this.service.getPrContextBundle(prNumber);
  }

  showIssue(issueNumber: number): Promise<IssueSearchResult | null> {
    return this.service.showIssue(issueNumber);
  }

  setPrAttentionState(prNumber: number, state: "seen" | "watch" | "ignore" | null) {
    return this.service.setPrAttentionState(prNumber, state);
  }

  syncPrs(options?: { onProgress?: (event: SyncProgressEvent) => void }): Promise<SyncSummary> {
    return this.service.syncPrs(options);
  }

  syncIssues(options?: { onProgress?: (event: SyncProgressEvent) => void }): Promise<SyncSummary> {
    return this.service.syncIssues(options);
  }

  refreshPrDetail(prNumber: number): Promise<void> {
    return this.service.refreshPrDetail(prNumber);
  }

  refreshIssueDetail(issueNumber: number): Promise<void> {
    return this.service.refreshIssueDetail(issueNumber);
  }
}

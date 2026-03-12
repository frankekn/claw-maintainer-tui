import { GhCliPullRequestDataSource } from "../github.js";
import { ensurePullRequestFacts } from "../pr-facts.js";
import { PrIndexStore } from "../store.js";
import type { RepoRef } from "../types.js";
import type { TuiDataService } from "./types.js";

export class StoreBackedTuiDataService implements TuiDataService {
  constructor(
    private readonly store: PrIndexStore,
    private readonly source: GhCliPullRequestDataSource,
    private readonly repo: RepoRef,
  ) {}

  status() {
    return this.store.status();
  }

  search(query: string, limit: number) {
    return this.store.search(query, limit);
  }

  searchIssues(query: string, limit: number) {
    return this.store.searchIssues(query, limit);
  }

  show(prNumber: number) {
    return this.store.show(prNumber);
  }

  showIssue(issueNumber: number) {
    return this.store.showIssue(issueNumber);
  }

  xrefIssue(issueNumber: number, limit: number) {
    return this.store.crossReferenceIssueToPullRequests(issueNumber, limit);
  }

  xrefPr(prNumber: number, limit: number) {
    return this.store.crossReferencePullRequestToIssues(prNumber, limit);
  }

  clusterPr(prNumber: number, limit: number) {
    return this.store.clusterPullRequest({
      prNumber,
      limit,
      ftsOnly: true,
      repo: this.repo,
      source: this.source,
    });
  }

  syncPrs() {
    return this.store.sync({
      repo: this.repo,
      source: this.source,
      full: false,
      hydrateAll: false,
    });
  }

  syncIssues() {
    return this.store.syncIssues({
      repo: this.repo,
      source: this.source,
      full: false,
    });
  }

  async refreshPrFacts(prNumber: number) {
    await ensurePullRequestFacts(this.store, this.source, this.repo, prNumber, true);
  }
}

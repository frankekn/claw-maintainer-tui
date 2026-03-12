import { GhCliPullRequestDataSource } from "./github.js";
import { PrIndexStore } from "./store.js";
import type { RepoRef } from "./types.js";

export async function ensurePullRequestFacts(
  store: PrIndexStore,
  source: GhCliPullRequestDataSource,
  repo: RepoRef,
  prNumber: number,
  refresh: boolean,
): Promise<void> {
  if (!refresh) {
    const existing = await store.getPullRequestFacts(prNumber);
    if (existing) {
      return;
    }
  }
  const facts = await source.fetchPullRequestFacts(repo, prNumber);
  await store.recordPullRequestFacts(facts);
}

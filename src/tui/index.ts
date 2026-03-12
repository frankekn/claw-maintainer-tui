import { GhCliPullRequestDataSource, parseRepoRef } from "../github.js";
import { PrIndexStore } from "../store.js";
import { BlessedTuiRenderer } from "./blessed-renderer.js";
import { TuiController } from "./controller.js";
import { StoreBackedTuiDataService } from "./data-service.js";

export async function runTui(params: {
  repo: string;
  dbPath: string;
  ftsOnly: boolean;
}): Promise<void> {
  const repoRef = parseRepoRef(params.repo);
  const store = new PrIndexStore({
    dbPath: params.dbPath,
    enableVector: !params.ftsOnly,
  });
  const source = new GhCliPullRequestDataSource();
  const service = new StoreBackedTuiDataService(store, source, repoRef);
  const controller = new TuiController(service, {
    repo: params.repo,
    dbPath: params.dbPath,
    ftsOnly: params.ftsOnly,
  });
  const renderer = new BlessedTuiRenderer(controller);
  await renderer.run();
}

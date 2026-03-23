import {
  buildDetailPaneModel,
  defaultSecondaryHintText,
  formatResultsPaneModel,
} from "./format.js";
import { TUI_MODE_ORDER } from "./types.js";
import type {
  TuiAction,
  TuiDetailState,
  TuiListSummary,
  TuiRateLimitSnapshot,
  TuiRenderModel,
  TuiSessionState,
  TuiSyncJobSnapshot,
  TuiSyncMode,
} from "./types.js";
import type { StatusSnapshot } from "../types.js";

type PresenterOptions = {
  repo: string;
  dbPath: string;
  ftsOnly: boolean;
  status: StatusSnapshot | null;
  rateLimit: TuiRateLimitSnapshot | null;
  syncMode: TuiSyncMode | null;
  syncJobs: TuiSyncJobSnapshot[];
  detailAutoRefreshInFlight: boolean;
  busyMessage: string | null;
  errorMessage: string | null;
  actions: TuiAction[];
  listSummary: TuiListSummary | null;
  canLoadMore: boolean;
};

export function buildRenderModel(
  session: TuiSessionState,
  detail: TuiDetailState,
  options: PresenterOptions,
): TuiRenderModel {
  const modeInfo = TUI_MODE_ORDER.find((mode) => mode.id === session.mode)!;
  const resultsPane = formatResultsPaneModel({
    mode: session.mode,
    title: session.resultTitle,
    rows: session.rows,
    selectedIndex: session.selectedIndex,
    focus: session.focus,
    summary: options.listSummary,
    message: session.errorMessage ?? session.message,
  });
  const detailPane = buildDetailPaneModel({
    payload: detail.payload,
    visible: detail.visible,
    status: detail.status,
    identity: detail.identity,
    anchorKey: detail.anchorKey,
    focusSection: detail.focusSection,
  });
  return {
    header: {
      repo: options.repo,
      dbPath: options.dbPath,
      activeModeLabel: modeInfo.label,
      ftsOnly: options.ftsOnly,
      status: options.status,
      rateLimit: options.rateLimit,
      syncMode: options.syncMode,
      syncJobs: options.syncJobs,
      detailAutoRefreshInFlight: options.detailAutoRefreshInFlight,
      busyMessage: options.busyMessage,
      errorMessage: session.errorMessage ?? options.errorMessage,
    },
    footer: {
      hintText: defaultSecondaryHintText(session.mode, options.canLoadMore),
      message: session.errorMessage ?? session.message,
      queryPrompt: modeInfo.queryPrompt,
      queryValue: session.query,
      actions: options.actions,
      autoUpdateHint: "auto-update every 5m when idle",
    },
    mode: session.mode,
    focus: session.focus,
    layoutMode: detail.visible ? "split-pane" : "single-pane",
    resultsPane,
    detailPane,
    activeUrl: session.activeUrl,
    query: session.query,
    context: session.context,
    queryPlaceholder: modeInfo.queryPrompt,
    busy: options.busyMessage !== null,
  };
}

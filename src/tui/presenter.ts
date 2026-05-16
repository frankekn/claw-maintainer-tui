import { buildDetailPaneModel, formatResultsPaneModel } from "./format.js";
import { DETAIL_WIDTH_PRESETS, TUI_MODE_ORDER } from "./types.js";
import type {
  TuiAction,
  TuiBanner,
  TuiDetailState,
  TuiHelpOverlayModel,
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

function buildGlobalKeys(): TuiAction[] {
  return [
    { id: "detail", label: "Mode", shortcut: "\u2190/\u2192", enabled: true },
    { id: "detail", label: "Jump", shortcut: "1-6", enabled: true },
    { id: "detail", label: "Focus", shortcut: "Tab", enabled: true },
    { id: "detail", label: "Zoom", shortcut: "z", enabled: true },
    { id: "detail", label: "Resize", shortcut: "[ ]", enabled: true },
    { id: "detail", label: "Fold", shortcut: "Space", enabled: true },
    { id: "detail", label: "Help", shortcut: "?", enabled: true },
    { id: "detail", label: "Quit", shortcut: "q", enabled: true },
  ];
}

function buildBanner(session: TuiSessionState, options: PresenterOptions): TuiBanner | null {
  if (session.bannerHidden) {
    return null;
  }
  if (options.busyMessage) {
    return {
      tone: "warn",
      message: `[REFRESHING] ${options.busyMessage}`,
      actions: ["Esc dismiss"],
      dismissible: true,
    };
  }
  if (session.errorMessage ?? options.errorMessage) {
    return {
      tone: "error",
      message: `[ERROR] ${session.errorMessage ?? options.errorMessage}`,
      actions: ["Esc dismiss"],
      dismissible: true,
    };
  }
  return session.banner;
}

function isSearchMode(session: TuiSessionState): boolean {
  return (
    session.mode === "cross-search" ||
    session.mode === "pr-search" ||
    session.mode === "issue-search"
  );
}

function percentRatio(value: string): number {
  if (!value.endsWith("%")) {
    return 1;
  }
  const parsed = Number(value.slice(0, -1));
  if (!Number.isFinite(parsed)) {
    return 1;
  }
  return parsed / 100;
}

function resultLineWidth(session: TuiSessionState, detailVisible: boolean): number {
  const widthPreset = DETAIL_WIDTH_PRESETS[session.detailWidthIndex] ?? DETAIL_WIDTH_PRESETS[0];
  let ratio = 1;
  if (detailVisible && session.detailLayoutMode === "split-pane") {
    ratio = percentRatio(widthPreset.results);
  }
  return Math.max(40, Math.floor(session.terminalColumns * ratio) - 4);
}

function footerPlaceholder(
  session: TuiSessionState,
  modeInfo: (typeof TUI_MODE_ORDER)[number],
): string {
  if (session.focus === "query") {
    return "";
  }
  if (isSearchMode(session)) {
    return "Press / to search";
  }
  return modeInfo.browsePrompt;
}

function footerActionPriority(action: TuiAction): number {
  switch (action.id) {
    case "undo":
      return 0;
    case "query":
      return 1;
    case "detail":
      return 2;
    case "load-more":
      return 3;
    case "expand-cluster":
      return 4;
    case "cluster":
      return 5;
    case "mark-seen":
      return 6;
    case "refresh":
      return 7;
    case "back":
      return 8;
    case "sync-prs":
      return 9;
    case "sync-issues":
      return 10;
    case "open-url":
      return 11;
    case "jump-linked-issues":
      return 12;
    case "toggle-watch":
      return 13;
    case "toggle-ignore":
      return 14;
    case "clear-state":
      return 15;
    case "mark-page-seen":
      return 16;
    default:
      return 99;
  }
}

function buildFooterActions(actions: TuiAction[]): TuiAction[] {
  return actions
    .filter((action) => action.enabled)
    .map((action, index) => ({ action, index }))
    .sort((left, right) => {
      const priorityDiff = footerActionPriority(left.action) - footerActionPriority(right.action);
      return priorityDiff === 0 ? left.index - right.index : priorityDiff;
    })
    .slice(0, 4)
    .map((entry) => entry.action);
}

function buildHelpOverlay(
  session: TuiSessionState,
  actions: TuiAction[],
  globalKeys: TuiAction[],
): TuiHelpOverlayModel {
  const modeInfo = TUI_MODE_ORDER.find((mode) => mode.id === session.mode)!;
  const modeActions = actions.filter((action) => action.enabled);
  const queryHints =
    modeInfo.queryFilters.length > 0
      ? [`Filters: ${modeInfo.queryFilters.join("  ")}`]
      : ["This desk is browse-only."];
  const nextSteps =
    session.mode === "inbox" || session.mode === "watchlist"
      ? [
          "Next steps",
          "- Review the current queue.",
          "- Press Enter to inspect the selected row.",
          "- Use v/w/i/u to manage local triage.",
        ]
      : session.mode === "status"
        ? [
            "Next steps",
            "- Use s / S to refresh PR or issue metadata.",
            "- Watch the header for sync health.",
          ]
        : [
            "Next steps",
            "- Press / to enter a query.",
            `- Example: ${modeInfo.queryExamples[0] ?? "state:open"}`,
            "- Press Enter to inspect the selected result.",
          ];
  const lines = [
    "GLOBAL",
    ...globalKeys.map((action) => `- [${action.shortcut}] ${action.label}`),
    "",
    `CURRENT MODE · ${modeInfo.label.toUpperCase()}`,
    ...modeActions.map((action) => `- [${action.shortcut}] ${action.label}`),
    "",
    ...queryHints,
    "",
    ...nextSteps,
    "",
    "LEGEND",
    "- I = linked issues",
    "- R = related PRs",
    "- D = draft",
    "- M = maintainer",
    "- V = mark visible page seen",
    "- U = undo",
  ];
  return {
    visible: session.helpVisible,
    title: `${modeInfo.label} Help`,
    lines,
  };
}

export function buildRenderModel(
  session: TuiSessionState,
  detail: TuiDetailState,
  options: PresenterOptions,
): TuiRenderModel {
  const modeInfo = TUI_MODE_ORDER.find((mode) => mode.id === session.mode)!;
  const widthPreset = DETAIL_WIDTH_PRESETS[session.detailWidthIndex] ?? DETAIL_WIDTH_PRESETS[0];
  const layoutMode = detail.visible ? session.detailLayoutMode : "single-pane";
  const resultsPane = formatResultsPaneModel({
    mode: session.mode,
    title: session.resultTitle,
    rows: session.rows,
    selectedIndex: session.selectedIndex,
    focus: session.focus,
    summary: options.listSummary,
    message: session.errorMessage ?? session.message,
    isLandingView: session.isLandingView,
    status: options.status,
    lineWidth: resultLineWidth(session, detail.visible),
  });
  const detailPane = buildDetailPaneModel({
    payload: detail.payload,
    visible: detail.visible,
    status: detail.status,
    identity: detail.identity,
    anchorKey: detail.anchorKey,
    focusSection: detail.focusSection,
    foldedSections: detail.foldedSections,
  });
  const globalKeys = buildGlobalKeys();
  const banner = buildBanner(session, options);
  const queryHelpText =
    session.focus === "query" && modeInfo.queryFilters.length > 0
      ? `filters: ${modeInfo.queryFilters.join("  ")}  keys: [Enter] search  [\u2191\u2193] history  [Esc] cancel`
      : modeInfo.queryExamples.length > 0
        ? `example: ${modeInfo.queryExamples[0]}`
        : "";
  const inputKind = session.focus === "query" ? "query" : "command";
  const queryPlaceholder = footerPlaceholder(session, modeInfo);
  const footerActions = buildFooterActions(options.actions);

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
      hintText: queryHelpText,
      message: session.errorMessage ?? session.message,
      banner,
      inputKind,
      queryPrompt: session.focus === "query" ? modeInfo.queryPrompt : modeInfo.label,
      queryValue: session.query,
      queryCursorIndex:
        session.queryState[session.mode as "cross-search" | "pr-search" | "issue-search"]
          ?.cursorIndex ?? session.query.length,
      queryPlaceholder,
      queryHelpText,
      actions: footerActions,
      keys: globalKeys,
      autoUpdateHint: "auto-update every 5m when idle",
    },
    helpOverlay: buildHelpOverlay(session, options.actions, globalKeys),
    mode: session.mode,
    focus: session.focus,
    layoutMode,
    resultsWidth:
      layoutMode === "split-pane"
        ? widthPreset.results
        : layoutMode === "detail-fullscreen"
          ? "0%"
          : "100%",
    detailWidth:
      layoutMode === "split-pane"
        ? widthPreset.detail
        : layoutMode === "detail-fullscreen"
          ? "100%"
          : "0%",
    resultsPane,
    detailPane,
    activeUrl: session.activeUrl,
    query: session.query,
    context: session.context,
    busy: options.busyMessage !== null,
  };
}

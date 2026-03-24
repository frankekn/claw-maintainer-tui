import type { StatusSnapshot } from "../types.js";
import type {
  TuiDetailState,
  TuiFocus,
  TuiMode,
  TuiSessionState,
  TuiViewSnapshot,
} from "./types.js";

export function createInitialSessionState(resultLimit: number): TuiSessionState {
  return {
    mode: "inbox",
    focus: "results",
    rows: [],
    selectedIndex: 0,
    activeUrl: null,
    query: "",
    queryState: {
      "cross-search": { value: "", history: [], historyIndex: null },
      "pr-search": { value: "", history: [], historyIndex: null },
      "issue-search": { value: "", history: [], historyIndex: null },
    },
    context: null,
    resultTitle: "Inbox",
    message: "Loading Inbox...",
    errorMessage: null,
    browseLimit: resultLimit,
    isLandingView: false,
    banner: null,
    bannerHidden: false,
    helpVisible: false,
    lastAttentionMutation: null,
    history: [],
  };
}

export function createLandingDetailState(
  mode: TuiMode,
  status: StatusSnapshot | null,
): TuiDetailState {
  return {
    visible: false,
    payload: mode === "status" ? { kind: "status", status } : { kind: "landing", mode, status },
    status: null,
    identity: mode === "status" ? "status" : `landing:${mode}`,
    focusSection: null,
    anchorKey: null,
  };
}

export function availableFocuses(session: TuiSessionState, detail: TuiDetailState): TuiFocus[] {
  const focuses: TuiFocus[] = ["results"];
  if (detail.visible) {
    focuses.push("detail");
  }
  if (
    session.mode === "cross-search" ||
    session.mode === "pr-search" ||
    session.mode === "issue-search"
  ) {
    focuses.push("query");
  }
  return focuses;
}

export function createViewSnapshot(
  session: TuiSessionState,
  detail: TuiDetailState,
): TuiViewSnapshot {
  return {
    session: {
      mode: session.mode,
      focus: session.focus,
      rows: session.rows,
      selectedIndex: session.selectedIndex,
      activeUrl: session.activeUrl,
      query: session.query,
      context: session.context,
      resultTitle: session.resultTitle,
      message: session.message,
      errorMessage: session.errorMessage,
      browseLimit: session.browseLimit,
      isLandingView: session.isLandingView,
      queryState: session.queryState,
      banner: session.banner,
      bannerHidden: session.bannerHidden,
      helpVisible: session.helpVisible,
      lastAttentionMutation: session.lastAttentionMutation,
    },
    detail: {
      visible: detail.visible,
      payload: detail.payload,
      status: detail.status,
      identity: detail.identity,
      focusSection: detail.focusSection,
      anchorKey: detail.anchorKey,
    },
  };
}

import type blessed from "blessed";
import { describe, expect, it } from "vitest";
import { resolveKeyAction } from "./keymap.js";
import type { TuiRenderModel } from "./types.js";

function makeModel(overrides: Partial<TuiRenderModel> = {}): TuiRenderModel {
  return {
    header: {
      repo: "openclaw/openclaw",
      dbPath: "/tmp/clawlens.sqlite",
      activeModeLabel: "Inbox",
      ftsOnly: false,
      status: null,
      rateLimit: null,
      syncMode: null,
      syncJobs: [],
      detailAutoRefreshInFlight: false,
      busyMessage: null,
      errorMessage: null,
    },
    footer: {
      hintText: "",
      message: "Ready.",
      banner: null,
      queryPrompt: "Inbox",
      queryValue: "",
      queryCursorIndex: 0,
      queryPlaceholder: "Browse-only mode",
      queryHelpText: "Browse-only mode",
      actions: [],
      keys: [],
      autoUpdateHint: null,
    },
    helpOverlay: {
      visible: false,
      title: "Inbox Help",
      lines: [],
    },
    mode: "inbox",
    focus: "results",
    layoutMode: "single-pane",
    resultsWidth: "100%",
    detailWidth: "0%",
    resultsPane: {
      title: "Inbox",
      summary: null,
      rows: [],
      selectedIndex: 0,
      lines: [],
    },
    detailPane: {
      visible: false,
      title: "Start Here",
      status: null,
      lines: [],
      identity: null,
      anchorLine: null,
      anchorKey: null,
    },
    activeUrl: null,
    query: "",
    context: null,
    busy: false,
    ...overrides,
  };
}

function key(name: string, ch = "", shift = false): blessed.Widgets.Events.IKeyEventArg {
  return { name, ch, shift } as unknown as blessed.Widgets.Events.IKeyEventArg;
}

describe("resolveKeyAction", () => {
  it("maps q to confirm_quit in results focus", () => {
    const action = resolveKeyAction(makeModel(), "q", key("q", "q"));
    expect(action).toEqual({ kind: "command", command: { type: "confirm_quit" } });
  });

  it("maps q to confirm_quit in help overlay", () => {
    const action = resolveKeyAction(
      makeModel({ helpOverlay: { visible: true, title: "Help", lines: [] } }),
      "q",
      key("q", "q"),
    );
    expect(action).toEqual({ kind: "command", command: { type: "confirm_quit" } });
  });

  it("maps escape to escape in results focus", () => {
    const action = resolveKeyAction(makeModel(), "", key("escape"));
    expect(action).toEqual({ kind: "command", command: { type: "escape" } });
  });

  it("maps escape to stop_query in query focus", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", key("escape"));
    expect(action).toEqual({ kind: "command", command: { type: "stop_query" } });
  });

  it("maps escape to escape command in detail focus", () => {
    const action = resolveKeyAction(
      makeModel({ focus: "detail", detailPane: { ...makeModel().detailPane, visible: true } }),
      "",
      key("escape"),
    );
    expect(action).toEqual({ kind: "command", command: { type: "escape" } });
  });

  it("maps escape to toggle_help in help overlay", () => {
    const action = resolveKeyAction(
      makeModel({ helpOverlay: { visible: true, title: "Help", lines: [] } }),
      "",
      key("escape"),
    );
    expect(action).toEqual({ kind: "command", command: { type: "toggle_help" } });
  });

  it("maps escape to dismiss_banner when banner is dismissible", () => {
    const action = resolveKeyAction(
      makeModel({
        footer: {
          ...makeModel().footer,
          banner: { tone: "warn", message: "Banner", actions: [], dismissible: true },
        },
      }),
      "",
      key("escape"),
    );
    expect(action).toEqual({ kind: "command", command: { type: "dismiss_banner" } });
  });

  it("maps left to move_query_cursor_left in query focus", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", key("left"));
    expect(action).toEqual({ kind: "command", command: { type: "move_query_cursor_left" } });
  });

  it("maps right to move_query_cursor_right in query focus", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", key("right"));
    expect(action).toEqual({ kind: "command", command: { type: "move_query_cursor_right" } });
  });

  it("maps home to move_query_cursor_home in query focus", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", key("home"));
    expect(action).toEqual({ kind: "command", command: { type: "move_query_cursor_home" } });
  });

  it("maps end to move_query_cursor_end in query focus", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", key("end"));
    expect(action).toEqual({ kind: "command", command: { type: "move_query_cursor_end" } });
  });

  it("maps delete to backspace_query in query focus (terminal compatibility)", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", key("delete"));
    expect(action).toEqual({ kind: "command", command: { type: "backspace_query" } });
  });

  it("maps ctrl+a to move_query_cursor_home in query focus", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", {
      name: "a",
      ctrl: true,
    } as unknown as blessed.Widgets.Events.IKeyEventArg);
    expect(action).toEqual({ kind: "command", command: { type: "move_query_cursor_home" } });
  });

  it("maps ctrl+e to move_query_cursor_end in query focus", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", {
      name: "e",
      ctrl: true,
    } as unknown as blessed.Widgets.Events.IKeyEventArg);
    expect(action).toEqual({ kind: "command", command: { type: "move_query_cursor_end" } });
  });

  it("maps ctrl+u to clear_query in query focus", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", {
      name: "u",
      ctrl: true,
    } as unknown as blessed.Widgets.Events.IKeyEventArg);
    expect(action).toEqual({ kind: "command", command: { type: "clear_query" } });
  });

  it("maps ctrl+w to delete_query_word in query focus", () => {
    const action = resolveKeyAction(makeModel({ focus: "query" }), "", {
      name: "w",
      ctrl: true,
    } as unknown as blessed.Widgets.Events.IKeyEventArg);
    expect(action).toEqual({ kind: "command", command: { type: "delete_query_word" } });
  });

  it("maps lowercase s to PR sync", () => {
    const action = resolveKeyAction(makeModel(), "s", key("s", "s"));
    expect(action).toEqual({ kind: "command", command: { type: "sync_prs" } });
  });

  it("maps uppercase S to issue sync", () => {
    const action = resolveKeyAction(makeModel(), "S", key("S", "S"));
    expect(action).toEqual({ kind: "command", command: { type: "sync_issues" } });
  });

  it("maps shifted lowercase s key events to issue sync", () => {
    const action = resolveKeyAction(makeModel(), "s", key("s", "s", true));
    expect(action).toEqual({ kind: "command", command: { type: "sync_issues" } });
  });
});

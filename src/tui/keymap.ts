import type blessed from "blessed";
import type { TuiCommand, TuiRenderModel } from "./types.js";

export type TuiKeyAction =
  | { kind: "command"; command: TuiCommand }
  | { kind: "detail-scroll"; delta: number }
  | { kind: "detail-page"; delta: number }
  | { kind: "detail-home" }
  | { kind: "detail-end" }
  | { kind: "quit" }
  | { kind: "open-url" }
  | { kind: "noop" };

function isSlashKey(ch: string, key: blessed.Widgets.Events.IKeyEventArg): boolean {
  return ch === "/" || key.full === "/" || key.name === "slash";
}

export function resolveKeyAction(
  model: TuiRenderModel,
  ch: string,
  key: blessed.Widgets.Events.IKeyEventArg,
): TuiKeyAction {
  if (model.helpOverlay.visible) {
    if (key.name === "escape" || key.name === "f1" || key.name === "question mark" || ch === "?") {
      return { kind: "command", command: { type: "toggle_help" } };
    }
    return { kind: "noop" };
  }

  if (model.focus === "query") {
    if (key.name === "escape") {
      return { kind: "command", command: { type: "stop_query" } };
    }
    if (key.name === "tab") {
      return { kind: "command", command: { type: "focus_next" } };
    }
    if (key.name === "up") {
      return { kind: "command", command: { type: "query_history_prev" } };
    }
    if (key.name === "down") {
      return { kind: "command", command: { type: "query_history_next" } };
    }
    if (key.name === "enter" || key.name === "return") {
      return { kind: "command", command: { type: "submit_query" } };
    }
    if (key.name === "backspace" || key.name === "delete") {
      return { kind: "command", command: { type: "backspace_query" } };
    }
    if (!key.ctrl && !key.meta && ch && ch >= " ") {
      return { kind: "command", command: { type: "append_query", value: ch } };
    }
    return { kind: "noop" };
  }

  if (key.name === "f1" || key.name === "question mark" || ch === "?") {
    return { kind: "command", command: { type: "toggle_help" } };
  }
  if (key.name === "escape" && model.footer.banner?.dismissible) {
    return { kind: "command", command: { type: "dismiss_banner" } };
  }

  if (model.focus === "detail") {
    if (key.name === "escape") {
      return { kind: "command", command: { type: "focus_results" } };
    }
    if (key.name === "tab") {
      return { kind: "command", command: { type: "focus_next" } };
    }
    if (key.name === "up" || key.name === "k") {
      return { kind: "detail-scroll", delta: -1 };
    }
    if (key.name === "down" || key.name === "j") {
      return { kind: "detail-scroll", delta: 1 };
    }
    if (key.name === "pageup") {
      return { kind: "detail-page", delta: -1 };
    }
    if (key.name === "pagedown") {
      return { kind: "detail-page", delta: 1 };
    }
    if (key.name === "home") {
      return { kind: "detail-home" };
    }
    if (key.name === "end") {
      return { kind: "detail-end" };
    }
  }

  if (ch && /^[1-6]$/.test(ch)) {
    return { kind: "command", command: { type: "activate_mode_index", index: Number(ch) - 1 } };
  }
  if (key.name === "q") {
    return { kind: "quit" };
  }
  if (key.name === "tab") {
    return { kind: "command", command: { type: "focus_next" } };
  }
  if (key.name === "left") {
    return { kind: "command", command: { type: "activate_mode", delta: -1 } };
  }
  if (key.name === "right") {
    return { kind: "command", command: { type: "activate_mode", delta: 1 } };
  }
  if (key.name === "up" || key.name === "k") {
    return { kind: "command", command: { type: "move_selection", delta: -1 } };
  }
  if (key.name === "down" || key.name === "j") {
    return { kind: "command", command: { type: "move_selection", delta: 1 } };
  }
  if (key.name === "enter" || key.name === "return") {
    return { kind: "command", command: { type: "toggle_detail" } };
  }
  if (
    isSlashKey(ch, key) &&
    (model.mode === "cross-search" || model.mode === "pr-search" || model.mode === "issue-search")
  ) {
    return { kind: "command", command: { type: "start_query" } };
  }
  if (key.name === "b") {
    return { kind: "command", command: { type: "go_back" } };
  }
  if (key.name === "x") {
    return { kind: "command", command: { type: "jump_detail_section", section: "linked-issues" } };
  }
  if (key.name === "c") {
    return { kind: "command", command: { type: "jump_detail_section", section: "cluster" } };
  }
  if (key.name === "e") {
    return { kind: "command", command: { type: "expand_cluster" } };
  }
  if (key.name === "v") {
    return { kind: "command", command: { type: "mark_seen" } };
  }
  if (key.name === "w") {
    return { kind: "command", command: { type: "toggle_watch" } };
  }
  if (key.name === "i") {
    return { kind: "command", command: { type: "toggle_ignore" } };
  }
  if (key.name === "u") {
    return { kind: "command", command: { type: "clear_attention_state" } };
  }
  if (key.name === "s" && key.shift) {
    return { kind: "command", command: { type: "sync_issues" } };
  }
  if (key.name === "s") {
    return { kind: "command", command: { type: "sync_prs" } };
  }
  if (key.name === "r") {
    return { kind: "command", command: { type: "refresh_selected" } };
  }
  if (key.name === "m") {
    return { kind: "command", command: { type: "load_more" } };
  }
  if (key.name === "o") {
    return { kind: "open-url" };
  }
  return { kind: "noop" };
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import blessed from "blessed";
import {
  formatActionBar,
  formatDetailStatus,
  formatHeader,
  formatListSummary,
  formatModeTabs,
} from "./format.js";
import { resolveKeyAction } from "./keymap.js";
import { TUI_THEME, keyLabel, panelLabel, text, valueTone } from "./theme.js";
import type { TuiController } from "./controller.js";
import type { TuiLayoutMode, TuiRenderModel } from "./types.js";

const execFileAsync = promisify(execFile);

type Box = blessed.Widgets.BoxElement;

export function getUrlOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): { command: string; args: string[] } {
  switch (platform) {
    case "darwin":
      return { command: "open", args: [url] };
    case "win32":
      return { command: "cmd", args: ["/c", "start", "", url] };
    default:
      return { command: "xdg-open", args: [url] };
  }
}

export class BlessedTuiRenderer {
  private readonly screen = blessed.screen({
    smartCSR: false,
    dockBorders: true,
    fullUnicode: true,
    autoPadding: false,
    title: "clawlens",
  });
  private readonly headerBox: Box;
  private readonly tabsBox: Box;
  private readonly bodyBox: Box;
  private bodyFrame: Box;
  private resultsBox: Box;
  private detailBox: Box;
  private readonly messageBox: Box;
  private readonly inputBox: Box;
  private readonly helpBox: Box;
  private lastDetailIdentity: string | null = null;
  private lastDetailAnchorKey: string | null = null;
  private detailVisible = false;
  private layoutMode: TuiLayoutMode = "single-pane";
  private lastSubmitKeyName: "enter" | "return" | null = null;
  private lastSubmitKeyAt = 0;
  private unsubscribe: (() => void) | null = null;
  private destroyed = false;

  constructor(private readonly controller: TuiController) {
    this.headerBox = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: TUI_THEME.layout.headerHeight,
      tags: true,
      style: { bg: TUI_THEME.colors.headerBg, fg: TUI_THEME.colors.text },
      padding: { left: 1, right: 1 },
    });
    this.tabsBox = blessed.box({
      parent: this.screen,
      top: TUI_THEME.layout.headerHeight,
      left: 0,
      width: "100%",
      height: TUI_THEME.layout.tabsHeight,
      tags: true,
      border: "line",
      style: {
        border: { fg: TUI_THEME.colors.border },
        fg: TUI_THEME.colors.text,
        bg: TUI_THEME.colors.panelBg,
      },
      padding: { left: 1, right: 1 },
    });
    this.bodyBox = blessed.box({
      parent: this.screen,
      top: TUI_THEME.layout.headerHeight + TUI_THEME.layout.tabsHeight,
      left: 0,
      width: "100%",
      bottom: TUI_THEME.layout.footerHeight + TUI_THEME.layout.queryHeight,
    });
    this.bodyFrame = this.createBodyFrame();
    this.resultsBox = this.createResultsBox(this.bodyFrame, "single-pane");
    this.detailBox = this.createDetailBox(this.bodyFrame, "single-pane");
    this.messageBox = blessed.box({
      parent: this.screen,
      bottom: TUI_THEME.layout.queryHeight,
      left: 0,
      width: "100%",
      height: TUI_THEME.layout.footerHeight,
      tags: true,
      style: { bg: TUI_THEME.colors.footerBg, fg: TUI_THEME.colors.text },
      padding: { left: 1, right: 1 },
    });
    this.inputBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: TUI_THEME.layout.queryHeight,
      tags: true,
      style: { bg: TUI_THEME.colors.commandBg, fg: TUI_THEME.colors.commandText },
      padding: { left: 1, right: 1 },
    });
    this.helpBox = blessed.box({
      parent: this.screen,
      width: "70%",
      height: "70%",
      top: "center",
      left: "center",
      border: "line",
      hidden: true,
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      style: {
        bg: TUI_THEME.colors.modalBg,
        border: { fg: TUI_THEME.colors.focus },
        fg: TUI_THEME.colors.text,
      },
      padding: { left: 1, right: 1 },
    });
    this.bindKeys();
  }

  async run(): Promise<void> {
    const destroyed = new Promise<void>((resolve) => {
      this.screen.once("destroy", () => {
        this.shutdown();
        resolve();
      });
    });
    this.unsubscribe = this.controller.subscribe(() => {
      this.render(this.controller.getRenderModel());
    });
    this.render(this.controller.getRenderModel());
    try {
      await this.controller.initialize();
      this.screen.render();
      await destroyed;
    } catch (error) {
      this.destroyScreen();
      throw error;
    }
  }

  private bindKeys(): void {
    this.screen.key(["C-c"], () => this.destroyScreen());
    this.screen.on("keypress", (ch, key) => {
      void this.handleKeypress(ch, key);
    });
  }

  private render(model: TuiRenderModel): void {
    (this.screen as blessed.Widgets.Screen & { realloc: () => void }).realloc();
    this.screen.clearRegion(0, this.screen.cols, 0, this.screen.rows);
    (
      this.screen as blessed.Widgets.Screen & {
        program?: { clearScreen?: () => void };
      }
    ).program?.clearScreen?.();
    const layoutChanged = this.transitionLayout(model);
    this.headerBox.setContent(formatHeader(model.header));
    this.tabsBox.setLabel(panelLabel("MODES"));
    this.tabsBox.setContent(formatModeTabs(model.mode, model.focus));
    this.resultsBox.setLabel(
      panelLabel(
        `${model.resultsPane.title.toUpperCase()}${model.resultsPane.summary ? ` · ${model.resultsPane.summary.yieldLabel}` : ""}`,
        model.focus === "results",
      ),
    );
    this.resultsBox.setContent(model.resultsPane.lines.join("\n"));
    if (model.detailPane.visible) {
      this.detailBox.setLabel(
        panelLabel(model.detailPane.title.toUpperCase(), model.detailPane.visible),
      );
      const detailContent = model.detailPane.status
        ? `${formatDetailStatus(model.detailPane.status)}\n\n${model.detailPane.lines.join("\n")}`
        : model.detailPane.lines.join("\n");
      this.detailBox.setContent(detailContent);
    } else {
      this.detailBox.setLabel("");
      this.detailBox.setContent("");
    }

    const statusTone = model.header.errorMessage
      ? valueTone(model.footer.message, "error")
      : model.busy
        ? valueTone(model.footer.message, "warn")
        : text(model.footer.message, "muted");
    const listSummary = model.resultsPane.summary
      ? `${keyLabel("HITS")} ${formatListSummary(model.resultsPane.summary)}`
      : "";
    const bannerTone =
      model.footer.banner?.tone === "error"
        ? "error"
        : model.footer.banner?.tone === "warn"
          ? "warn"
          : model.footer.banner?.tone === "success"
            ? "ok"
            : "muted";
    const bannerLine = model.footer.banner
      ? `${keyLabel("BANNER")} ${valueTone(model.footer.banner.message, bannerTone)}${
          model.footer.banner.actions.length > 0
            ? `  ${text(model.footer.banner.actions.join("  "), "dim")}`
            : ""
        }`
      : `${keyLabel("STATUS")} ${statusTone}${listSummary ? `  ${listSummary}` : ""}`;
    this.messageBox.setContent(
      `${bannerLine}\n${keyLabel("ACTIONS")} ${formatActionBar(model.footer.actions)}  ${keyLabel("KEYS")} ${formatActionBar(
        model.footer.keys,
      )}${model.footer.autoUpdateHint ? `  ${keyLabel("AUTO")} ${text(model.footer.autoUpdateHint, "dim")}` : ""}`,
    );
    const promptPrefix = `${keyLabel("QUERY")} ${text(model.footer.queryPrompt.toUpperCase(), "dim")} >`;
    const queryValue =
      model.footer.queryValue.length > 0
        ? text(model.footer.queryValue)
        : model.focus === "query"
          ? ""
          : text(model.footer.queryPlaceholder, "dim");
    const cursor = model.focus === "query" ? "█" : "";
    this.inputBox.setContent(
      `${promptPrefix} ${queryValue}${cursor}${model.footer.queryHelpText ? `  ${text(model.footer.queryHelpText, "dim")}` : ""}`,
    );
    this.updateFocusStyle(model);
    this.syncScroll(model);
    if (model.helpOverlay.visible) {
      this.helpBox.setLabel(panelLabel(model.helpOverlay.title, true));
      this.helpBox.setContent(model.helpOverlay.lines.join("\n"));
      this.helpBox.show();
    } else {
      this.helpBox.hide();
    }
    this.screen.render();
    if (layoutChanged) {
      this.screen.render();
    }
  }

  private createBodyFrame(): Box {
    return blessed.box({
      parent: this.bodyBox,
      top: 0,
      left: 0,
      width: "100%",
      height: "100%",
    });
  }

  private createResultsBox(parent: Box, layoutMode: TuiLayoutMode): Box {
    return blessed.box({
      parent,
      top: 0,
      left: 0,
      width: layoutMode === "split-pane" ? TUI_THEME.layout.resultsWidthWithDetail : "100%",
      height: "100%",
      tags: true,
      border: "line",
      wrap: false,
      scrollable: true,
      alwaysScroll: true,
      style: {
        border: { fg: TUI_THEME.colors.border },
        fg: TUI_THEME.colors.text,
        bg: TUI_THEME.colors.panelBg,
      },
      padding: { left: 1, right: 1 },
    });
  }

  private createDetailBox(parent: Box, layoutMode: TuiLayoutMode): Box {
    return blessed.box({
      parent,
      top: 0,
      left: TUI_THEME.layout.resultsWidthWithDetail,
      width: TUI_THEME.layout.detailWidth,
      height: "100%",
      tags: true,
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      hidden: layoutMode === "single-pane",
      style: {
        border: { fg: TUI_THEME.colors.borderSoft },
        fg: TUI_THEME.colors.text,
        bg: TUI_THEME.colors.panelBg,
      },
      padding: { left: 1, right: 1 },
    });
  }

  private transitionLayout(model: TuiRenderModel): boolean {
    const nextLayoutMode = model.layoutMode;
    if (this.layoutMode === nextLayoutMode) {
      if (nextLayoutMode === "split-pane") {
        this.resultsBox.show();
        this.resultsBox.width = model.resultsWidth;
        this.detailBox.left = model.resultsWidth;
        this.detailBox.width = model.detailWidth;
      } else if (nextLayoutMode === "detail-fullscreen") {
        this.resultsBox.hide();
        this.detailBox.left = 0;
        this.detailBox.width = "100%";
        this.detailBox.show();
      }
      return false;
    }
    if (nextLayoutMode === "split-pane") {
      this.resultsBox.show();
      this.resultsBox.width = model.resultsWidth;
      this.detailBox.left = model.resultsWidth;
      this.detailBox.width = model.detailWidth;
      this.detailBox.show();
    } else if (nextLayoutMode === "detail-fullscreen") {
      this.resultsBox.hide();
      this.detailBox.left = 0;
      this.detailBox.width = "100%";
      this.detailBox.show();
    } else {
      this.resultsBox.show();
      this.resultsBox.width = "100%";
      this.detailBox.setContent("");
      this.detailBox.hide();
    }
    this.layoutMode = nextLayoutMode;
    return true;
  }

  private updateFocusStyle(model: TuiRenderModel): void {
    this.tabsBox.style.border.fg = TUI_THEME.colors.border;
    this.resultsBox.style.border.fg =
      model.focus === "results" ? TUI_THEME.colors.focus : TUI_THEME.colors.border;
    this.detailBox.style.border.fg =
      model.detailPane.visible && model.focus === "detail"
        ? TUI_THEME.colors.focus
        : model.detailPane.visible
          ? TUI_THEME.colors.border
          : TUI_THEME.colors.borderSoft;
    this.messageBox.style.bg = model.busy
      ? TUI_THEME.colors.footerAccentBg
      : TUI_THEME.colors.footerBg;
    this.inputBox.style.bg =
      model.focus === "query" ? TUI_THEME.colors.commandActiveBg : TUI_THEME.colors.commandBg;
  }

  private syncScroll(model: TuiRenderModel): void {
    this.resultsBox.setScroll(Math.max(0, model.resultsPane.selectedIndex - 4));
    if (
      model.detailPane.visible &&
      (!this.detailVisible || this.lastDetailIdentity !== model.detailPane.identity)
    ) {
      this.detailBox.setScroll(0);
    }
    if (
      model.detailPane.visible &&
      model.detailPane.anchorKey &&
      this.lastDetailAnchorKey !== model.detailPane.anchorKey
    ) {
      this.detailBox.setScroll(model.detailPane.anchorLine ?? 0);
    }
    this.detailVisible = model.detailPane.visible;
    this.lastDetailIdentity = model.detailPane.identity;
    this.lastDetailAnchorKey = model.detailPane.anchorKey;
  }

  private async handleKeypress(
    ch: string,
    key: blessed.Widgets.Events.IKeyEventArg,
  ): Promise<void> {
    if (this.isDuplicateSubmitKey(key)) {
      return;
    }
    this.controller.noteInteraction();
    const action = resolveKeyAction(this.controller.getRenderModel(), ch, key);
    try {
      switch (action.kind) {
        case "command":
          await this.controller.dispatch(action.command);
          return;
        case "detail-scroll":
          this.detailBox.scroll(action.delta);
          this.screen.render();
          return;
        case "detail-page":
          this.detailBox.scroll((Number(this.detailBox.height) || 10) * action.delta);
          this.screen.render();
          return;
        case "detail-home":
          this.detailBox.setScroll(0);
          this.screen.render();
          return;
        case "detail-end":
          this.detailBox.setScrollPerc(100);
          this.screen.render();
          return;
        case "quit":
          this.destroyScreen();
          return;
        case "open-url":
          await this.openActiveUrl();
          return;
        case "noop":
        default:
          return;
      }
    } catch (error) {
      this.controller.reportError(
        error instanceof Error ? error.message : String(error),
        "UI action",
      );
    }
  }

  private async openActiveUrl(): Promise<void> {
    const url = this.controller.getActiveUrl();
    if (!url) {
      return;
    }
    try {
      const opener = getUrlOpenCommand(url);
      await execFileAsync(opener.command, opener.args);
    } catch (error) {
      this.controller.reportError(
        error instanceof Error ? error.message : String(error),
        "Open URL",
      );
    }
  }

  private destroyScreen(): void {
    if (this.destroyed) {
      return;
    }
    this.shutdown();
    this.screen.destroy();
  }

  private shutdown(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller.dispose();
  }

  private isDuplicateSubmitKey(key: blessed.Widgets.Events.IKeyEventArg): boolean {
    if (key.name !== "enter" && key.name !== "return") {
      this.lastSubmitKeyName = null;
      this.lastSubmitKeyAt = 0;
      return false;
    }
    const now = Date.now();
    const isDuplicate =
      this.lastSubmitKeyName !== null &&
      this.lastSubmitKeyName !== key.name &&
      now - this.lastSubmitKeyAt < 75;
    this.lastSubmitKeyName = key.name;
    this.lastSubmitKeyAt = now;
    return isDuplicate;
  }
}

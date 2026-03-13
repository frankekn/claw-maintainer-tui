import { execFile } from "node:child_process";
import { promisify } from "node:util";
import blessed from "blessed";
import {
  formatActionBar,
  formatDetailStatus,
  formatHeader,
  formatListSummary,
  formatModeTabs,
  formatResults,
} from "./format.js";
import { TUI_THEME, keyLabel, panelLabel, text, valueTone } from "./theme.js";
import type { TuiController } from "./controller.js";
import type { TuiRenderModel } from "./types.js";

const execFileAsync = promisify(execFile);

type Box = blessed.Widgets.BoxElement;

export class BlessedTuiRenderer {
  private readonly screen = blessed.screen({
    smartCSR: true,
    dockBorders: true,
    fullUnicode: true,
    autoPadding: false,
    title: "clawlens",
  });
  private readonly headerBox: Box;
  private readonly tabsBox: Box;
  private readonly resultsBox: Box;
  private readonly detailBox: Box;
  private readonly messageBox: Box;
  private readonly inputBox: Box;
  private readonly modalBox: Box;
  private spinnerIndex = 0;
  private spinnerInterval: NodeJS.Timeout | null = null;

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
    this.resultsBox = blessed.box({
      parent: this.screen,
      top: TUI_THEME.layout.headerHeight + TUI_THEME.layout.tabsHeight,
      left: 0,
      width: "100%",
      bottom: TUI_THEME.layout.footerHeight + TUI_THEME.layout.queryHeight,
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
    this.detailBox = blessed.box({
      parent: this.screen,
      top: TUI_THEME.layout.headerHeight + TUI_THEME.layout.tabsHeight,
      left: TUI_THEME.layout.resultsWidthWithDetail,
      width: TUI_THEME.layout.detailWidth,
      bottom: TUI_THEME.layout.footerHeight + TUI_THEME.layout.queryHeight,
      tags: true,
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      style: {
        border: { fg: TUI_THEME.colors.borderSoft },
        fg: TUI_THEME.colors.text,
        bg: TUI_THEME.colors.panelBg,
      },
      padding: { left: 1, right: 1 },
      hidden: true,
    });
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
    this.modalBox = blessed.box({
      parent: this.screen,
      width: 40,
      height: 3,
      top: "center",
      left: "center",
      border: "line",
      hidden: true,
      tags: true,
      align: "center",
      valign: "middle",
      style: {
        bg: TUI_THEME.colors.modalBg,
        border: { fg: TUI_THEME.colors.warn },
        fg: TUI_THEME.colors.text,
      },
    });
    this.bindKeys();
  }

  async run(): Promise<void> {
    this.controller.subscribe(() => {
      this.render(this.controller.getRenderModel());
    });
    this.render(this.controller.getRenderModel());
    await this.controller.initialize();
    this.screen.render();
    await new Promise<void>((resolve) => {
      this.screen.once("destroy", () => resolve());
    });
  }

  private bindKeys(): void {
    this.screen.key(["C-c"], () => this.screen.destroy());
    this.screen.on("keypress", (ch, key) => {
      void this.handleKeypress(ch, key);
    });
  }

  private render(model: TuiRenderModel): void {
    this.headerBox.setContent(formatHeader(model.header));
    this.tabsBox.setLabel(panelLabel("MODES", model.focus === "nav"));
    this.tabsBox.setContent(formatModeTabs(model.mode, model.focus));
    this.resultsBox.setLabel(
      panelLabel(
        `${model.resultTitle.toUpperCase()}${model.listSummary ? ` · ${model.listSummary.yieldLabel}` : ""}`,
        model.focus === "results",
      ),
    );
    this.resultsBox.setContent(formatResults(model).join("\n"));
    this.layoutDetail(model);
    this.detailBox.setLabel(panelLabel(model.detailTitle.toUpperCase(), model.showDetail));
    const detailContent = model.detailStatus
      ? `${formatDetailStatus(model.detailStatus)}\n\n${model.detailText}`
      : model.detailText;
    this.detailBox.setContent(detailContent);

    const statusTone = model.header.errorMessage
      ? valueTone(model.footer.message, "error")
      : model.busy
        ? valueTone(model.footer.message, "warn")
        : text(model.footer.message, "muted");
    const listSummary = model.listSummary
      ? `${keyLabel("HITS")} ${formatListSummary(model.listSummary)}`
      : "";
    this.messageBox.setContent(
      `${keyLabel("STATUS")} ${statusTone}${listSummary ? `  ${listSummary}` : ""}\n${keyLabel("ACTIONS")} ${formatActionBar(
        model.footer.actions,
      )}  ${keyLabel("KEYS")} ${model.footer.hintText}`,
    );
    const promptPrefix = `${keyLabel("QUERY")} ${text(model.footer.queryPrompt.toUpperCase(), "dim")} >`;
    const queryValue =
      model.footer.queryValue.length > 0
        ? text(model.footer.queryValue)
        : model.focus === "query"
          ? ""
          : text("[press / to type]", "dim");
    const cursor = model.focus === "query" ? "█" : "";
    this.inputBox.setContent(`${promptPrefix} ${queryValue}${cursor}`);
    this.updateFocusStyle(model);
    this.syncScroll(model);
    if (model.busy && model.header.busyMessage) {
      this.startSpinner(model.header.busyMessage);
    } else {
      this.stopSpinner();
    }
    this.screen.render();
  }

  private layoutDetail(model: TuiRenderModel): void {
    if (model.showDetail) {
      this.resultsBox.left = 0;
      this.resultsBox.width = TUI_THEME.layout.resultsWidthWithDetail;
      this.detailBox.left = TUI_THEME.layout.resultsWidthWithDetail;
      this.detailBox.width = TUI_THEME.layout.detailWidth;
      this.detailBox.show();
      return;
    }
    this.resultsBox.left = 0;
    this.resultsBox.width = "100%";
    this.detailBox.hide();
  }

  private updateFocusStyle(model: TuiRenderModel): void {
    this.tabsBox.style.border.fg =
      model.focus === "nav" ? TUI_THEME.colors.focus : TUI_THEME.colors.border;
    this.resultsBox.style.border.fg =
      model.focus === "results" ? TUI_THEME.colors.focus : TUI_THEME.colors.border;
    this.detailBox.style.border.fg = model.showDetail
      ? TUI_THEME.colors.focus
      : TUI_THEME.colors.borderSoft;
    this.messageBox.style.bg = model.busy
      ? TUI_THEME.colors.footerAccentBg
      : TUI_THEME.colors.footerBg;
    this.inputBox.style.bg =
      model.focus === "query" ? TUI_THEME.colors.commandActiveBg : TUI_THEME.colors.commandBg;
  }

  private syncScroll(model: TuiRenderModel): void {
    this.resultsBox.setScroll(Math.max(0, model.selectedIndex - 4));
    if (model.showDetail) {
      this.detailBox.setScroll(0);
    }
  }

  private startSpinner(message: string): void {
    this.modalBox.show();
    if (!this.spinnerInterval) {
      this.spinnerInterval = setInterval(() => {
        const frames = ["|", "/", "-", "\\"];
        this.spinnerIndex = (this.spinnerIndex + 1) % frames.length;
        this.modalBox.setContent(
          `${keyLabel(frames[this.spinnerIndex])} ${valueTone(message, "warn")}`,
        );
        this.screen.render();
      }, 120);
    }
  }

  private stopSpinner(): void {
    this.modalBox.hide();
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }

  private async handleKeypress(
    ch: string,
    key: blessed.Widgets.Events.IKeyEventArg,
  ): Promise<void> {
    if (this.controller.isQueryFocus()) {
      if (key.name === "escape") {
        this.controller.stopQueryEntry();
        return;
      }
      if (key.name === "tab") {
        this.controller.focusNext();
        return;
      }
      if (key.name === "enter" || key.name === "return") {
        await this.controller.submitCurrentQuery();
        return;
      }
      if (key.name === "backspace" || key.name === "delete") {
        this.controller.backspaceQuery();
        return;
      }
      if (!key.ctrl && !key.meta && ch && ch >= " ") {
        this.controller.appendQueryCharacter(ch);
      }
      return;
    }

    if (ch && /^[1-9]$/.test(ch)) {
      await this.controller.triggerAction(Number(ch));
      return;
    }

    if (key.name === "q") {
      this.screen.destroy();
      return;
    }
    if (key.name === "tab") {
      this.controller.focusNext();
      return;
    }
    if (
      key.name === "up" ||
      key.name === "k" ||
      (this.controller.isNavFocus() && (key.name === "left" || key.name === "h"))
    ) {
      void this.controller.moveSelection(-1);
      return;
    }
    if (
      key.name === "down" ||
      key.name === "j" ||
      (this.controller.isNavFocus() && (key.name === "right" || key.name === "l"))
    ) {
      void this.controller.moveSelection(1);
      return;
    }
    if (key.name === "enter" || key.name === "return") {
      if (this.controller.isNavFocus()) {
        await this.controller.triggerAction(1);
        return;
      }
      await this.controller.openSelected();
      return;
    }
    if (
      (ch === "/" || key.full === "/" || key.name === "slash") &&
      this.controller.canStartSlashQuery()
    ) {
      this.controller.startQueryEntry();
      return;
    }
    if (key.name === "b") {
      this.controller.goBack();
      return;
    }
    if (key.name === "x") {
      await this.controller.crossReferenceSelected();
      return;
    }
    if (key.name === "c") {
      await this.controller.clusterSelected();
      return;
    }
    if (key.name === "s" && key.shift) {
      await this.controller.syncIssues();
      return;
    }
    if (key.name === "s") {
      await this.controller.syncPrs();
      return;
    }
    if (key.name === "r") {
      await this.controller.refreshSelected();
      return;
    }
    if (key.name === "o") {
      await this.openActiveUrl();
    }
  }

  private async openActiveUrl(): Promise<void> {
    const url = this.controller.getActiveUrl();
    if (!url) {
      return;
    }
    try {
      await execFileAsync("open", [url]);
    } catch {
      return;
    }
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import blessed from "blessed";
import { formatHeader, formatModeRail, formatResults } from "./format.js";
import { TUI_MODE_ORDER } from "./types.js";
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
  private readonly navBox: Box;
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
      height: 3,
      tags: true,
      style: { bg: "#11161b", fg: "white" },
      padding: { left: 1, right: 1, top: 1 },
    });
    this.navBox = blessed.box({
      parent: this.screen,
      top: 3,
      left: 0,
      width: 16,
      bottom: 4,
      label: " Modes ",
      tags: true,
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      style: { border: { fg: "#44515f" }, fg: "white", bg: "#0d1117" },
      padding: { left: 1, right: 1 },
    });
    this.resultsBox = blessed.box({
      parent: this.screen,
      top: 3,
      left: 16,
      width: "42%",
      bottom: 4,
      label: " Results ",
      tags: true,
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      style: { border: { fg: "#44515f" }, fg: "white", bg: "#0d1117" },
      padding: { left: 1, right: 1 },
    });
    this.detailBox = blessed.box({
      parent: this.screen,
      top: 3,
      left: "58%",
      width: "42%",
      bottom: 4,
      label: " Detail ",
      tags: true,
      border: "line",
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      style: { border: { fg: "#44515f" }, fg: "white", bg: "#0d1117" },
      padding: { left: 1, right: 1 },
    });
    this.messageBox = blessed.box({
      parent: this.screen,
      bottom: 2,
      left: 0,
      width: "100%",
      height: 2,
      tags: true,
      style: { bg: "#2a2111", fg: "white" },
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
    });
    this.inputBox = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 2,
      tags: true,
      style: { bg: "#c98f2f", fg: "black" },
      padding: { left: 1, right: 1, top: 0, bottom: 0 },
    });
    this.modalBox = blessed.box({
      parent: this.screen,
      width: 40,
      height: 5,
      top: "center",
      left: "center",
      border: "line",
      hidden: true,
      tags: true,
      align: "center",
      valign: "middle",
      style: { bg: "#11161b", border: { fg: "yellow" }, fg: "white" },
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
    this.screen.key(["q", "C-c"], () => this.screen.destroy());
    this.screen.key(["tab"], () => this.controller.focusNext());
    this.screen.key(["up", "k"], () => void this.controller.moveSelection(-1));
    this.screen.key(["down", "j"], () => void this.controller.moveSelection(1));
    this.screen.key(["enter"], () => void this.controller.openSelected());
    this.screen.key(["b"], () => this.controller.goBack());
    this.screen.key(["x"], () => void this.controller.crossReferenceSelected());
    this.screen.key(["c"], () => void this.controller.clusterSelected());
    this.screen.key(["s"], () => void this.controller.syncPrs());
    this.screen.key(["S"], () => void this.controller.syncIssues());
    this.screen.key(["r"], () => void this.controller.refreshFacts());
    this.screen.key(["o"], () => void this.openActiveUrl());
    this.screen.key(["/"], () => void this.captureQuery());
  }

  private render(model: TuiRenderModel): void {
    this.headerBox.setContent(formatHeader(model.header));
    this.navBox.setLabel(` Modes ${model.focus === "nav" ? "[active]" : ""} `);
    this.navBox.setContent(formatModeRail(model.mode, model.focus).join("\n"));
    this.resultsBox.setLabel(
      ` ${model.resultTitle}${model.focus === "results" ? " [active]" : ""} `,
    );
    this.resultsBox.setContent(formatResults(model).join("\n"));
    this.detailBox.setLabel(` ${model.detailTitle} `);
    this.detailBox.setContent(model.detailText);
    this.messageBox.setContent(`${model.footer.hintText}\n${model.footer.message}`);
    const promptPrefix =
      model.focus === "query"
        ? `{black-fg}{white-bg} ${model.footer.queryPrompt} {/}`
        : `{black-fg}{white-bg} ${model.footer.queryPrompt} {/}`;
    this.inputBox.setContent(`${promptPrefix} ${model.footer.queryValue || "<empty>"}`);
    this.updateFocusStyle(model);
    this.syncScroll(model);
    if (model.busy && model.header.busyMessage) {
      this.startSpinner(model.header.busyMessage);
    } else {
      this.stopSpinner();
    }
    this.screen.render();
  }

  private updateFocusStyle(model: TuiRenderModel): void {
    this.navBox.style.border.fg = model.focus === "nav" ? "#4bb6ff" : "#44515f";
    this.resultsBox.style.border.fg = model.focus === "results" ? "#4bb6ff" : "#44515f";
    this.inputBox.style.bg = model.focus === "query" ? "#ffb84d" : "#c98f2f";
  }

  private syncScroll(model: TuiRenderModel): void {
    const navIndex = Math.max(
      0,
      TUI_MODE_ORDER.findIndex((mode) => mode.id === model.mode),
    );
    this.navBox.setScroll(navIndex);
    this.resultsBox.setScroll(Math.max(0, model.selectedIndex - 4));
  }

  private startSpinner(message: string): void {
    this.modalBox.show();
    if (!this.spinnerInterval) {
      this.spinnerInterval = setInterval(() => {
        const frames = ["|", "/", "-", "\\"];
        this.spinnerIndex = (this.spinnerIndex + 1) % frames.length;
        this.modalBox.setContent(`\n${frames[this.spinnerIndex]} ${message}\n`);
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

  private async captureQuery(): Promise<void> {
    const model = this.controller.getRenderModel();
    const prompt = blessed.prompt({
      parent: this.screen,
      border: "line",
      height: 8,
      width: "70%",
      top: "center",
      left: "center",
      tags: true,
      label: ` ${model.footer.queryPrompt} `,
      style: { bg: "#11161b", border: { fg: "#4bb6ff" }, fg: "white" },
    });
    await new Promise<void>((resolve) => {
      prompt.input(model.footer.queryPrompt, model.query, async (_error, value) => {
        prompt.destroy();
        this.screen.render();
        if (typeof value === "string") {
          await this.controller.submitQuery(value);
        }
        resolve();
      });
    });
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

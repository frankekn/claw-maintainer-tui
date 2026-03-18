import type blessed from "blessed";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BlessedTuiRenderer } from "./blessed-renderer.js";
import type { TuiRenderModel } from "./types.js";

const renderModel: TuiRenderModel = {
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
    queryPrompt: "Inbox",
    queryValue: "",
    actions: [],
    autoUpdateHint: null,
  },
  mode: "inbox",
  focus: "results",
  layoutMode: "single-pane",
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
  queryPlaceholder: "",
  busy: false,
};

function createControllerStub() {
  return {
    noteInteraction: vi.fn(),
    dispatch: vi.fn(async () => {}),
    getActiveUrl: vi.fn(() => null),
    subscribe: vi.fn(() => () => {}),
    getRenderModel: vi.fn(() => renderModel),
    initialize: vi.fn(async () => {}),
    reportError: vi.fn(),
    dispose: vi.fn(),
  };
}

type RendererHarness = {
  screen: blessed.Widgets.Screen;
  handleKeypress: (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => Promise<void>;
  render: (model: TuiRenderModel) => void;
};

const renderers: RendererHarness[] = [];

afterEach(() => {
  while (renderers.length > 0) {
    renderers.pop()?.screen.destroy();
  }
});

describe("BlessedTuiRenderer", () => {
  it("uses full repaint mode for layout changes", () => {
    const controller = createControllerStub();
    const renderer = new BlessedTuiRenderer(controller as never);
    const harness = renderer as unknown as RendererHarness & {
      screen: blessed.Widgets.Screen & { options: { smartCSR?: boolean } };
    };
    renderers.push(harness);

    expect(harness.screen.options.smartCSR).toBe(false);
  });

  it("reallocates the screen buffer before rendering", () => {
    const controller = createControllerStub();
    const renderer = new BlessedTuiRenderer(controller as never);
    const harness = renderer as unknown as RendererHarness & {
      screen: blessed.Widgets.Screen & {
        realloc: () => void;
        program: { clearScreen: () => void };
      };
    };
    renderers.push(harness);
    const reallocSpy = vi.spyOn(harness.screen, "realloc");
    const clearScreenSpy = vi.fn();
    Object.assign(harness.screen.program, { clearScreen: clearScreenSpy });

    harness.render(renderModel);

    expect(reallocSpy).toHaveBeenCalledTimes(1);
    expect(clearScreenSpy).toHaveBeenCalledTimes(1);
  });

  it("routes v/w/i/u shortcuts to triage actions", async () => {
    const controller = createControllerStub();
    const renderer = new BlessedTuiRenderer(controller as never);
    const harness = renderer as unknown as RendererHarness;
    renderers.push(harness);

    await harness.handleKeypress("v", { name: "v" } as blessed.Widgets.Events.IKeyEventArg);
    await harness.handleKeypress("w", { name: "w" } as blessed.Widgets.Events.IKeyEventArg);
    await harness.handleKeypress("i", { name: "i" } as blessed.Widgets.Events.IKeyEventArg);
    await harness.handleKeypress("u", { name: "u" } as blessed.Widgets.Events.IKeyEventArg);

    expect(controller.dispatch).toHaveBeenNthCalledWith(1, { type: "mark_seen" });
    expect(controller.dispatch).toHaveBeenNthCalledWith(2, { type: "toggle_watch" });
    expect(controller.dispatch).toHaveBeenNthCalledWith(3, { type: "toggle_ignore" });
    expect(controller.dispatch).toHaveBeenNthCalledWith(4, { type: "clear_attention_state" });
  });

  it("routes left and right arrows to mode changes from non-query focus", async () => {
    const controller = createControllerStub();
    const renderer = new BlessedTuiRenderer(controller as never);
    const harness = renderer as unknown as RendererHarness;
    renderers.push(harness);

    await harness.handleKeypress("", { name: "left" } as blessed.Widgets.Events.IKeyEventArg);
    await harness.handleKeypress("", { name: "right" } as blessed.Widgets.Events.IKeyEventArg);

    expect(controller.dispatch).toHaveBeenNthCalledWith(1, { type: "activate_mode", delta: -1 });
    expect(controller.dispatch).toHaveBeenNthCalledWith(2, { type: "activate_mode", delta: 1 });
  });

  it("deduplicates enter and return keypresses fired back-to-back", async () => {
    const controller = createControllerStub();
    const renderer = new BlessedTuiRenderer(controller as never);
    const harness = renderer as unknown as RendererHarness;
    renderers.push(harness);

    await harness.handleKeypress("", { name: "enter" } as blessed.Widgets.Events.IKeyEventArg);
    await harness.handleKeypress("", { name: "return" } as blessed.Widgets.Events.IKeyEventArg);

    expect(controller.dispatch).toHaveBeenCalledTimes(1);
    expect(controller.dispatch).toHaveBeenCalledWith({ type: "toggle_detail" });
  });

  it("reports async dispatch failures instead of leaking them", async () => {
    const controller = createControllerStub();
    controller.dispatch.mockRejectedValue(new Error("detail boom"));
    const renderer = new BlessedTuiRenderer(controller as never);
    const harness = renderer as unknown as RendererHarness;
    renderers.push(harness);

    await harness.handleKeypress("", { name: "enter" } as blessed.Widgets.Events.IKeyEventArg);

    expect(controller.reportError).toHaveBeenCalledWith("detail boom", "UI action");
  });

  it("stops the spinner and disposes the controller when destroyed", async () => {
    const controller = createControllerStub();
    controller.getRenderModel.mockReturnValue({
      ...renderModel,
      busy: true,
      header: {
        ...renderModel.header,
        busyMessage: "Working",
      },
    });
    const renderer = new BlessedTuiRenderer(controller as never);
    const harness = renderer as unknown as RendererHarness & {
      screen: blessed.Widgets.Screen;
      spinnerInterval: NodeJS.Timeout | null;
    };
    renderers.push(harness);
    const runPromise = renderer.run();
    await Promise.resolve();
    harness.screen.destroy();
    await runPromise;

    expect(harness.spinnerInterval).toBeNull();
    expect(controller.dispose).toHaveBeenCalledTimes(1);
  });
});

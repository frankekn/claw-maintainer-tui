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
  rows: [],
  selectedIndex: 0,
  detailText: "",
  detailStatus: null,
  detailIdentity: null,
  detailAnchorLine: null,
  detailAnchorKey: null,
  showDetail: false,
  activeUrl: null,
  query: "",
  resultTitle: "Inbox",
  detailTitle: "Start Here",
  context: null,
  queryPlaceholder: "",
  busy: false,
  listSummary: null,
};

function createControllerStub() {
  return {
    noteInteraction: vi.fn(),
    isQueryFocus: vi.fn(() => false),
    isDetailFocus: vi.fn(() => false),
    isNavFocus: vi.fn(() => false),
    stopQueryEntry: vi.fn(),
    focusNext: vi.fn(),
    submitCurrentQuery: vi.fn(),
    backspaceQuery: vi.fn(),
    appendQueryCharacter: vi.fn(),
    focusResults: vi.fn(),
    triggerAction: vi.fn(),
    moveMode: vi.fn(),
    moveSelection: vi.fn(),
    openSelected: vi.fn(),
    canStartSlashQuery: vi.fn(() => false),
    startQueryEntry: vi.fn(),
    goBack: vi.fn(),
    crossReferenceSelected: vi.fn(),
    clusterSelected: vi.fn(),
    markSeenSelected: vi.fn(),
    toggleWatchSelected: vi.fn(),
    toggleIgnoreSelected: vi.fn(),
    clearSelectedAttentionState: vi.fn(),
    syncIssues: vi.fn(),
    syncPrs: vi.fn(),
    refreshSelected: vi.fn(),
    loadMore: vi.fn(),
    getActiveUrl: vi.fn(() => null),
    subscribe: vi.fn(() => () => {}),
    getRenderModel: vi.fn(() => renderModel),
    initialize: vi.fn(async () => {}),
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
      screen: blessed.Widgets.Screen & { realloc: () => void };
    };
    renderers.push(harness);
    const reallocSpy = vi.spyOn(harness.screen, "realloc");

    harness.render(renderModel);

    expect(reallocSpy).toHaveBeenCalledTimes(1);
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

    expect(controller.markSeenSelected).toHaveBeenCalledTimes(1);
    expect(controller.toggleWatchSelected).toHaveBeenCalledTimes(1);
    expect(controller.toggleIgnoreSelected).toHaveBeenCalledTimes(1);
    expect(controller.clearSelectedAttentionState).toHaveBeenCalledTimes(1);
  });

  it("routes left and right arrows to mode changes from non-query focus", async () => {
    const controller = createControllerStub();
    const renderer = new BlessedTuiRenderer(controller as never);
    const harness = renderer as unknown as RendererHarness;
    renderers.push(harness);

    await harness.handleKeypress("", { name: "left" } as blessed.Widgets.Events.IKeyEventArg);
    await harness.handleKeypress("", { name: "right" } as blessed.Widgets.Events.IKeyEventArg);

    expect(controller.moveMode).toHaveBeenNthCalledWith(1, -1);
    expect(controller.moveMode).toHaveBeenNthCalledWith(2, 1);
  });
});

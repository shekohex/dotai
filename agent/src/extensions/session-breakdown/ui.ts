import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BorderedLoader } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, type Component, type TUI } from "@mariozechner/pi-tui";
import type {
  BreakdownData,
  BreakdownProgressState,
  BreakdownView,
  MeasurementMode,
} from "./types.js";
import { RANGE_DAYS } from "./types.js";
import { computeBreakdown } from "./compute.js";
import { rangeSummary } from "./metrics.js";
import { formatCount, setBorderedLoaderMessage } from "./utils.js";
import { buildBreakdownComponentLines } from "./view.js";

class BreakdownComponent implements Component {
  private data: BreakdownData;
  private tui: TUI;
  private onDone: () => void;
  private rangeIndex = 1;
  private measurement: MeasurementMode = "sessions";
  private view: BreakdownView = "model";
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(data: BreakdownData, tui: TUI, onDone: () => void) {
    this.data = data;
    this.tui = tui;
    this.onDone = onDone;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    if (this.handleCloseInput(data)) return;
    if (this.handleMeasurementInput(data)) return;
    if (this.handleRangeCycleInput(data)) return;
    if (this.handleViewInput(data)) return;
    this.handleRangeShortcutInput(data);
  }

  render(width: number): string[] {
    if (this.cachedWidth === width && this.cachedLines) {
      return this.cachedLines;
    }

    const nextLines = buildBreakdownComponentLines(this.data, {
      width,
      rangeIndex: this.rangeIndex,
      measurement: this.measurement,
      view: this.view,
    });
    this.cachedWidth = width;
    this.cachedLines = nextLines;
    return nextLines;
  }

  private handleCloseInput(data: string): boolean {
    if (
      !matchesKey(data, Key.escape) &&
      !matchesKey(data, Key.ctrl("c")) &&
      data.toLowerCase() !== "q"
    ) {
      return false;
    }

    this.onDone();
    return true;
  }

  private handleMeasurementInput(data: string): boolean {
    if (
      !matchesKey(data, Key.tab) &&
      !matchesKey(data, Key.shift("tab")) &&
      data.toLowerCase() !== "t"
    ) {
      return false;
    }

    const order: MeasurementMode[] = ["sessions", "messages", "tokens"];
    const idx = Math.max(0, order.indexOf(this.measurement));
    const dir = matchesKey(data, Key.shift("tab")) ? -1 : 1;
    this.measurement = order[(idx + order.length + dir) % order.length] ?? "sessions";
    this.requestRender();
    return true;
  }

  private handleRangeCycleInput(data: string): boolean {
    if (matchesKey(data, Key.left) || data.toLowerCase() === "h") {
      this.rangeIndex = (this.rangeIndex + RANGE_DAYS.length - 1) % RANGE_DAYS.length;
      this.requestRender();
      return true;
    }
    if (matchesKey(data, Key.right) || data.toLowerCase() === "l") {
      this.rangeIndex = (this.rangeIndex + 1) % RANGE_DAYS.length;
      this.requestRender();
      return true;
    }

    return false;
  }

  private handleViewInput(data: string): boolean {
    if (
      !matchesKey(data, Key.up) &&
      !matchesKey(data, Key.down) &&
      data.toLowerCase() !== "j" &&
      data.toLowerCase() !== "k"
    ) {
      return false;
    }

    const views: BreakdownView[] = ["model", "cwd", "dow", "tod"];
    const idx = views.indexOf(this.view);
    const dir = matchesKey(data, Key.up) || data.toLowerCase() === "k" ? -1 : 1;
    this.view = views[(idx + views.length + dir) % views.length] ?? "model";
    this.requestRender();
    return true;
  }

  private handleRangeShortcutInput(data: string): void {
    if (data === "1") {
      this.rangeIndex = 0;
      this.requestRender();
      return;
    }
    if (data === "2") {
      this.rangeIndex = 1;
      this.requestRender();
      return;
    }
    if (data === "3") {
      this.rangeIndex = 2;
      this.requestRender();
    }
  }

  private requestRender(): void {
    this.invalidate();
    this.tui.requestRender();
  }
}

async function showHeadlessBreakdown(pi: ExtensionAPI): Promise<void> {
  const data = await computeBreakdown();
  const range = data.ranges.get(30);
  if (!range) {
    return;
  }

  pi.sendMessage(
    {
      customType: "session-breakdown",
      content: `Session breakdown (non-interactive)\n${rangeSummary(range, 30, "sessions")}`,
      display: true,
    },
    { triggerTurn: false },
  );
}

async function loadBreakdownDataWithLoader(
  ctx: ExtensionContext,
): Promise<{ data: BreakdownData | null; aborted: boolean }> {
  let aborted = false;
  const data = await ctx.ui.custom<BreakdownData | null>((tui, theme, _kb, done) => {
    return createBreakdownLoaderComponent(tui, theme, done, () => {
      aborted = true;
    });
  });

  return { data, aborted };
}

function createBreakdownLoaderComponent(
  tui: TUI,
  theme: ConstructorParameters<typeof BorderedLoader>[1],
  done: (value: BreakdownData | null) => void,
  onAbort: () => void,
): BorderedLoader {
  const baseMessage = "Analyzing sessions (last 90 days)…";
  const loader = new BorderedLoader(tui, theme, baseMessage);
  const startedAt = Date.now();
  const progress: BreakdownProgressState = {
    phase: "scan",
    foundFiles: 0,
    parsedFiles: 0,
    totalFiles: 0,
    currentFile: undefined,
  };
  const renderMessage = () => formatBreakdownLoaderMessage(baseMessage, startedAt, progress);
  const stopTicker = startBreakdownLoaderTicker(loader, renderMessage);

  loader.onAbort = () => {
    onAbort();
    stopTicker();
    done(null);
  };

  computeBreakdown(loader.signal, (update) => Object.assign(progress, update))
    .then((result) => {
      stopTicker();
      done(result);
    })
    .catch((error) => {
      stopTicker();
      console.error("session-breakdown: failed to analyze sessions", error);
      done(null);
    });

  return loader;
}

function startBreakdownLoaderTicker(
  loader: BorderedLoader,
  renderMessage: () => string,
): () => void {
  setBorderedLoaderMessage(loader, renderMessage());
  const intervalId = setInterval(() => {
    setBorderedLoaderMessage(loader, renderMessage());
  }, 500);

  return () => {
    clearInterval(intervalId);
  };
}

function formatBreakdownLoaderMessage(
  baseMessage: string,
  startedAt: number,
  progress: BreakdownProgressState,
): string {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  if (progress.phase === "scan") {
    return `${baseMessage}  scanning (${formatCount(progress.foundFiles)} files) · ${elapsed}s`;
  }
  if (progress.phase === "parse") {
    return `${baseMessage}  parsing (${formatCount(progress.parsedFiles)}/${formatCount(progress.totalFiles)}) · ${elapsed}s`;
  }

  return `${baseMessage}  finalizing · ${elapsed}s`;
}

export function createSessionBreakdownHandler(pi: ExtensionAPI) {
  return async (_args: string, ctx: ExtensionContext): Promise<void> => {
    if (!ctx.hasUI) {
      await showHeadlessBreakdown(pi);
      return;
    }

    const { data, aborted } = await loadBreakdownDataWithLoader(ctx);
    if (!data) {
      ctx.ui.notify(
        aborted ? "Cancelled" : "Failed to analyze sessions",
        aborted ? "info" : "error",
      );
      return;
    }

    await ctx.ui.custom<void>((tui, _theme, _kb, done) => new BreakdownComponent(data, tui, done));
  };
}

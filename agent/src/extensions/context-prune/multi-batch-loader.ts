import type { CapturedBatch } from "./types.js";
import { Container, Loader, type TUI } from "@earendil-works/pi-tui";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { pruneProgressText } from "./progress-text.js";

export class MultiBatchLoaderOverlay extends Container {
  private readonly loaders: Loader[];
  private readonly batches: CapturedBatch[];
  private readonly latestReceivedChars: number[];
  private _onAbort?: () => void;

  constructor(tui: TUI, theme: Theme, batches: CapturedBatch[]) {
    super();
    this.batches = batches;
    this.loaders = [];
    this.latestReceivedChars = batches.map(() => 0);

    const total = batches.length;

    // Top border
    this.addChild(new DynamicBorder());

    for (let i = 0; i < total; i++) {
      // Mirror the colour scheme used by BorderedLoader:
      //   spinner  → accent colour
      //   message  → muted colour
      const loader = new Loader(
        tui,
        (s: string) => theme.fg("accent", s),
        (s: string) => theme.fg("muted", s),
        this.runningLabel(i),
      );
      this.loaders.push(loader);
      this.addChild(loader);
    }

    // Bottom border
    this.addChild(new DynamicBorder());
  }

  set onAbort(fn: (() => void) | undefined) {
    this._onAbort = fn;
  }

  get onAbort(): (() => void) | undefined {
    return this._onAbort;
  }

  private runningLabel(index: number, receivedChars = 0): string {
    return pruneProgressText(
      this.batches[index],
      index,
      this.batches.length,
      receivedChars,
      "running",
    );
  }

  markRunning(index: number): void {
    this.latestReceivedChars[index] = 0;
    this.loaders[index].setMessage(this.runningLabel(index, 0));
  }

  markReceivedChars(index: number, receivedChars: number): void {
    this.latestReceivedChars[index] = receivedChars;
    this.loaders[index].setMessage(this.runningLabel(index, receivedChars));
  }

  markDone(index: number): void {
    this.loaders[index].stop();
    this.loaders[index].setMessage(
      pruneProgressText(
        this.batches[index],
        index,
        this.batches.length,
        this.latestReceivedChars[index] ?? 0,
        "done",
      ),
    );
  }

  markSkipped(index: number): void {
    this.loaders[index].stop();
    this.loaders[index].setMessage(
      pruneProgressText(
        this.batches[index],
        index,
        this.batches.length,
        this.latestReceivedChars[index] ?? 0,
        "skipped",
      ),
    );
  }

  handleInput(data: string): boolean {
    if (data === "\u001B" || data === "q") {
      this._onAbort?.();
      return true;
    }
    return false;
  }
}

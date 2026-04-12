import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { ExecOptions, ExecResult } from "@mariozechner/pi-coding-agent";

import type { CreatePaneOptions, MuxAdapter, PaneCapture, PaneSubmitMode } from "./mux.js";

type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

export class TmuxAdapter implements MuxAdapter {
  readonly backend = "tmux";

  constructor(
    private readonly exec: ExecFunction,
    private readonly cwd: string,
  ) { }

  async isAvailable(): Promise<boolean> {
    if (!process.env.TMUX) {
      return false;
    }

    const result = await this.exec("tmux", ["-V"], { cwd: this.cwd });
    return result.code === 0;
  }

  async createPane(options: CreatePaneOptions): Promise<{ paneId: string }> {
    const createArgs = options.target === "window"
      ? [
        "new-window",
        "-d",
        "-c",
        options.cwd,
        "-n",
        options.title,
        "-P",
        "-F",
        "#{pane_id}",
        options.command,
      ]
      : [
        "split-window",
        "-d",
        "-h",
        "-c",
        options.cwd,
        "-P",
        "-F",
        "#{pane_id}",
        options.command,
      ];
    const result = await this.exec("tmux", createArgs, { cwd: this.cwd });
    this.assertOk(result, options.target === "window" ? "create window" : "create pane");

    const [paneId] = result.stdout.trim().split("\t");
    if (!paneId) {
      throw new Error("tmux did not return a pane id");
    }

    await this.exec("tmux", ["select-pane", "-t", paneId, "-T", options.title], { cwd: this.cwd });
    return { paneId };
  }

  async sendText(paneId: string, text: string, submitMode: PaneSubmitMode = "steer"): Promise<void> {
    const bufferName = `pi-subagent-${paneId.replace(/[^a-zA-Z0-9_-]/g, "")}-${Date.now()}`;
    const filePath = path.join(os.tmpdir(), `${bufferName}.txt`);

    await fs.writeFile(filePath, text, "utf8");
    try {
      this.assertOk(
        await this.exec("tmux", ["load-buffer", "-b", bufferName, filePath], { cwd: this.cwd }),
        "load tmux buffer",
      );
      this.assertOk(
        await this.exec("tmux", ["paste-buffer", "-b", bufferName, "-d", "-t", paneId], { cwd: this.cwd }),
        "paste tmux buffer",
      );
      const submitKey = submitMode === "followUp" ? "M-Enter" : submitMode === "steer" ? "Enter" : undefined;
      if (submitKey) {
        this.assertOk(
          await this.exec("tmux", ["send-keys", "-t", paneId, submitKey], { cwd: this.cwd }),
          "submit pasted text",
        );
      }
    } finally {
      await fs.unlink(filePath).catch(() => undefined);
    }
  }

  async paneExists(paneId: string): Promise<boolean> {
    const result = await this.exec("tmux", ["list-panes", "-a", "-F", "#{pane_id}"], { cwd: this.cwd });
    if (result.code !== 0) {
      return false;
    }

    return result.stdout.split("\n").map((value) => value.trim()).includes(paneId);
  }

  async killPane(paneId: string): Promise<void> {
    const result = await this.exec("tmux", ["kill-pane", "-t", paneId], { cwd: this.cwd });
    if (result.code !== 0 && !result.stderr.includes("can't find pane")) {
      this.assertOk(result, "kill pane");
    }
  }

  async capturePane(paneId: string, lines = 120): Promise<PaneCapture> {
    const start = Math.max(0, lines - 1) * -1;
    const result = await this.exec("tmux", ["capture-pane", "-p", "-t", paneId, "-S", String(start)], { cwd: this.cwd });
    this.assertOk(result, "capture pane");
    return { text: result.stdout };
  }

  private assertOk(result: ExecResult, action: string): void {
    if (result.code === 0) {
      return;
    }

    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`tmux ${action} failed: ${detail}`);
  }
}

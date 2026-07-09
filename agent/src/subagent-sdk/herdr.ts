import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";

import { HerdrClient, currentHerdrWorkspaceId, isRunningInHerdr } from "../herdr/client.js";
import type { CreatePaneOptions, MuxAdapter, PaneCapture, PaneSubmitMode } from "./mux.js";

type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const SUBMIT_KEYS: Record<PaneSubmitMode, string> = {
  steer: "enter",
  followUp: "alt+enter",
};
const HERDR_AVAILABILITY_TIMEOUT_MS = 2000;

function paneSplitTarget(): string {
  const paneId = process.env.HERDR_PANE_ID;
  return paneId !== undefined && paneId.length > 0 ? paneId : "--current";
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function wrapCommandWithSelfClose(command: string, paneId: string): string {
  return `{ ${command}; }; __pi_subagent_status=$?; herdr pane close ${shellEscape(paneId)}; exit $__pi_subagent_status`;
}

export class HerdrAdapter implements MuxAdapter {
  readonly backend = "herdr";

  constructor(
    private readonly exec: ExecFunction,
    private readonly cwd: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    if (!isRunningInHerdr()) {
      return false;
    }

    try {
      await this.client().statusServer({
        cwd: this.cwd,
        timeout: HERDR_AVAILABILITY_TIMEOUT_MS,
      });
      return true;
    } catch {
      return false;
    }
  }

  async createPane(options: CreatePaneOptions): Promise<{ paneId: string }> {
    const client = this.client();
    const paneId =
      options.target === "window"
        ? (
            await client.createTab({
              cwd: options.cwd,
              label: options.title,
              workspaceId: currentHerdrWorkspaceId(),
            })
          ).paneId
        : await client.splitPane({
            cwd: options.cwd,
            direction: "right",
            paneId: paneSplitTarget(),
          });
    await client.renamePane(paneId, options.title, { cwd: this.cwd });
    await client.runPane(paneId, ` ${wrapCommandWithSelfClose(options.command, paneId)}`, {
      cwd: this.cwd,
    });
    return { paneId };
  }

  async sendText(
    paneId: string,
    text: string,
    submitMode: PaneSubmitMode = "steer",
  ): Promise<void> {
    const client = this.client();
    await client.sendText(paneId, `\u001B[200~${text}\u001B[201~`, { cwd: this.cwd });
    await client.sendKeys(paneId, SUBMIT_KEYS[submitMode], { cwd: this.cwd });
  }

  paneExists(paneId: string): Promise<boolean> {
    return this.client().paneExists(paneId, { cwd: this.cwd });
  }

  async killPane(paneId: string): Promise<void> {
    try {
      await this.client().closePane(paneId, { cwd: this.cwd });
    } catch (error) {
      if (error instanceof Error && !error.message.toLowerCase().includes("not found")) {
        throw error;
      }
    }
  }

  async capturePane(paneId: string, lines = 120): Promise<PaneCapture> {
    return { text: await this.client().readPane(paneId, lines, { cwd: this.cwd }) };
  }

  private client(): HerdrClient {
    return new HerdrClient((args, options) => this.exec("herdr", args, options));
  }
}

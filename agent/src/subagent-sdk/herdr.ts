import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { errorMessage } from "../utils/error-message.js";
import type { CreatePaneOptions, MuxAdapter, PaneCapture, PaneSubmitMode } from "./mux.js";

type ExecFunction = (command: string, args: string[], options?: ExecOptions) => Promise<ExecResult>;

const HerdrPaneResponseSchema = Type.Object({
  result: Type.Optional(
    Type.Object({
      pane: Type.Optional(Type.Object({ pane_id: Type.Optional(Type.String()) })),
      root_pane: Type.Optional(Type.Object({ pane_id: Type.Optional(Type.String()) })),
    }),
  ),
});

type HerdrPaneResponse = Static<typeof HerdrPaneResponseSchema>;

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

function parseJson(stdout: string, action: string): HerdrPaneResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new Error(`herdr ${action} returned invalid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }

  if (!Value.Check(HerdrPaneResponseSchema, parsed)) {
    throw new Error(`herdr ${action} returned unexpected JSON`);
  }
  return Value.Parse(HerdrPaneResponseSchema, parsed);
}

function getCreatedPaneId(response: HerdrPaneResponse, action: string): string {
  const paneId = response.result?.pane?.pane_id ?? response.result?.root_pane?.pane_id;
  if (typeof paneId !== "string" || paneId.length === 0) {
    throw new Error(`herdr ${action} did not return a pane id`);
  }
  return paneId;
}

export class HerdrAdapter implements MuxAdapter {
  readonly backend = "herdr";

  constructor(
    private readonly exec: ExecFunction,
    private readonly cwd: string,
  ) {}

  async isAvailable(): Promise<boolean> {
    if (process.env.HERDR_ENV !== "1") {
      return false;
    }

    try {
      const result = await this.exec("herdr", ["status", "server"], {
        cwd: this.cwd,
        timeout: HERDR_AVAILABILITY_TIMEOUT_MS,
      });
      return result.code === 0;
    } catch {
      return false;
    }
  }

  async createPane(options: CreatePaneOptions): Promise<{ paneId: string }> {
    const args =
      options.target === "window"
        ? [
            "tab",
            "create",
            ...currentWorkspaceArgs(),
            "--cwd",
            options.cwd,
            "--label",
            options.title,
            "--no-focus",
          ]
        : [
            "pane",
            "split",
            paneSplitTarget(),
            "--direction",
            "right",
            "--cwd",
            options.cwd,
            "--no-focus",
          ];

    const action = options.target === "window" ? "create tab" : "split pane";
    const result = await this.exec("herdr", args, { cwd: this.cwd });
    this.assertOk(result, action);

    const paneId = getCreatedPaneId(parseJson(result.stdout, action), action);
    await this.exec("herdr", ["pane", "rename", paneId, options.title], { cwd: this.cwd });
    await this.assertRun(paneId, ` ${wrapCommandWithSelfClose(options.command, paneId)}`);
    return { paneId };
  }

  async sendText(
    paneId: string,
    text: string,
    submitMode: PaneSubmitMode = "steer",
  ): Promise<void> {
    this.assertOk(
      await this.exec("herdr", ["pane", "send-text", paneId, `\u001B[200~${text}\u001B[201~`], {
        cwd: this.cwd,
      }),
      "send text",
    );
    this.assertOk(
      await this.exec("herdr", ["pane", "send-keys", paneId, SUBMIT_KEYS[submitMode]], {
        cwd: this.cwd,
      }),
      "submit text",
    );
  }

  async paneExists(paneId: string): Promise<boolean> {
    const result = await this.exec("herdr", ["pane", "get", paneId], { cwd: this.cwd });
    return result.code === 0;
  }

  async killPane(paneId: string): Promise<void> {
    const result = await this.exec("herdr", ["pane", "close", paneId], { cwd: this.cwd });
    if (result.code !== 0 && !result.stderr.toLowerCase().includes("not found")) {
      this.assertOk(result, "close pane");
    }
  }

  async capturePane(paneId: string, lines = 120): Promise<PaneCapture> {
    const result = await this.exec(
      "herdr",
      ["pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
      { cwd: this.cwd },
    );
    this.assertOk(result, "read pane");
    return { text: result.stdout };
  }

  private async assertRun(paneId: string, command: string): Promise<void> {
    this.assertOk(
      await this.exec("herdr", ["pane", "run", paneId, command], { cwd: this.cwd }),
      "run command",
    );
  }

  private assertOk(result: ExecResult, action: string): void {
    if (result.code === 0) {
      return;
    }

    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`herdr ${action} failed: ${detail}`);
  }
}

function currentWorkspaceArgs(): string[] {
  const workspaceId = process.env.HERDR_WORKSPACE_ID;
  return workspaceId === undefined || workspaceId.length === 0 ? [] : ["--workspace", workspaceId];
}

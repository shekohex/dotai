import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { isChildSession } from "../../subagent-sdk/index.js";
import type { ChildBootstrapState } from "../../subagent-sdk/types.js";
import type { ToolTitleActivity } from "./tool-presentations.js";

const TITLE_SPINNER_INTERVAL_MS = 100;
const CONFIG_DIR_NAME = ".pi";

const TitleSpinnerSettingsSchema = Type.Object({
  terminal: Type.Optional(
    Type.Object({
      titleSpinner: Type.Optional(Type.Boolean()),
    }),
  ),
});

export const titleSpinnerRuntime = {
  getAgentDir,
  existsSync,
  readFileSync,
};

export type TitleActivity =
  | ToolTitleActivity
  | "compacting"
  | "responding"
  | "thinking"
  | "toolcall";

type TitleSpinnerProfile = { frames: readonly string[] };

type TitleSpinnerSettings = Static<typeof TitleSpinnerSettingsSchema>;

const TITLE_SPINNER_PROFILES: Record<TitleActivity, TitleSpinnerProfile> = {
  thinking: { frames: ["·", "✻", "✽", "✶", "✳", "✢"] },
  responding: { frames: ["⠋", "⠙", "⠚", "⠞", "⠖", "⠦", "⠴", "⠲", "⠳", "⠓"] },
  toolcall: { frames: ["◜", "◠", "◝", "◞", "◡", "◟"] },
  compacting: { frames: ["∙∙∙", "●∙∙", "∙●∙", "∙∙●", "∙∙∙"] },
  reading: { frames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] },
  editing: { frames: ["⠋", "⠙", "⠚", "⠞", "⠖", "⠦", "⠴", "⠲", "⠳", "⠓"] },
  git: { frames: ["✶", "✸", "✹", "✺", "✹", "✷"] },
  bash: { frames: ["-", "\\", "|", "/"] },
  searching: { frames: ["∙∙∙", "●∙∙", "∙●∙", "∙∙●", "∙∙∙"] },
  web: { frames: ["◜", "◠", "◝", "◞", "◡", "◟"] },
  subagent: {
    frames: ["✶", "✸", "✹", "✺", "✹", "✷"],
  },
  running: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] },
};

const titleBase = (pi: ExtensionAPI, ctx: ExtensionContext): string => {
  const cwd = basename(ctx.cwd);
  const sessionName = pi.getSessionName();
  return sessionName === undefined || sessionName.length === 0
    ? `π - ${cwd}`
    : `π - ${sessionName} - ${cwd}`;
};

const readTitleSpinnerSettings = (filePath: string): TitleSpinnerSettings => {
  try {
    if (!titleSpinnerRuntime.existsSync(filePath)) return {};
    const parsed: unknown = JSON.parse(
      titleSpinnerRuntime.readFileSync(filePath, { encoding: "utf8" }),
    );
    return Value.Check(TitleSpinnerSettingsSchema, parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const getTitleSpinnerEnabled = (ctx: ExtensionContext): boolean => {
  const globalSettings = readTitleSpinnerSettings(
    join(titleSpinnerRuntime.getAgentDir(), "settings.json"),
  );
  const projectSettings = readTitleSpinnerSettings(join(ctx.cwd, CONFIG_DIR_NAME, "settings.json"));
  return projectSettings.terminal?.titleSpinner ?? globalSettings.terminal?.titleSpinner ?? false;
};

const setTitle = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  childState: ChildBootstrapState | undefined,
  prefix?: string,
): boolean => {
  try {
    if (!ctx.hasUI || isChildSession(childState, ctx)) return false;
    ctx.ui.setTitle(prefix === undefined ? titleBase(pi, ctx) : `${prefix} ${titleBase(pi, ctx)}`);
    return true;
  } catch {
    return false;
  }
};

export const createTitleSpinnerController = (
  pi: ExtensionAPI,
  childState?: ChildBootstrapState,
) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  let activity: TitleActivity = "running";
  let renderedSpinner = false;

  const clearTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const stop = (ctx: ExtensionContext): void => {
    const shouldRestoreTitle = renderedSpinner || getTitleSpinnerEnabled(ctx);
    clearTimer();
    frameIndex = 0;
    renderedSpinner = false;
    if (!shouldRestoreTitle) return;
    setTitle(pi, ctx, childState);
  };

  const render = (ctx: ExtensionContext): void => {
    const profile = TITLE_SPINNER_PROFILES[activity];
    const frame = profile.frames[frameIndex % profile.frames.length];
    if (!setTitle(pi, ctx, childState, frame)) {
      clearTimer();
      return;
    }
    renderedSpinner = true;
    frameIndex += 1;
  };

  const start = (ctx: ExtensionContext, nextActivity: TitleActivity): void => {
    stop(ctx);
    if (!getTitleSpinnerEnabled(ctx)) return;
    if (isChildSession(childState, ctx)) return;
    activity = nextActivity;
    if (!ctx.hasUI) return;
    render(ctx);
    timer = setInterval(() => {
      render(ctx);
    }, TITLE_SPINNER_INTERVAL_MS);
  };

  const setActivity = (ctx: ExtensionContext, nextActivity: TitleActivity): void => {
    if (activity === nextActivity && timer !== undefined) return;
    start(ctx, nextActivity);
  };

  return { setActivity, start, stop };
};

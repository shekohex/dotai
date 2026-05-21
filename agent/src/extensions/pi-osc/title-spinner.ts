import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import type { ToolTitleActivity } from "./tool-presentations.js";

const TITLE_SPINNER_INTERVAL_MS = 100;

export type TitleActivity =
  | ToolTitleActivity
  | "compacting"
  | "responding"
  | "thinking"
  | "toolcall";

type TitleSpinnerProfile = { frames: readonly string[] };

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
  subagent: { frames: ["☱", "☲", "☴"] },
  running: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] },
};

const titleBase = (pi: ExtensionAPI, ctx: ExtensionContext): string => {
  const cwd = basename(ctx.cwd);
  const sessionName = pi.getSessionName();
  return sessionName === undefined || sessionName.length === 0
    ? `π - ${cwd}`
    : `π - ${sessionName} - ${cwd}`;
};

const setTitle = (pi: ExtensionAPI, ctx: ExtensionContext, prefix?: string): boolean => {
  try {
    if (!ctx.hasUI) return false;
    ctx.ui.setTitle(prefix === undefined ? titleBase(pi, ctx) : `${prefix} ${titleBase(pi, ctx)}`);
    return true;
  } catch {
    return false;
  }
};

export const createTitleSpinnerController = (pi: ExtensionAPI) => {
  let timer: ReturnType<typeof setInterval> | undefined;
  let frameIndex = 0;
  let activity: TitleActivity = "running";

  const clearTimer = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const stop = (ctx: ExtensionContext): void => {
    clearTimer();
    frameIndex = 0;
    setTitle(pi, ctx);
  };

  const render = (ctx: ExtensionContext): void => {
    const profile = TITLE_SPINNER_PROFILES[activity];
    const frame = profile.frames[frameIndex % profile.frames.length];
    if (!setTitle(pi, ctx, frame)) {
      clearTimer();
      return;
    }
    frameIndex += 1;
  };

  const start = (ctx: ExtensionContext, nextActivity: TitleActivity): void => {
    stop(ctx);
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

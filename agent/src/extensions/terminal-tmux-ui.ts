import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  createTmuxPassthroughSequence,
  getTmuxClientTty,
  getTmuxPaneTty,
  isSshSession,
  terminalNotifyRuntime,
} from "./terminal-notify.js";
import { isStaleSessionReplacementContextError } from "./session-replacement.js";

const ESC = "\u001B";
const BEL = "\u0007";
const OSC_CONTROL_CHARACTERS = /\p{Cc}/gu;
const TERMINAL_PROGRESS_ACTIVE_SEQUENCE = `${ESC}]9;4;3${BEL}`;
const TERMINAL_PROGRESS_CLEAR_SEQUENCE = `${ESC}]9;4;0;${BEL}`;

const sanitizeTitle = (value: string): string =>
  value.replaceAll(OSC_CONTROL_CHARACTERS, " ").trim();

export const isTmuxSession = (): boolean =>
  process.env.TMUX !== undefined && process.env.TMUX.length > 0;

export const createOscTitleSequence = (title: string): string =>
  `${ESC}]0;${sanitizeTitle(title)}${BEL}`;

export const createClearOscTitleSequence = (): string => `${ESC}]0;${BEL}`;

const writeTmuxSequence = (targetPath: string, sequence: string): boolean => {
  try {
    terminalNotifyRuntime.writeFileSync(targetPath, sequence, { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
};

export const writeTmuxUiSequence = (sequence: string): boolean => {
  const paneTty = getTmuxPaneTty();
  if (paneTty === null) {
    return false;
  }

  if (isSshSession()) {
    const clientTty = getTmuxClientTty();
    if (clientTty !== null) {
      if (writeTmuxSequence(clientTty, sequence)) {
        return true;
      }

      if (writeTmuxSequence(clientTty, createTmuxPassthroughSequence(sequence))) {
        return true;
      }
    }
  }

  return writeTmuxSequence(paneTty, createTmuxPassthroughSequence(sequence));
};

export const emitTmuxTitle = (title: string): boolean =>
  writeTmuxUiSequence(createOscTitleSequence(title));

export const clearTmuxTitle = (): boolean => writeTmuxUiSequence(createClearOscTitleSequence());

export const emitTmuxProgress = (active: boolean): boolean =>
  writeTmuxUiSequence(
    active ? TERMINAL_PROGRESS_ACTIVE_SEQUENCE : TERMINAL_PROGRESS_CLEAR_SEQUENCE,
  );

type SessionNameReader = Pick<ExtensionAPI, "getSessionName"> | ExtensionContext["sessionManager"];

export const getDefaultTmuxTitle = (sessionNameReader: SessionNameReader, cwd: string): string => {
  const sessionName = sessionNameReader.getSessionName();
  const cwdBasename = path.basename(cwd);
  return sessionName !== undefined && sessionName.length > 0
    ? `π - ${sessionName} - ${cwdBasename}`
    : `π - ${cwdBasename}`;
};

export default function terminalTmuxUiExtension(pi: ExtensionAPI): void {
  const updateTitle = (ctx: ExtensionContext): void => {
    if (!isTmuxSession()) {
      return;
    }

    try {
      emitTmuxTitle(getDefaultTmuxTitle(ctx.sessionManager, ctx.cwd));
    } catch (error) {
      if (!isStaleSessionReplacementContextError(error)) {
        throw error;
      }
    }
  };

  pi.on("session_start", (_event, ctx) => {
    updateTitle(ctx);
  });

  pi.on("before_agent_start", (_event, ctx) => {
    updateTitle(ctx);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!isTmuxSession()) {
      return;
    }

    updateTitle(ctx);
    emitTmuxProgress(true);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!isTmuxSession()) {
      return;
    }

    emitTmuxProgress(false);
    updateTitle(ctx);
  });

  pi.on("compaction_start", (_event, ctx) => {
    if (!isTmuxSession()) {
      return;
    }

    updateTitle(ctx);
    emitTmuxProgress(true);
  });

  pi.on("compaction_end", (_event, ctx) => {
    if (!isTmuxSession()) {
      return;
    }

    emitTmuxProgress(false);
    updateTitle(ctx);
  });

  pi.on("session_shutdown", () => {
    if (!isTmuxSession()) {
      return;
    }

    emitTmuxProgress(false);
    clearTmuxTitle();
  });
}

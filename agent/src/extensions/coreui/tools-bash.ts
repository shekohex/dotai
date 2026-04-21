import { formatDurationHuman, summarizeLineCount } from "./tools-output.js";

type BashTheme = {
  fg: (token: "dim" | "toolDiffAdded" | "error", value: string) => string;
};

export type BashOutputSummary = {
  lineCount: number;
  exitCode?: string;
  renderedText: string;
};

type BashRuntimeState = {
  startedAt?: number;
  endedAt?: number;
  completed?: boolean;
  interval?: ReturnType<typeof setInterval>;
};

export function summarizeBashOutput(
  output: string,
  renderOutput: (text: string) => string,
): BashOutputSummary {
  if (!output) {
    return { lineCount: 0, renderedText: "" };
  }

  const lines = output.split("\n");
  const exitLine = [...lines].toReversed().find((line: string) => /^exit code:/i.test(line.trim()));
  const exitCode = exitLine?.match(/exit code:\s*(-?\d+)/i)?.[1];
  const bodyLines = lines.filter(
    (line) => line.trim().length > 0 && line !== exitLine && !line.trimStart().startsWith("> "),
  );
  const visibleLines =
    bodyLines.length > 0
      ? bodyLines
      : lines.filter((line) => line.trim().length > 0 && line !== exitLine);

  return {
    lineCount: visibleLines.length,
    exitCode,
    renderedText: renderOutput(visibleLines.join("\n")),
  };
}

export function syncBashRenderState<TState extends BashRuntimeState>(input: {
  state: TState;
  executionStarted?: boolean;
  invalidate: () => void;
  isPartial: boolean;
}): TState {
  const state = input.state;

  if (input.executionStarted === true && state.startedAt === undefined) {
    state.startedAt = Date.now();
    state.endedAt = undefined;
    state.completed = false;
  }

  if (!input.isPartial) {
    state.completed = true;
    state.endedAt ??= Date.now();
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
    return state;
  }

  if (state.completed === true) {
    if (state.interval) {
      clearInterval(state.interval);
      state.interval = undefined;
    }
    return state;
  }

  if (state.startedAt !== undefined && !state.interval) {
    state.interval = setInterval(() => {
      input.invalidate();
    }, 1000);
    state.interval.unref?.();
  }

  return state;
}

export function isBashRenderPartial(state: BashRuntimeState, isPartial: boolean): boolean {
  return isPartial && state.completed !== true;
}

export function getBashElapsed(state: BashRuntimeState): number | undefined {
  if (state.startedAt === undefined) {
    return undefined;
  }

  return (state.endedAt ?? Date.now()) - state.startedAt;
}

export function formatBashTimeoutSuffix(theme: BashTheme, timeout?: number): string {
  if (timeout === undefined) {
    return "";
  }

  return theme.fg("dim", ` (${formatDurationHuman(timeout * 1000)})`);
}

export function formatElapsedSuffix(theme: BashTheme, elapsedMs?: number): string {
  if (elapsedMs === undefined) {
    return "";
  }

  return theme.fg("dim", ` ${formatDurationHuman(elapsedMs)}`);
}

export function formatElapsedFooter(elapsedMs?: number): string | undefined {
  if (elapsedMs === undefined) {
    return undefined;
  }

  return `Took ${formatDurationHuman(elapsedMs)}`;
}

export function formatPartialBashFooter(lineCount: number, elapsedMs?: number): string {
  const lineSummary = `${summarizeLineCount(lineCount)} so far`;
  if (elapsedMs === undefined) {
    return lineSummary;
  }

  return `${lineSummary} (${formatDurationHuman(elapsedMs)})`;
}

export function formatBashResultSummary(
  theme: BashTheme,
  lineCount: number,
  exitCode: string | undefined,
  isError: boolean | undefined,
  lineCountFirst: boolean,
): string {
  const lineSummary = theme.fg("dim", summarizeLineCount(lineCount));
  const exitStatus = formatBashExitStatus(theme, exitCode, isError);
  const separator = theme.fg("dim", " · ");

  if (lineCountFirst) {
    return `${lineSummary}${separator}${exitStatus}`;
  }

  return `${separator}${exitStatus} ${lineSummary}`;
}

export function formatCollapsedBashResultSummary(
  theme: BashTheme,
  lineCount: number,
  exitCode: string | undefined,
  isError: boolean | undefined,
  elapsedMs?: number,
): string {
  const exitStatus = formatBashExitStatus(theme, exitCode, isError);
  const elapsedSummary = formatCollapsedElapsedSummary(theme, elapsedMs);
  const lineSummary = theme.fg("dim", ` (${summarizeLineCount(lineCount)})`);

  return `${theme.fg("dim", " · ")}${exitStatus}${elapsedSummary}${lineSummary}`;
}

function formatCollapsedElapsedSummary(theme: BashTheme, elapsedMs?: number): string {
  if (!hasVisibleDuration(elapsedMs)) {
    return "";
  }

  return theme.fg("dim", ` took ${formatDurationHuman(elapsedMs)}`);
}

function hasVisibleDuration(elapsedMs?: number): elapsedMs is number {
  if (elapsedMs === undefined) {
    return false;
  }

  return Math.floor(elapsedMs / 1000) > 0;
}

function formatBashExitStatus(theme: BashTheme, exitCode?: string, isError?: boolean): string {
  if (isError !== true && (exitCode === undefined || exitCode === "0")) {
    return theme.fg("toolDiffAdded", "ok");
  }

  return theme.fg("error", `exit ${exitCode ?? "1"}`);
}

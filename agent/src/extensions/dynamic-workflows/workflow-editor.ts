/**
 * "Workflows mode" input affordance, à la a smart input box:
 *
 * - While the editor text contains the word `workflow`/`workflows`, those letters render as a flowing
 *   rainbow, signalling that submitting will engage a workflow.
 * - Pressing Backspace immediately after such a word toggles the highlight OFF (the word stays, but
 *   turns plain white) — a non-destructive "don't run a workflow after all". Re-typing a fresh
 *   trigger word turns it back on.
 * - When the highlight is ON at submit time, the user's message is transformed to instruct Pi to
 *   actually run the workflow tool.
 *
 * Implementation: we replace the core editor with a thin subclass of the exported `CustomEditor`
 * (which itself extends pi-tui's `Editor`), overriding only `render()` (to colorize) and
 * `handleInput()` (for the Backspace toggle). All other editor behavior — history, autocomplete,
 * paste, undo, multiline — is inherited untouched.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// A trigger is `workflow`/`workflows` (substring, case-insensitive) that is NOT
// immediately preceded by `/` — so a slash command like `/workflows` or `/workflow`
// is left alone (not colored, not armed).
const TRIGGER = /(?<!\/)workflows?/i;
const TRIGGER_G = /(?<!\/)workflows?/gi;
const TRIGGER_AT_END = /(?<!\/)workflows?$/i;

/** 256-color ring cycling through the spectrum — shifted by a tick to "flow". */
export const RAINBOW = [
  196, 160, 202, 166, 208, 172, 214, 178, 220, 184, 226, 190, 118, 82, 46, 47, 48, 49, 50, 51, 45,
  39, 33, 27, 21, 57, 93, 129, 165, 201, 198, 197,
];

/**
 * @param {string} text Text to scan.
 * @returns {boolean} Whether text contains workflow trigger.
 */
export function hasTrigger(text: string): boolean {
  return TRIGGER.test(text);
}

/**
 * @param {string} textBeforeCursor Text before cursor.
 * @returns {boolean} Whether text ends with workflow trigger.
 */
export function endsWithTrigger(textBeforeCursor: string): boolean {
  return TRIGGER_AT_END.test(textBeforeCursor);
}

/** Shared, mutable view of whether "workflows mode" is currently armed. */
export interface WorkflowModeState {
  active: boolean;
  disabled: boolean;
  tick: number;
  wasTriggered: boolean;
  conversationEmpty: boolean;
  toolEnabled: boolean;
}

interface AnsiToken {
  esc?: string;
  ch?: string;
}

/**
 * Split a rendered line into ANSI-escape tokens (passed through verbatim) and single
 * visible-character tokens. Handles CSI sequences (`\x1b[…m`, e.g. the cursor's inverse-video) and
 * APC/OSC string sequences (e.g. the zero-width `CURSOR_MARKER` = `\x1b_pi:c\x07`) so colorization
 * never corrupts them.
 *
 * @param {string} line Rendered line.
 * @returns {AnsiToken[]} ANSI and visible character tokens.
 */
export function tokenizeAnsi(line: string): AnsiToken[] {
  const tokens: AnsiToken[] = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\u001B") {
      let j = i + 1;
      const next = line[j];
      if (next === "[") {
        // CSI: ends at a final byte in 0x40–0x7e.
        j++;
        while (j < line.length && !(line[j] >= "@" && line[j] <= "~")) j++;
        j++;
      } else if (next === "]" || next === "_" || next === "P" || next === "^") {
        // String sequence: ends at BEL (\x07) or ST (\x1b\\).
        j++;
        while (
          j < line.length &&
          line[j] !== "\u0007" &&
          !(line[j] === "\u001B" && line[j + 1] === "\\")
        )
          j++;
        if (line[j] === "\u0007") j++;
        else if (line[j] === "\u001B") j += 2;
      } else {
        j++;
      }
      tokens.push({ esc: line.slice(i, j) });
      i = j;
    } else {
      tokens.push({ ch: line[i] });
      i++;
    }
  }
  return tokens;
}

/**
 * Colorize every `workflow`/`workflows` occurrence in a rendered line with a flowing rainbow,
 * leaving all ANSI escapes (cursor, markers) intact. Returns the line unchanged when it contains no
 * trigger.
 *
 * @param {string} line Rendered line.
 * @param {number} tick Animation tick.
 * @param {number[]} palette Color palette.
 * @returns {string} Colorized line.
 */
export function colorizeWorkflow(line: string, tick: number, palette: number[] = RAINBOW): string {
  const tokens = tokenizeAnsi(line);
  const visible = tokens
    .filter((t) => t.ch !== undefined)
    .map((t) => t.ch)
    .join("");
  if (!TRIGGER.test(visible)) return line;

  const ranges: Array<[number, number]> = [];
  TRIGGER_G.lastIndex = 0;
  for (let m = TRIGGER_G.exec(visible); m; m = TRIGGER_G.exec(visible)) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  const inRange = (idx: number) => ranges.some(([s, e]) => idx >= s && idx < e);

  let out = "";
  let vi = 0;
  for (const t of tokens) {
    if (t.esc !== undefined) {
      out += t.esc;
      continue;
    }
    if (inRange(vi)) {
      const color = palette[(vi + tick) % palette.length];
      // Reset only the foreground (39) afterwards so a surrounding inverse-video
      // (the cursor) is preserved.
      out += `\u001B[38;5;${color}m${t.ch}\u001B[39m`;
    } else {
      out += t.ch ?? "";
    }
    vi++;
  }
  return out;
}

/**
 * Backspace arrives as DEL (0x7f) or BS (0x08) depending on the terminal.
 *
 * @param {string} data Input data.
 * @returns {boolean} Whether input is backspace.
 */
export function createWorkflowModeState(): WorkflowModeState {
  return {
    active: false,
    disabled: false,
    tick: 0,
    wasTriggered: false,
    conversationEmpty: true,
    toolEnabled: false,
  };
}

const sharedWorkflowModeState = createWorkflowModeState();

export function getWorkflowModeState(): WorkflowModeState {
  return sharedWorkflowModeState;
}

export function isWorkflowBackspace(data: string): boolean {
  return data === "\u007F" || data === "\b";
}

export function isWorkflowModeActive(state: WorkflowModeState, text: string): boolean {
  return !state.disabled && (state.conversationEmpty || state.toolEnabled) && hasTrigger(text);
}

export function syncWorkflowModeState(state: WorkflowModeState, text: string): void {
  state.active = isWorkflowModeActive(state, text);
}

export function shouldDisarmWorkflowModeOnInput(
  data: string,
  state: WorkflowModeState,
  textBeforeCursor: string,
): boolean {
  return isWorkflowBackspace(data) && state.active && endsWithTrigger(textBeforeCursor);
}

export function disarmWorkflowMode(state: WorkflowModeState): void {
  state.disabled = true;
  state.active = false;
}

export function updateWorkflowModeAfterTextChange(
  state: WorkflowModeState,
  before: string,
  after: string,
): void {
  if (after !== before) {
    const now = hasTrigger(after);
    if (now && !state.wasTriggered) state.disabled = false;
    state.wasTriggered = now;
  }
  syncWorkflowModeState(state, after);
}

export function nextWorkflowAnimationTick(tick: number): number {
  return (tick + 1) % (RAINBOW.length * 6);
}

export function colorizeWorkflowLines(lines: string[], state: WorkflowModeState): string[] {
  if (!state.active || lines.length === 0) return lines;
  return lines.map((line) => colorizeWorkflow(line, state.tick));
}

/**
 * The directive appended to a submitted message when workflows mode is armed.
 *
 * @param {string} text Original text.
 * @returns {string} Forced workflow prompt.
 */
export function buildForcedWorkflowPrompt(text: string): string {
  return [
    text,
    "",
    "---",
    "[workflows mode is ON for this message]",
    "You MUST handle this request by calling the tool named exactly `workflow` (Pi's",
    "deterministic JavaScript workflow-orchestration tool from pi-dynamic-workflows).",
    "Write a workflow script that fans the task out across subagents via",
    "agent()/parallel()/pipeline().",
    "",
    "The ONLY acceptable action is a `workflow` tool call. Do NOT instead:",
    "- answer directly or in prose,",
    "- call the `subagent` tool yourself,",
    "- use any skill or command (e.g. pi-subagents, /code-review, deep-research),",
    '- or interpret the word "workflow/workflows" loosely as some other parallel/audit approach.',
    "Even for a small task, wrap it in a minimal `workflow` call with at least one agent().",
  ].join("\n");
}

/**
 * Install the workflows-mode editor and the submit-time forcing hook. Call once with the UI context
 * (e.g. in `session_start`).
 */
/** The exact name of the workflow tool that workflows mode forces. */
export const WORKFLOW_TOOL_NAME = "workflow";

export function isConversationStart(ctx: ExtensionContext | undefined): boolean {
  const branch = ctx?.sessionManager.getBranch() ?? [];
  return !branch.some((entry) => {
    const role = sessionEntryRole(entry);
    return role === "user" || role === "assistant";
  });
}

export function setWorkflowModeAvailability(
  state: WorkflowModeState,
  input: { conversationEmpty: boolean; toolEnabled: boolean },
): void {
  state.conversationEmpty = input.conversationEmpty;
  state.toolEnabled = input.toolEnabled;
}

function sessionEntryRole(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null) return undefined;
  if ("role" in entry) return entry.role;
  if (!("message" in entry)) return undefined;
  const message = entry.message;
  if (typeof message !== "object" || message === null || !("role" in message)) return undefined;
  return message.role;
}

export function installWorkflowInputHooks(
  pi: ExtensionAPI,
  state: WorkflowModeState,
  options?: { activateWorkflowTool(): void },
): void {
  // Active tools saved while a turn is restricted to `workflow`; restored on turn_end.
  let savedTools: string[] | undefined;

  // When armed at submit time, rewrite the user's message to force a workflow AND
  // restrict this turn's tools to just `workflow`, so the model can't fall back to
  // the subagent tool, a skill, or a direct answer. Restored at turn_end.
  pi.on("input", (event: { source?: string; text?: string }, ctx) => {
    if (
      event.source !== "interactive" ||
      !state.active ||
      event.text === undefined ||
      event.text === ""
    )
      return { action: "continue" } as const;
    if (!isConversationStart(ctx)) {
      state.active = false;
      return { action: "continue" } as const;
    }
    let activeTools = pi.getActiveTools?.();
    if (
      Array.isArray(activeTools) &&
      !activeTools.includes(WORKFLOW_TOOL_NAME) &&
      options !== undefined
    ) {
      options.activateWorkflowTool();
      activeTools = pi.getActiveTools?.();
    }
    if (!Array.isArray(activeTools) || !activeTools.includes(WORKFLOW_TOOL_NAME)) {
      state.active = false;
      return { action: "continue" } as const;
    }
    state.active = false;
    try {
      savedTools ??= activeTools;
      pi.setActiveTools?.([WORKFLOW_TOOL_NAME]);
    } catch {
      // Tool restriction is best-effort; the directive still forces the workflow.
    }
    return { action: "transform", text: buildForcedWorkflowPrompt(event.text) } as const;
  });

  // Restore the user's full tool set once the forced turn completes.
  pi.on("turn_end", () => {
    if (savedTools === undefined) return;
    const restore = savedTools;
    savedTools = undefined;
    try {
      pi.setActiveTools?.(restore);
    } catch {
      // ignore — nothing we can do if the host rejects the restore
    }
  });
}

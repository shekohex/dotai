/**
 * What the chat timeline shows for Conductor's own traffic: steer notes become a small chip the
 * user can expand, and calls of the progress tool become cards instead of raw JSON. Pure so the
 * client transformers stay thin and this stays testable.
 */
import { isProgressToolName, type ProgressInput } from "./progress.js";

export const NOTE_KIND = "conductor-note";
export const BRIEF_KIND = "conductor-brief";
export const CALL_KIND = "conductor-progress-call";

const SYSTEM_NOTE = /^\s*<paseo-system>\s*([\s\S]*?)\s*<\/paseo-system>\s*$/;

const BRIEF = /^\s*<conductor-brief>\s*([\s\S]*?)\s*<\/conductor-brief>\s*$/;

/** The text of a conductor's message to a worker, wrapped as the playbook asks, or null. */
export function briefBody(text: string): string | null {
  return BRIEF.exec(text)?.[1] ?? null;
}

/** The body of a `<paseo-system>` note, or null for anything else. */
export function systemNoteBody(text: string): string | null {
  return SYSTEM_NOTE.exec(text)?.[1] ?? null;
}

export interface NoteChip {
  icon: string;
  label: string;
}

const clip = (value: string, max: number): string =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/** A one-line label for a steer note; the full text stays one tap away. */
export function noteChip(body: string): NoteChip {
  const answered =
    /^(The user|The conductor|Agent \S+) answered (Q\d+) (?:options? (.+?)(?:, adding|\.)|in their own words)/.exec(
      body,
    );
  if (answered) {
    const who = answered[1] === "The user" ? "You" : answered[1];
    return {
      icon: "MessageSquareReply",
      label: `${who} answered ${answered[2]}${answered[3] ? `: ${answered[3]}` : ""}`,
    };
  }
  const asked = /^Agent \S+ asked (Q\d+) "([^"]*)"/.exec(body);
  if (asked)
    return {
      icon: "MessageCircleQuestion",
      label: `Worker asked ${asked[1]}: ${clip(asked[2] ?? "", 60)}`,
    };
  const checkIn = /^Quick check-in\b.*?\b([A-Z0-9]{1,3}-?\d+)/.exec(body);
  if (checkIn)
    return { icon: "BellRing", label: `Progress check-in on ${checkIn[1]}` };
  if (
    body.endsWith(
      " Decide: answer, unblock, or reassign; or leave it for the user.",
    )
  ) {
    const keys = [...body.matchAll(/(?:^|\. )(\S+) (?:blocked|stuck)\b/g)].map(
      (match) => match[1],
    );
    return { icon: "OctagonAlert", label: `Blocked: ${keys.join(", ")}` };
  }
  const resumed =
    /^Your (?:ticket|stuck flag) (\S+) is (?:marked blocked|still open) but you are running again/.exec(
      body,
    );
  if (resumed)
    return { icon: "OctagonAlert", label: `Still blocked? ${resumed[1]}` };
  const firstLine = body.split("\n")[0]?.trim() ?? "";
  return {
    icon: "Info",
    label: clip(firstLine.replace(/\.$/, ""), 90) || "System note",
  };
}

export type CallStatus = "running" | "completed" | "failed" | "canceled";

/** JSON-safe data for one progress tool call. */
export interface ProgressCall {
  input: Partial<ProgressInput> & { op: string };
  status: CallStatus;
  output?: string;
  error?: string;
}

/** Text out of whatever shape a provider reports for an MCP result. */
export function resultText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(resultText).filter(Boolean);
    return parts.length ? parts.join("\n") : undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if ("content" in record) return resultText(record.content);
    if ("message" in record && typeof record.message === "string")
      return record.message;
  }
  return undefined;
}

/** The call's data when a timeline tool call is ours, else null. */
export function progressCall(item: {
  name: string;
  status: string;
  error: unknown;
  detail: { type: string; input?: unknown; output?: unknown };
}): ProgressCall | null {
  if (!isProgressToolName(item.name)) return null;
  const raw = item.detail.type === "unknown" ? item.detail.input : undefined;
  const parsed: unknown =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return null;
          }
        })()
      : raw;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const input = JSON.parse(JSON.stringify(parsed)) as ProgressCall["input"];
  if (typeof input.op !== "string") return null;
  const status = (
    ["running", "completed", "failed", "canceled"].includes(item.status)
      ? item.status
      : "completed"
  ) as CallStatus;
  const output =
    item.detail.type === "unknown" ? resultText(item.detail.output) : undefined;
  const error =
    status === "failed"
      ? (resultText(item.error) ?? output ?? "Failed")
      : undefined;
  return {
    input,
    status,
    ...(output && status !== "failed" ? { output } : {}),
    ...(error ? { error } : {}),
  };
}

export interface ShowSummary {
  title: string;
  finished?: string;
  percent: number;
  done: number;
  total: number;
  counts: Record<
    "working" | "blocked" | "not_started" | "questions" | "stuck",
    number
  >;
  now?: string;
}

/** Reads back what `renderForAgent` wrote, for the op=show card. */
export function parseShow(text: string | undefined): ShowSummary | null {
  const lines = (text ?? "").split("\n");
  const head =
    /^(.*?)(?: \[finished: (.*)\])? \| (\d+)% · (\d+) of (\d+) tickets done/.exec(
      lines[0] ?? "",
    );
  if (!head) return null;
  const counts = {
    working: 0,
    blocked: 0,
    not_started: 0,
    questions: 0,
    stuck: 0,
  };
  let now: string | undefined;
  for (const line of lines.slice(1)) {
    const ticket = /^[A-Z0-9]{1,3}-?\d+ (working|blocked|not_started)\b/.exec(
      line,
    );
    if (ticket) counts[ticket[1] as "working"] += 1;
    else if (/^Q\d+ open:/.test(line)) counts.questions += 1;
    else if (/^S\d+ stuck:/.test(line)) counts.stuck += 1;
    else if (line.startsWith("now: ")) now = line.slice(5);
  }
  return {
    title: head[1] ?? "",
    ...(head[2] ? { finished: head[2] } : {}),
    percent: Number(head[3]),
    done: Number(head[4]),
    total: Number(head[5]),
    counts,
    ...(now ? { now } : {}),
  };
}

import type { ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { Value } from "typebox/value";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";

function formatUsd(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

function estimateTokens(text: string): number {
  return Math.max(0, Math.ceil(text.length / 4));
}

function normalizeReadPath(inputPath: string, cwd: string): string {
  let p = inputPath;
  if (p.startsWith("@")) p = p.slice(1);
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/")) p = path.join(os.homedir(), p.slice(2));
  if (!path.isAbsolute(p)) p = path.resolve(cwd, p);
  return path.resolve(p);
}

function getAgentDir(): string {
  const envCandidates = ["PI_CODING_AGENT_DIR", "TAU_CODING_AGENT_DIR"];
  let envDir: string | undefined;
  for (const k of envCandidates) {
    const value = process.env[k];
    if (typeof value === "string" && value.length > 0) {
      envDir = value;
      break;
    }
  }
  if (envDir === undefined) {
    for (const [k, v] of Object.entries(process.env)) {
      if (k.endsWith("_CODING_AGENT_DIR") && v !== undefined && v.length > 0) {
        envDir = v;
        break;
      }
    }
  }
  if (envDir !== undefined && envDir.length > 0) {
    if (envDir === "~") return os.homedir();
    if (envDir.startsWith("~/")) return path.join(os.homedir(), envDir.slice(2));
    return envDir;
  }
  return path.join(os.homedir(), ".pi", "agent");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readFileIfExists(
  filePath: string,
): Promise<{ path: string; content: string; bytes: number } | null> {
  if (!existsSync(filePath)) return null;
  try {
    const buf = await fs.readFile(filePath);
    return { path: filePath, content: buf.toString("utf8"), bytes: buf.byteLength };
  } catch {
    return null;
  }
}

async function loadProjectContextFiles(
  cwd: string,
): Promise<Array<{ path: string; tokens: number; bytes: number }>> {
  const out: Array<{ path: string; tokens: number; bytes: number }> = [];
  const seen = new Set<string>();

  const loadFromDir = async (dir: string) => {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = path.join(dir, name);
      const f = await readFileIfExists(p);
      if (f && !seen.has(f.path)) {
        seen.add(f.path);
        out.push({ path: f.path, tokens: estimateTokens(f.content), bytes: f.bytes });
        return;
      }
    }
  };

  await loadFromDir(getAgentDir());

  const stack: string[] = [];
  let current = path.resolve(cwd);
  while (true) {
    stack.push(current);
    const parent = path.resolve(current, "..");
    if (parent === current) break;
    current = parent;
  }
  stack.reverse();
  for (const dir of stack) await loadFromDir(dir);

  return out;
}

function normalizeSkillName(name: string): string {
  return name.startsWith("skill:") ? name.slice("skill:".length) : name;
}

const SKILL_LOADED_ENTRY = "context:skill_loaded";

const SkillLoadedSessionEntrySchema = Type.Object(
  {
    type: Type.Literal("custom"),
    customType: Type.Literal(SKILL_LOADED_ENTRY),
    data: Type.Object({
      name: Type.String(),
      path: Type.String(),
    }),
  },
  { additionalProperties: true },
);

const AssistantUsageEntrySchema = Type.Object(
  {
    type: Type.Literal("message"),
    message: Type.Object(
      {
        role: Type.Literal("assistant"),
        usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      },
      { additionalProperties: true },
    ),
  },
  { additionalProperties: true },
);

function getLoadedSkillsFromSession(ctx: ExtensionContext): Set<string> {
  const out = new Set<string>();
  for (const e of ctx.sessionManager.getEntries()) {
    if (!Value.Check(SkillLoadedSessionEntrySchema, e)) {
      continue;
    }

    const data = Value.Parse(SkillLoadedSessionEntrySchema, e).data;
    if (data.name) out.add(data.name);
  }
  return out;
}

function extractCostTotal(usage: unknown): number {
  if (!isRecord(usage)) return 0;
  const c = usage.cost;
  if (typeof c === "number") return Number.isFinite(c) ? c : 0;
  if (typeof c === "string") {
    const n = Number(c);
    return Number.isFinite(n) ? n : 0;
  }
  if (isRecord(c)) {
    const t = c.total;
    if (typeof t === "number") return Number.isFinite(t) ? t : 0;
    if (typeof t === "string") {
      const n = Number(t);
      return Number.isFinite(n) ? n : 0;
    }
  }
  return 0;
}

function sumSessionUsage(ctx: ExtensionCommandContext): {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  totalCost: number;
} {
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalCost = 0;

  for (const entry of ctx.sessionManager.getEntries()) {
    if (!Value.Check(AssistantUsageEntrySchema, entry)) {
      continue;
    }

    const usage = Value.Parse(AssistantUsageEntrySchema, entry).message.usage;
    if (!usage) continue;
    input += Number(usage.inputTokens ?? 0) || 0;
    output += Number(usage.outputTokens ?? 0) || 0;
    cacheRead += Number(usage.cacheRead ?? 0) || 0;
    cacheWrite += Number(usage.cacheWrite ?? 0) || 0;
    totalCost += extractCostTotal(usage);
  }

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    totalCost,
  };
}

function shortenPath(p: string, cwd: string): string {
  const rp = path.resolve(p);
  const rc = path.resolve(cwd);
  if (rp === rc) return ".";
  if (rp.startsWith(rc + path.sep)) return "./" + rp.slice(rc.length + 1);
  return rp;
}

export {
  SKILL_LOADED_ENTRY,
  estimateTokens,
  formatUsd,
  getLoadedSkillsFromSession,
  loadProjectContextFiles,
  normalizeReadPath,
  normalizeSkillName,
  shortenPath,
  sumSessionUsage,
};

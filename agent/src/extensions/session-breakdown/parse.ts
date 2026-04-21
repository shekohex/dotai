import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { CwdKey, ModelKey, ParsedSession, UnknownRecord } from "./types.js";
import { DOW_NAMES, parseUnknownRecord, readStringField, todBucketForHour } from "./types.js";
import {
  isAbortRequested,
  localMidnight,
  modelKeyFromParts,
  mondayIndex,
  normalizeCwdValue,
  parseSessionStartFromFilename,
  parseTimestampValue,
  reportFoundProgress,
  toLocalDayKey,
} from "./utils.js";
import { extractCostTotal, extractProviderModelAndUsage, extractTokensTotal } from "./usage.js";

export async function walkSessionFiles(
  root: string,
  startCutoffLocal: Date,
  signal?: AbortSignal,
  onFound?: (found: number) => void,
): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    if (isAbortRequested(signal)) break;
    const dir = stack.pop();
    if (dir === undefined) {
      break;
    }
    let entries: Dirent[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const ent of entries) {
      if (isAbortRequested(signal)) break;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(p);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
      await maybeAddCandidateFile(out, p, ent.name, startCutoffLocal, onFound);
    }
  }
  onFound?.(out.length);
  return out;
}

async function maybeAddCandidateFile(
  out: string[],
  filePath: string,
  fileName: string,
  startCutoffLocal: Date,
  onFound: ((found: number) => void) | undefined,
): Promise<void> {
  const startedAt = parseSessionStartFromFilename(fileName);
  if (startedAt !== null) {
    if (localMidnight(startedAt) >= startCutoffLocal) {
      out.push(filePath);
      reportFoundProgress(onFound, out.length);
    }
    return;
  }

  try {
    const st = await fs.stat(filePath);
    const approx = new Date(st.mtimeMs);
    if (localMidnight(approx) >= startCutoffLocal) {
      out.push(filePath);
      reportFoundProgress(onFound, out.length);
    }
  } catch {}
}

type ParsedSessionAccumulator = {
  startedAt: Date | null;
  currentModel: ModelKey | null;
  cwd: CwdKey | null;
  modelsUsed: Set<ModelKey>;
  messages: number;
  tokens: number;
  totalCost: number;
  costByModel: Map<ModelKey, number>;
  messagesByModel: Map<ModelKey, number>;
  tokensByModel: Map<ModelKey, number>;
};

function createParsedSessionAccumulator(startedAt: Date | null): ParsedSessionAccumulator {
  return {
    startedAt,
    currentModel: null,
    cwd: null,
    modelsUsed: new Set<ModelKey>(),
    messages: 0,
    tokens: 0,
    totalCost: 0,
    costByModel: new Map<ModelKey, number>(),
    messagesByModel: new Map<ModelKey, number>(),
    tokensByModel: new Map<ModelKey, number>(),
  };
}

function parseSessionFileLine(line: string): UnknownRecord | undefined {
  if (line.length === 0) {
    return undefined;
  }

  try {
    return parseUnknownRecord(JSON.parse(line) as unknown);
  } catch {
    return undefined;
  }
}

function updateParsedSessionAccumulator(acc: ParsedSessionAccumulator, obj: UnknownRecord): void {
  const eventType = readStringField(obj, "type");
  if (eventType === "session") {
    updateParsedSessionFromSessionEvent(acc, obj);
    return;
  }

  if (eventType === "model_change") {
    updateParsedSessionFromModelChangeEvent(acc, obj);
    return;
  }

  if (eventType !== "message") {
    return;
  }

  updateParsedSessionFromMessageEvent(acc, obj);
}

function updateParsedSessionFromSessionEvent(
  acc: ParsedSessionAccumulator,
  obj: UnknownRecord,
): void {
  const timestamp =
    acc.startedAt === null ? parseTimestampValue(readStringField(obj, "timestamp")) : null;
  if (timestamp !== null) {
    acc.startedAt = timestamp;
  }

  const normalizedCwd = normalizeCwdValue(readStringField(obj, "cwd"));
  if (normalizedCwd !== undefined) {
    acc.cwd = normalizedCwd;
  }
}

function updateParsedSessionFromModelChangeEvent(
  acc: ParsedSessionAccumulator,
  obj: UnknownRecord,
): void {
  const mk = modelKeyFromParts(obj.provider, obj.modelId);
  if (mk !== null && mk.length > 0) {
    acc.currentModel = mk;
    acc.modelsUsed.add(mk);
  }
}

function updateParsedSessionFromMessageEvent(
  acc: ParsedSessionAccumulator,
  obj: UnknownRecord,
): void {
  const { provider, model, modelId, usage } = extractProviderModelAndUsage(obj);
  const mk =
    modelKeyFromParts(provider, model) ??
    modelKeyFromParts(provider, modelId) ??
    acc.currentModel ??
    "unknown";
  acc.modelsUsed.add(mk);
  acc.messages += 1;
  acc.messagesByModel.set(mk, (acc.messagesByModel.get(mk) ?? 0) + 1);

  const tok = extractTokensTotal(usage);
  if (tok > 0) {
    acc.tokens += tok;
    acc.tokensByModel.set(mk, (acc.tokensByModel.get(mk) ?? 0) + tok);
  }

  const cost = extractCostTotal(usage);
  if (cost > 0) {
    acc.totalCost += cost;
    acc.costByModel.set(mk, (acc.costByModel.get(mk) ?? 0) + cost);
  }
}

function finalizeParsedSession(
  filePath: string,
  acc: ParsedSessionAccumulator,
): ParsedSession | null {
  if (acc.startedAt === null) {
    return null;
  }

  const dayKeyLocal = toLocalDayKey(acc.startedAt);
  const dow = DOW_NAMES[mondayIndex(acc.startedAt)];
  const tod = todBucketForHour(acc.startedAt.getHours());
  return {
    filePath,
    startedAt: acc.startedAt,
    dayKeyLocal,
    cwd: acc.cwd,
    dow,
    tod,
    modelsUsed: acc.modelsUsed,
    messages: acc.messages,
    tokens: acc.tokens,
    totalCost: acc.totalCost,
    costByModel: acc.costByModel,
    messagesByModel: acc.messagesByModel,
    tokensByModel: acc.tokensByModel,
  };
}

export async function parseSessionFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<ParsedSession | null> {
  const fileName = path.basename(filePath);
  const acc = createParsedSessionAccumulator(parseSessionStartFromFilename(fileName));

  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of rl) {
      if (isAbortRequested(signal)) {
        rl.close();
        stream.destroy();
        return null;
      }
      const obj = parseSessionFileLine(line);
      if (obj === undefined) {
        continue;
      }
      updateParsedSessionAccumulator(acc, obj);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return finalizeParsedSession(filePath, acc);
}

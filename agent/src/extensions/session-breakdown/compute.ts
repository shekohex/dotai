import path from "node:path";
import {
  type BreakdownData,
  type BreakdownProgressState,
  type DayAgg,
  type ParsedSession,
  type RangeAgg,
  RANGE_DAYS,
  SESSION_ROOT,
} from "./types.js";
import { addDaysLocal, isAbortRequested, localMidnight, toLocalDayKey } from "./utils.js";
import { parseSessionFile, walkSessionFiles } from "./parse.js";
import {
  buildDowPalette,
  buildTodPalette,
  chooseCwdPaletteFromLast30Days,
  choosePaletteFromLast30Days,
} from "./palette.js";
import { sessionDayWithinRange } from "./metrics.js";

function createDayAggregation(date: Date): DayAgg {
  return {
    date,
    dayKeyLocal: toLocalDayKey(date),
    sessions: 0,
    messages: 0,
    tokens: 0,
    totalCost: 0,
    costByModel: new Map(),
    sessionsByModel: new Map(),
    messagesByModel: new Map(),
    tokensByModel: new Map(),
    sessionsByCwd: new Map(),
    messagesByCwd: new Map(),
    tokensByCwd: new Map(),
    costByCwd: new Map(),
    sessionsByTod: new Map(),
    messagesByTod: new Map(),
    tokensByTod: new Map(),
    costByTod: new Map(),
  };
}

function buildRangeAgg(days: number, now: Date): RangeAgg {
  const end = localMidnight(now);
  const start = addDaysLocal(end, -(days - 1));
  const outDays: DayAgg[] = [];
  const dayByKey = new Map<string, DayAgg>();

  for (let i = 0; i < days; i++) {
    const d = addDaysLocal(start, i);
    const day = createDayAggregation(d);
    outDays.push(day);
    dayByKey.set(day.dayKeyLocal, day);
  }

  return {
    days: outDays,
    dayByKey,
    sessions: 0,
    totalMessages: 0,
    totalTokens: 0,
    totalCost: 0,
    modelCost: new Map(),
    modelSessions: new Map(),
    modelMessages: new Map(),
    modelTokens: new Map(),
    cwdCost: new Map(),
    cwdSessions: new Map(),
    cwdMessages: new Map(),
    cwdTokens: new Map(),
    dowCost: new Map(),
    dowSessions: new Map(),
    dowMessages: new Map(),
    dowTokens: new Map(),
    todCost: new Map(),
    todSessions: new Map(),
    todMessages: new Map(),
    todTokens: new Map(),
  };
}

function addSessionTotals(range: RangeAgg, day: DayAgg, session: ParsedSession): void {
  range.sessions += 1;
  range.totalMessages += session.messages;
  range.totalTokens += session.tokens;
  range.totalCost += session.totalCost;
  day.sessions += 1;
  day.messages += session.messages;
  day.tokens += session.tokens;
  day.totalCost += session.totalCost;
}

function addSessionModelBreakdown(range: RangeAgg, day: DayAgg, session: ParsedSession): void {
  for (const mk of session.modelsUsed) {
    day.sessionsByModel.set(mk, (day.sessionsByModel.get(mk) ?? 0) + 1);
    range.modelSessions.set(mk, (range.modelSessions.get(mk) ?? 0) + 1);
  }
  for (const [mk, n] of session.messagesByModel.entries()) {
    day.messagesByModel.set(mk, (day.messagesByModel.get(mk) ?? 0) + n);
    range.modelMessages.set(mk, (range.modelMessages.get(mk) ?? 0) + n);
  }
  for (const [mk, n] of session.tokensByModel.entries()) {
    day.tokensByModel.set(mk, (day.tokensByModel.get(mk) ?? 0) + n);
    range.modelTokens.set(mk, (range.modelTokens.get(mk) ?? 0) + n);
  }
  for (const [mk, cost] of session.costByModel.entries()) {
    day.costByModel.set(mk, (day.costByModel.get(mk) ?? 0) + cost);
    range.modelCost.set(mk, (range.modelCost.get(mk) ?? 0) + cost);
  }
}

function addSessionCwdBreakdown(range: RangeAgg, day: DayAgg, session: ParsedSession): void {
  if (session.cwd === null || session.cwd.length === 0) {
    return;
  }

  const cwd = session.cwd;
  day.sessionsByCwd.set(cwd, (day.sessionsByCwd.get(cwd) ?? 0) + 1);
  range.cwdSessions.set(cwd, (range.cwdSessions.get(cwd) ?? 0) + 1);
  day.messagesByCwd.set(cwd, (day.messagesByCwd.get(cwd) ?? 0) + session.messages);
  range.cwdMessages.set(cwd, (range.cwdMessages.get(cwd) ?? 0) + session.messages);
  day.tokensByCwd.set(cwd, (day.tokensByCwd.get(cwd) ?? 0) + session.tokens);
  range.cwdTokens.set(cwd, (range.cwdTokens.get(cwd) ?? 0) + session.tokens);
  day.costByCwd.set(cwd, (day.costByCwd.get(cwd) ?? 0) + session.totalCost);
  range.cwdCost.set(cwd, (range.cwdCost.get(cwd) ?? 0) + session.totalCost);
}

function addSessionDowAndTodBreakdown(range: RangeAgg, day: DayAgg, session: ParsedSession): void {
  const dow = session.dow;
  range.dowSessions.set(dow, (range.dowSessions.get(dow) ?? 0) + 1);
  range.dowMessages.set(dow, (range.dowMessages.get(dow) ?? 0) + session.messages);
  range.dowTokens.set(dow, (range.dowTokens.get(dow) ?? 0) + session.tokens);
  range.dowCost.set(dow, (range.dowCost.get(dow) ?? 0) + session.totalCost);

  const tod = session.tod;
  day.sessionsByTod.set(tod, (day.sessionsByTod.get(tod) ?? 0) + 1);
  day.messagesByTod.set(tod, (day.messagesByTod.get(tod) ?? 0) + session.messages);
  day.tokensByTod.set(tod, (day.tokensByTod.get(tod) ?? 0) + session.tokens);
  day.costByTod.set(tod, (day.costByTod.get(tod) ?? 0) + session.totalCost);
  range.todSessions.set(tod, (range.todSessions.get(tod) ?? 0) + 1);
  range.todMessages.set(tod, (range.todMessages.get(tod) ?? 0) + session.messages);
  range.todTokens.set(tod, (range.todTokens.get(tod) ?? 0) + session.tokens);
  range.todCost.set(tod, (range.todCost.get(tod) ?? 0) + session.totalCost);
}

function addSessionToRange(range: RangeAgg, session: ParsedSession): void {
  const day = range.dayByKey.get(session.dayKeyLocal);
  if (!day) {
    return;
  }

  addSessionTotals(range, day, session);
  addSessionModelBreakdown(range, day, session);
  addSessionCwdBreakdown(range, day, session);
  addSessionDowAndTodBreakdown(range, day, session);
}

function createBreakdownRanges(now: Date): Map<number, RangeAgg> {
  const ranges = new Map<number, RangeAgg>();
  for (const d of RANGE_DAYS) {
    ranges.set(d, buildRangeAgg(d, now));
  }

  return ranges;
}

function addSessionToMatchingRanges(ranges: Map<number, RangeAgg>, session: ParsedSession): void {
  for (const d of RANGE_DAYS) {
    const range = ranges.get(d);
    if (range && sessionDayWithinRange(range, session.startedAt)) {
      addSessionToRange(range, session);
    }
  }
}

async function scanBreakdownCandidates(
  ranges: Map<number, RangeAgg>,
  signal: AbortSignal | undefined,
  onProgress: ((update: Partial<BreakdownProgressState>) => void) | undefined,
): Promise<string[]> {
  onProgress?.({
    phase: "scan",
    foundFiles: 0,
    parsedFiles: 0,
    totalFiles: 0,
    currentFile: undefined,
  });
  const start90 = ranges.get(90)?.days[0]?.date ?? localMidnight(new Date());
  const candidates = await walkSessionFiles(SESSION_ROOT, start90, signal, (found) => {
    onProgress?.({ phase: "scan", foundFiles: found });
  });

  const totalFiles = candidates.length;
  onProgress?.({
    phase: "parse",
    foundFiles: totalFiles,
    totalFiles,
    parsedFiles: 0,
    currentFile: totalFiles > 0 ? path.basename(candidates.at(0) ?? "") : undefined,
  });
  return candidates;
}

async function parseBreakdownCandidates(
  candidates: string[],
  ranges: Map<number, RangeAgg>,
  signal: AbortSignal | undefined,
  onProgress: ((update: Partial<BreakdownProgressState>) => void) | undefined,
): Promise<void> {
  const totalFiles = candidates.length;
  let parsedFiles = 0;
  for (const filePath of candidates) {
    if (isAbortRequested(signal)) {
      break;
    }

    parsedFiles += 1;
    onProgress?.({ phase: "parse", parsedFiles, totalFiles, currentFile: path.basename(filePath) });
    const session = await parseSessionFile(filePath, signal);
    if (session) {
      addSessionToMatchingRanges(ranges, session);
    }
  }
}

export async function computeBreakdown(
  signal?: AbortSignal,
  onProgress?: (update: Partial<BreakdownProgressState>) => void,
): Promise<BreakdownData> {
  const now = new Date();
  const ranges = createBreakdownRanges(now);
  const candidates = await scanBreakdownCandidates(ranges, signal, onProgress);
  await parseBreakdownCandidates(candidates, ranges, signal, onProgress);
  onProgress?.({ phase: "finalize", currentFile: undefined });

  const palette = choosePaletteFromLast30Days(ranges.get(30)!, 4);
  const cwdPalette = chooseCwdPaletteFromLast30Days(ranges.get(30)!, 4);
  const dowPalette = buildDowPalette();
  const todPalette = buildTodPalette();
  return { generatedAt: now, ranges, palette, cwdPalette, dowPalette, todPalette };
}

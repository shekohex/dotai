import type {
  CwdKey,
  DayAgg,
  DowKey,
  MeasurementMode,
  ModelKey,
  RangeAgg,
  RGB,
  TodKey,
} from "./types.js";
import { DOW_NAMES, TOD_BUCKETS } from "./types.js";
import { PALETTE, pickFallbackMap, weightedMix } from "./utils.js";

function sortMapByValueDesc<K extends string>(m: Map<K, number>): Array<{ key: K; value: number }> {
  return [...m.entries()]
    .map(([key, value]) => ({ key, value }))
    .toSorted((a, b) => b.value - a.value);
}

export function choosePaletteFromLast30Days(
  range30: RangeAgg,
  topN = 4,
): {
  modelColors: Map<ModelKey, RGB>;
  otherColor: RGB;
  orderedModels: ModelKey[];
} {
  const costSum = [...range30.modelCost.values()].reduce((a, b) => a + b, 0);
  let popularity = range30.modelSessions;
  if (costSum > 0) {
    popularity = range30.modelCost;
  } else if (range30.totalTokens > 0) {
    popularity = range30.modelTokens;
  } else if (range30.totalMessages > 0) {
    popularity = range30.modelMessages;
  }

  const sorted = sortMapByValueDesc(popularity);
  const orderedModels = sorted.slice(0, topN).map((x) => x.key);
  const modelColors = new Map<ModelKey, RGB>();
  for (let i = 0; i < orderedModels.length; i++) {
    modelColors.set(orderedModels[i], PALETTE[i % PALETTE.length]);
  }
  return {
    modelColors,
    otherColor: { r: 160, g: 160, b: 160 },
    orderedModels,
  };
}

export function chooseCwdPaletteFromLast30Days(
  range30: RangeAgg,
  topN = 4,
): {
  cwdColors: Map<CwdKey, RGB>;
  otherColor: RGB;
  orderedCwds: CwdKey[];
} {
  const costSum = [...range30.cwdCost.values()].reduce((a, b) => a + b, 0);
  let popularity = range30.cwdSessions;
  if (costSum > 0) {
    popularity = range30.cwdCost;
  } else if (range30.totalTokens > 0) {
    popularity = range30.cwdTokens;
  } else if (range30.totalMessages > 0) {
    popularity = range30.cwdMessages;
  }

  const sorted = sortMapByValueDesc(popularity);
  const orderedCwds = sorted.slice(0, topN).map((x) => x.key);
  const cwdColors = new Map<CwdKey, RGB>();
  for (let i = 0; i < orderedCwds.length; i++) {
    cwdColors.set(orderedCwds[i], PALETTE[i % PALETTE.length]);
  }
  return {
    cwdColors,
    otherColor: { r: 160, g: 160, b: 160 },
    orderedCwds,
  };
}

const DOW_PALETTE: RGB[] = [
  { r: 47, g: 129, b: 247 },
  { r: 64, g: 196, b: 99 },
  { r: 163, g: 113, b: 247 },
  { r: 47, g: 175, b: 200 },
  { r: 100, g: 200, b: 150 },
  { r: 255, g: 159, b: 10 },
  { r: 244, g: 67, b: 54 },
];

export function buildDowPalette(): { dowColors: Map<DowKey, RGB>; orderedDows: DowKey[] } {
  const dowColors = new Map<DowKey, RGB>();
  for (let i = 0; i < DOW_NAMES.length; i++) {
    dowColors.set(DOW_NAMES[i], DOW_PALETTE[i]);
  }
  return { dowColors, orderedDows: [...DOW_NAMES] };
}

const TOD_PALETTE: Map<TodKey, RGB> = new Map([
  ["after-midnight", { r: 100, g: 60, b: 180 }],
  ["morning", { r: 255, g: 200, b: 50 }],
  ["afternoon", { r: 64, g: 196, b: 99 }],
  ["evening", { r: 47, g: 129, b: 247 }],
  ["night", { r: 60, g: 40, b: 140 }],
]);

export function buildTodPalette(): { todColors: Map<TodKey, RGB>; orderedTods: TodKey[] } {
  const todColors = new Map<TodKey, RGB>();
  const orderedTods: TodKey[] = [];
  for (const b of TOD_BUCKETS) {
    const c = TOD_PALETTE.get(b.key);
    if (c) todColors.set(b.key, c);
    orderedTods.push(b.key);
  }
  return { todColors, orderedTods };
}

export function dayMixedColor(
  day: DayAgg,
  colorMap: Map<string, RGB>,
  otherColor: RGB,
  mode: MeasurementMode,
  view: "model" | "cwd" | "dow" | "tod" = "model",
): RGB {
  const map = selectDayColorWeightMap(day, mode, view);
  if (map === undefined) {
    const dowKey = DOW_NAMES[(day.date.getDay() + 6) % 7];
    return colorMap.get(dowKey) ?? otherColor;
  }

  const parts: Array<{ color: RGB; weight: number }> = [];
  let otherWeight = 0;

  for (const [mk, w] of map.entries()) {
    const c = colorMap.get(mk);
    if (c) parts.push({ color: c, weight: w });
    else otherWeight += w;
  }
  if (otherWeight > 0) parts.push({ color: otherColor, weight: otherWeight });
  return weightedMix(parts);
}

function selectDayColorWeightMap(
  day: DayAgg,
  mode: MeasurementMode,
  view: "model" | "cwd" | "dow" | "tod",
): Map<string, number> | undefined {
  if (view === "dow") {
    return undefined;
  }
  if (view === "tod") {
    return selectTodWeightMap(day, mode);
  }
  if (view === "cwd") {
    return selectCwdWeightMap(day, mode);
  }

  return selectModelWeightMap(day, mode);
}

function selectTodWeightMap(day: DayAgg, mode: MeasurementMode): Map<string, number> {
  if (mode === "tokens") {
    return pickFallbackMap(
      day.tokensByTod,
      day.messagesByTod,
      day.sessionsByTod,
      day.tokens,
      day.messages,
    );
  }
  if (mode === "messages") {
    return day.messages > 0 ? day.messagesByTod : day.sessionsByTod;
  }

  return day.sessionsByTod;
}

function selectCwdWeightMap(day: DayAgg, mode: MeasurementMode): Map<string, number> {
  if (mode === "tokens") {
    return pickFallbackMap(
      day.tokensByCwd,
      day.messagesByCwd,
      day.sessionsByCwd,
      day.tokens,
      day.messages,
    );
  }
  if (mode === "messages") {
    return day.messages > 0 ? day.messagesByCwd : day.sessionsByCwd;
  }

  return day.sessionsByCwd;
}

function selectModelWeightMap(day: DayAgg, mode: MeasurementMode): Map<string, number> {
  if (mode === "tokens") {
    return pickFallbackMap(
      day.tokensByModel,
      day.messagesByModel,
      day.sessionsByModel,
      day.tokens,
      day.messages,
    );
  }
  if (mode === "messages") {
    return day.messages > 0 ? day.messagesByModel : day.sessionsByModel;
  }

  return day.sessionsByModel;
}

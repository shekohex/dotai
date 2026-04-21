import type { UsageSnapshot } from "../types.js";
import {
  TWENTY_FOUR_HOURS_MS,
  type GoogleCredential,
  type QuotaBucket,
} from "./google-constants.js";
import {
  asRecord,
  clampFraction,
  clampPercent,
  formatPercent,
  hasText,
  joinSummary,
  readFirstStringDeep,
  readNumber,
  readString,
  toIso,
} from "./google-helpers.js";

function collectQuotaBuckets(value: unknown): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];
  collectQuotaBucketsInto(value, buckets);
  return buckets;
}

function collectQuotaBucketsInto(value: unknown, buckets: QuotaBucket[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectQuotaBucketsInto(item, buckets);
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  const remainingFraction = readNumber(record.remainingFraction);
  if (remainingFraction !== undefined) {
    buckets.push({
      modelId: readString(record.modelId) ?? readString(record.model_id) ?? "unknown",
      remainingFraction,
      resetTime: readString(record.resetTime) ?? readString(record.reset_time) ?? undefined,
    });
  }

  for (const nested of Object.values(record)) {
    collectQuotaBucketsInto(nested, buckets);
  }
}

function filterBuckets(buckets: QuotaBucket[], pool: "pro" | "flash"): QuotaBucket[] {
  return buckets.filter((bucket) => {
    const modelId = bucket.modelId.toLowerCase();
    return modelId.includes("gemini") && modelId.includes(pool);
  });
}

function pickLowestRemainingBucket(buckets: QuotaBucket[]): QuotaBucket | undefined {
  let best: QuotaBucket | undefined;
  for (const bucket of buckets) {
    if (!Number.isFinite(bucket.remainingFraction)) {
      continue;
    }
    if (!best || bucket.remainingFraction < best.remainingFraction) {
      best = bucket;
    }
  }
  return best;
}

function mapTierToPlan(
  tier: string | undefined,
  idTokenPayload: Record<string, unknown> | undefined,
): string | undefined {
  const normalizedTier = tier?.trim().toLowerCase();
  if (!hasText(normalizedTier)) {
    return undefined;
  }
  if (normalizedTier === "standard-tier") {
    return "Paid";
  }
  if (normalizedTier === "legacy-tier") {
    return "Legacy";
  }
  if (normalizedTier === "free-tier") {
    return hasText(readString(idTokenPayload?.hd)) ? "Workspace" : "Free";
  }
  return undefined;
}

function extractAccountLabel(
  idTokenPayload: Record<string, unknown> | undefined,
  loadCodeAssistData: Record<string, unknown> | undefined,
): string | undefined {
  return (
    readString(idTokenPayload?.email) ??
    readFirstStringDeep(loadCodeAssistData, ["email", "userEmail"])
  );
}

function buildSummary(
  proBucket: QuotaBucket | undefined,
  flashBucket: QuotaBucket | undefined,
): string | undefined {
  const parts: string[] = [];
  const proSummary = formatBucketSummary("Pro", proBucket);
  if (hasText(proSummary)) {
    parts.push(proSummary);
  }
  const flashSummary = formatBucketSummary("Flash", flashBucket);
  if (hasText(flashSummary)) {
    parts.push(flashSummary);
  }
  return parts.length > 0 ? parts.join(" · ") : "no Gemini quota data in response";
}

function formatBucketSummary(label: string, bucket: QuotaBucket | undefined): string | undefined {
  if (!bucket) {
    return undefined;
  }
  const remaining = clampPercent(clampFraction(bucket.remainingFraction) * 100);
  return `${label} ${formatPercent(remaining)} left`;
}

function buildUsageSnapshot(input: {
  credential: GoogleCredential;
  idTokenPayload: Record<string, unknown> | undefined;
  loadCodeAssistData: Record<string, unknown> | undefined;
  plan: string | undefined;
  proBucket: QuotaBucket | undefined;
  flashBucket: QuotaBucket | undefined;
}): UsageSnapshot {
  const sourceSummary = input.credential.source === "cliproxy" ? "cliproxy account" : "host auth";
  const snapshot: UsageSnapshot = {
    providerId: "google",
    displayName: "Google",
    plan: input.plan,
    source: input.credential.source,
    accountLabel:
      input.credential.accountLabel ??
      extractAccountLabel(input.idTokenPayload, input.loadCodeAssistData),
    metricLabels: {
      session5h: "Pro 24h",
      weekly: "Flash 24h",
    },
    metricShortLabels: {
      session5h: "pro",
      weekly: "flash",
    },
    fetchedAt: Date.now(),
    summary: joinSummary(sourceSummary, buildSummary(input.proBucket, input.flashBucket)),
  };
  appendBucketMetrics(snapshot, input.proBucket, input.flashBucket);
  return snapshot;
}

function appendBucketMetrics(
  snapshot: UsageSnapshot,
  proBucket: QuotaBucket | undefined,
  flashBucket: QuotaBucket | undefined,
): void {
  if (proBucket) {
    snapshot.session5h = {
      used: clampPercent((1 - clampFraction(proBucket.remainingFraction)) * 100),
      limit: 100,
      resetsAt: toIso(proBucket.resetTime),
      periodDurationMs: TWENTY_FOUR_HOURS_MS,
    };
  }
  if (flashBucket) {
    snapshot.weekly = {
      used: clampPercent((1 - clampFraction(flashBucket.remainingFraction)) * 100),
      limit: 100,
      resetsAt: toIso(flashBucket.resetTime),
      periodDurationMs: TWENTY_FOUR_HOURS_MS,
    };
  }
}

export {
  buildUsageSnapshot,
  collectQuotaBuckets,
  filterBuckets,
  mapTierToPlan,
  pickLowestRemainingBucket,
};

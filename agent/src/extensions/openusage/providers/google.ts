import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { UsageProvider, UsageSnapshot } from "../types.js";
import { discoverProjectId, fetchLoadCodeAssist, fetchQuota } from "./google-api.js";
import { resolveCliproxyGoogleCredential, resolveGoogleCredential } from "./google-auth.js";
import type { GoogleCredential } from "./google-constants.js";
import { asRecord, decodeJwtPayload, isAuthError, readFirstStringDeep } from "./google-helpers.js";
import {
  buildUsageSnapshot,
  collectQuotaBuckets,
  filterBuckets,
  mapTierToPlan,
  pickLowestRemainingBucket,
} from "./google-snapshot.js";

export const googleUsageProvider: UsageProvider = {
  id: "google",
  displayName: "Google",
  matchesModel(provider, modelId) {
    const normalizedProvider = provider.trim().toLowerCase();
    const normalizedModelId = modelId.trim().toLowerCase();
    return (
      normalizedProvider === "google" ||
      normalizedProvider === "gemini" ||
      normalizedProvider === "google-gemini-cli" ||
      normalizedProvider === "google-generative-ai" ||
      normalizedProvider === "google-ai-studio" ||
      normalizedProvider === "google-ai" ||
      normalizedModelId.includes("gemini")
    );
  },
  async fetchSnapshot(ctx, state) {
    const credential = await resolveGoogleCredential(ctx, state);
    try {
      return await fetchSnapshotWithCredential(ctx, credential);
    } catch (error) {
      if (credential.source !== "host" || !isAuthError(error)) {
        throw error;
      }

      const cliproxy = await resolveCliproxyGoogleCredential(ctx, state);
      if (!cliproxy) {
        throw error;
      }

      return fetchSnapshotWithCredential(ctx, cliproxy);
    }
  },
};

async function fetchSnapshotWithCredential(
  ctx: ExtensionContext,
  credential: GoogleCredential,
): Promise<UsageSnapshot> {
  const idTokenPayload = decodeJwtPayload(credential.idToken);
  const loadCodeAssistResult = await fetchLoadCodeAssist(ctx, credential);
  const loadCodeAssistData = asRecord(loadCodeAssistResult.data);
  const tier = readFirstStringDeep(loadCodeAssistData, ["tier", "userTier", "subscriptionTier"]);
  const plan = mapTierToPlan(tier, idTokenPayload);
  const projectId = await discoverProjectId(
    ctx,
    loadCodeAssistResult.accessToken,
    loadCodeAssistData,
  );
  const quotaResponse = await fetchQuota(ctx, credential, projectId);
  const quotaData = (await quotaResponse.json()) as unknown;
  const buckets = collectQuotaBuckets(quotaData);
  const proBucket = pickLowestRemainingBucket(filterBuckets(buckets, "pro"));
  const flashBucket = pickLowestRemainingBucket(filterBuckets(buckets, "flash"));
  return buildUsageSnapshot({
    credential,
    idTokenPayload,
    loadCodeAssistData,
    plan,
    proBucket,
    flashBucket,
  });
}

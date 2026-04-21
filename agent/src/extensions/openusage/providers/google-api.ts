import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  IDE_METADATA,
  LOAD_CODE_ASSIST_URL,
  PROJECTS_URL,
  QUOTA_URL,
  type GoogleCredential,
  type LoadCodeAssistResult,
} from "./google-constants.js";
import { asRecord, hasText, readFirstStringDeep, readString } from "./google-helpers.js";
import { refreshAccessToken } from "./google-auth.js";

async function fetchLoadCodeAssist(
  ctx: ExtensionContext,
  credential: GoogleCredential,
): Promise<LoadCodeAssistResult> {
  let currentToken = credential.accessToken;
  if (!hasText(currentToken) && hasText(credential.refreshToken)) {
    currentToken = await refreshAccessToken(ctx, credential);
  }

  if (!hasText(currentToken)) {
    throw new Error(
      "Gemini auth unavailable. Run `gemini auth login` or choose a cliproxy account.",
    );
  }

  let response = await postJson(ctx, LOAD_CODE_ASSIST_URL, currentToken, {
    metadata: IDE_METADATA,
  });

  if ((response.status === 401 || response.status === 403) && hasText(credential.refreshToken)) {
    const refreshed = await refreshAccessToken(ctx, credential);
    if (hasText(refreshed)) {
      currentToken = refreshed;
      response = await postJson(ctx, LOAD_CODE_ASSIST_URL, currentToken, {
        metadata: IDE_METADATA,
      });
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Gemini session expired. Run `gemini auth login`.");
  }
  if (!response.ok) {
    return { data: undefined, accessToken: currentToken };
  }

  return {
    data: (await response.json()) as unknown,
    accessToken: currentToken,
  };
}

async function fetchQuota(
  ctx: ExtensionContext,
  credential: GoogleCredential,
  projectId: string | undefined,
): Promise<Response> {
  let currentToken = credential.accessToken;
  if (!hasText(currentToken) && hasText(credential.refreshToken)) {
    currentToken = await refreshAccessToken(ctx, credential);
  }

  if (!hasText(currentToken)) {
    throw new Error(
      "Gemini auth unavailable. Run `gemini auth login` or choose a cliproxy account.",
    );
  }

  const quotaRequestBody = hasText(projectId) ? { project: projectId } : {};
  let response = await postJson(ctx, QUOTA_URL, currentToken, quotaRequestBody);

  if ((response.status === 401 || response.status === 403) && hasText(credential.refreshToken)) {
    const refreshed = await refreshAccessToken(ctx, credential);
    if (hasText(refreshed)) {
      currentToken = refreshed;
      response = await postJson(ctx, QUOTA_URL, currentToken, quotaRequestBody);
    }
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error("Gemini session expired. Run `gemini auth login`.");
  }
  if (!response.ok) {
    throw new Error(`Gemini quota failed: ${response.status} ${response.statusText}`);
  }

  credential.accessToken = currentToken;
  return response;
}

function postJson(
  ctx: ExtensionContext,
  url: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: ctx.signal,
  });
}

async function discoverProjectId(
  ctx: ExtensionContext,
  accessToken: string,
  loadCodeAssistData: Record<string, unknown> | undefined,
): Promise<string | undefined> {
  const projectId = readProjectId(loadCodeAssistData);
  if (hasText(projectId)) {
    return projectId;
  }

  try {
    const response = await fetch(PROJECTS_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      signal: ctx.signal,
    });

    if (!response.ok) {
      return undefined;
    }
    return findProjectIdFromProjectsPayload(asRecord(await response.json()));
  } catch {
    return undefined;
  }
}

function readProjectId(
  loadCodeAssistData: Record<string, unknown> | undefined,
): string | undefined {
  const direct = loadCodeAssistData?.cloudaicompanionProject;
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct.trim();
  }

  if (
    direct !== undefined &&
    direct !== null &&
    typeof direct === "object" &&
    !Array.isArray(direct)
  ) {
    const nested = readString(asRecord(direct)?.id);
    if (hasText(nested)) {
      return nested;
    }
  }

  return readFirstStringDeep(loadCodeAssistData, ["cloudaicompanionProject"]);
}

function findProjectIdFromProjectsPayload(
  body: Record<string, unknown> | undefined,
): string | undefined {
  if (!body) {
    return undefined;
  }

  const projects = Array.isArray(body.projects) ? body.projects : [];
  for (const entry of projects) {
    const project = asRecord(entry);
    const projectId = readString(project?.projectId);
    if (!hasText(projectId)) {
      continue;
    }
    if (projectId.startsWith("gen-lang-client")) {
      return projectId;
    }
    const labels = asRecord(project?.labels);
    if (labels && Object.hasOwn(labels, "generative-language")) {
      return projectId;
    }
  }

  return undefined;
}

export { discoverProjectId, fetchLoadCodeAssist, fetchQuota };

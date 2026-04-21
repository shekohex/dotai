import type { ExecutorMcpInspection } from "./mcp-client.js";
import { inspectExecutorMcp } from "./mcp-client.js";
import { trimToUndefined } from "./tools-text.js";

const DEFAULT_EXECUTE_DESCRIPTION =
  "Execute TypeScript in a sandboxed runtime with access to configured API tools.";

const DEFAULT_RESUME_DESCRIPTION = [
  "Resume a paused execution using the executionId returned by execute.",
  "Never call this without user approval unless they explicitly state otherwise.",
].join("\n");

const inspectionCache = new Map<string, Promise<ExecutorMcpInspection | undefined>>();

const buildInspectionCacheKey = (cwd: string, hasUI: boolean, mcpUrl: string): string =>
  `${cwd}:${hasUI ? "ui" : "headless"}:${mcpUrl}`;

const readInspectedToolDescription = (
  inspection: ExecutorMcpInspection | undefined,
  toolName: string,
): string | undefined =>
  trimToUndefined(inspection?.tools.find((tool) => tool.name === toolName)?.description) ??
  (toolName === "execute" ? trimToUndefined(inspection?.instructions) : undefined);

const inspectConfiguredExecutor = async (
  cwd: string,
  hasUI: boolean,
): Promise<ExecutorMcpInspection | undefined> => {
  const { resolveExecutorEndpoint } = await import("./connection.js");
  let endpoint;
  try {
    endpoint = await resolveExecutorEndpoint();
  } catch {
    return undefined;
  }

  const cacheKey = buildInspectionCacheKey(cwd, hasUI, endpoint.mcpUrl);
  const cached = inspectionCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inspectionPromise = (async (): Promise<ExecutorMcpInspection | undefined> => {
    try {
      return await inspectExecutorMcp(endpoint.mcpUrl, hasUI);
    } catch {
      return undefined;
    }
  })();

  inspectionCache.set(cacheKey, inspectionPromise);

  try {
    return await inspectionPromise;
  } catch {
    inspectionCache.delete(cacheKey);
    return undefined;
  }
};

export const loadExecutorDescriptions = async (
  cwd: string,
  hasUI: boolean,
): Promise<{ executeDescription: string; resumeDescription: string }> => {
  const inspection = await inspectConfiguredExecutor(cwd, hasUI);

  return {
    executeDescription:
      readInspectedToolDescription(inspection, "execute") ?? DEFAULT_EXECUTE_DESCRIPTION,
    resumeDescription:
      readInspectedToolDescription(inspection, "resume") ?? DEFAULT_RESUME_DESCRIPTION,
  };
};

export const clearExecutorInspectionCache = (): void => {
  inspectionCache.clear();
};

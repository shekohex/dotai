import os from "node:os";
import path from "node:path";

import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

import {
  destroyWorkRpc,
  initConfigRpc,
  listProjectsRpc,
  pauseWorkRpc,
  resumeWorkRpc,
} from "../shared/contracts.js";
import { cubeSandboxSettings } from "../shared/settings.js";
import { CubeSdkRuntime } from "./cube-runtime.js";
import { PaseoCompletionNotifier } from "./completion-notifier.js";
import { findGitRoot } from "./project-config.js";
import {
  canonicalizeRoot,
  listProjectScopes,
  resolveProjectForCwd,
  resolveProjectId,
  type ProjectScope,
} from "./project-registry.js";
import { PaseoSdkConnector } from "./remote-paseo.js";
import { loadRuntimeIdentityBundle } from "./runtime-identity.js";
import { CubeToolServer, type CapabilityBinding } from "./tool-server.js";
import { WorkRecordStore } from "./work-record.js";
import { WorkService } from "./work-service.js";

const CAPABILITY_URL_ENV = "CUBESANDBOX_PASEO_CAPABILITY_URL";

function resolveStateDirectory(): string {
  const configured = process.env.CUBESANDBOX_PASEO_STATE_DIR;
  if (configured) return z.string().min(1).parse(configured);
  return path.join(os.homedir(), ".paseo", "cubesandbox-plugin", "cubesandbox");
}

async function capabilityBindingForCwd(
  scopes: readonly ProjectScope[],
  cwd: string,
): Promise<CapabilityBinding | null> {
  const scope = await resolveProjectForCwd(scopes, cwd);
  if (scope) {
    return {
      canonicalRoot: scope.repositoryRoot ?? scope.canonicalRoot,
      paseoProjectId: scope.projectId,
      ...(scope.workspaceId ? { paseoWorkspaceId: scope.workspaceId } : {}),
    };
  }
  const gitRoot = await findGitRoot(cwd);
  if (!gitRoot) return null;
  return { canonicalRoot: await canonicalizeRoot(gitRoot) };
}

export function contributeServer(server: PluginServerContext) {
  const records = new WorkRecordStore(resolveStateDirectory());
  const completionNotifier = new PaseoCompletionNotifier();
  const works = new WorkService(
    records,
    new CubeSdkRuntime(),
    new PaseoSdkConnector(),
    loadRuntimeIdentityBundle,
    completionNotifier,
  );
  const tools = new CubeToolServer(works);
  server.registerSettings(cubeSandboxSettings);
  const ready = (async () => {
    await records.initialize();
    await Promise.all([works.start(), tools.start()]);
  })();

  let migrated = false;
  const inventory = async (paseo: PaseoApi): Promise<ProjectScope[]> => {
    const scopes = await listProjectScopes(paseo);
    if (!migrated) {
      await records.migrateLegacy(scopes);
      migrated = true;
    }
    return scopes;
  };
  const bestEffortInventory = async (
    paseo: PaseoApi | undefined,
  ): Promise<ProjectScope[]> => {
    if (!paseo) return [];
    try {
      return await inventory(paseo);
    } catch (error) {
      console.warn("CubeSandbox project inventory failed", error);
      return [];
    }
  };
  const usePaseo = (paseo: PaseoApi | undefined): void => {
    if (!paseo) return;
    completionNotifier.setPaseo(paseo);
    void works.flushNotifications().catch(() => undefined);
  };

  server.on("agent.turn_ended", (_event, context) => {
    usePaseo(context.paseo);
  });

  server.before("agent.create", async ({ request }, context) => {
    await ready;
    usePaseo(context?.paseo);
    const binding = await capabilityBindingForCwd(
      await bestEffortInventory(context?.paseo),
      request.config.cwd,
    );
    if (!binding) return request;
    const url = tools.createCapability(binding);
    return {
      ...request,
      env: { ...request.env, [CAPABILITY_URL_ENV]: url },
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          cubesandbox: { type: "http", url },
        },
      },
    };
  });

  server.before("agent.session_open", async ({ request }, context) => {
    await ready;
    usePaseo(context.paseo);
    const capabilityUrl = request.env[CAPABILITY_URL_ENV];
    if (!capabilityUrl) return request;
    const scopes = await bestEffortInventory(context.paseo);
    const scope = request.workspaceId
      ? scopes.find(
          (candidate) => candidate.workspaceId === request.workspaceId,
        )
      : await resolveProjectForCwd(scopes, request.cwd);
    tools.bindCapabilityCoordinator(
      capabilityUrl,
      request.agentId,
      scope
        ? {
            canonicalRoot: scope.repositoryRoot ?? scope.canonicalRoot,
            paseoProjectId: scope.projectId,
            ...(scope.workspaceId
              ? { paseoWorkspaceId: scope.workspaceId }
              : {}),
          }
        : undefined,
    );
    const { [CAPABILITY_URL_ENV]: _capabilityUrl, ...env } = request.env;
    return { ...request, env };
  });

  server.handle(listProjectsRpc, async (_input, { paseo }) => {
    await ready;
    usePaseo(paseo);
    const scopes = await inventory(paseo);
    return { projects: await works.projectSummaries(scopes, true) };
  });
  server.handle(initConfigRpc, async ({ projectId }, { paseo }) => {
    await ready;
    usePaseo(paseo);
    const scope = resolveProjectId(await inventory(paseo), projectId);
    return {
      path: await works.initializeConfig(
        scope.repositoryRoot ?? scope.canonicalRoot,
      ),
      created: true as const,
    };
  });
  server.handle(pauseWorkRpc, async ({ projectId, workId }, { paseo }) => {
    await ready;
    usePaseo(paseo);
    const owner = await works.resolveWorkOwner(
      await inventory(paseo),
      projectId,
      workId,
    );
    return { work: await works.pause(owner, workId) };
  });
  server.handle(resumeWorkRpc, async ({ projectId, workId }, { paseo }) => {
    await ready;
    usePaseo(paseo);
    const owner = await works.resolveWorkOwner(
      await inventory(paseo),
      projectId,
      workId,
    );
    return { work: await works.resume(owner, workId) };
  });
  server.handle(destroyWorkRpc, async ({ projectId, workId }, { paseo }) => {
    await ready;
    usePaseo(paseo);
    const owner = await works.resolveWorkOwner(
      await inventory(paseo),
      projectId,
      workId,
      { allowRemoved: true },
    );
    await works.destroy(owner, workId);
    return { workId, destroyed: true as const };
  });

  return async () => {
    await ready.catch(() => undefined);
    tools.stopAccepting();
    works.beginClosing();
    const failures: unknown[] = [];
    try {
      await tools.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await works.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "CubeSandbox plugin cleanup failed");
    }
  };
}

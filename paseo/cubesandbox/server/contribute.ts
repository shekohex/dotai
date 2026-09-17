import os from "node:os";
import path from "node:path";

import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

import {
  destroyWorkRpc,
  initConfigRpc,
  listWorkRpc,
  pauseWorkRpc,
  resumeWorkRpc,
} from "../shared/contracts.js";
import { CubeSdkRuntime } from "./cube-runtime.js";
import { findGitRoot } from "./project-config.js";
import { PaseoSdkConnector } from "./remote-paseo.js";
import { loadRuntimeIdentityFiles } from "./runtime-identity.js";
import { CubeToolServer } from "./tool-server.js";
import { WorkRecordStore } from "./work-record.js";
import { WorkService } from "./work-service.js";

function resolveStateDirectory(): string {
  const configured = process.env.CUBESANDBOX_PASEO_STATE_DIR;
  if (configured) return z.string().min(1).parse(configured);
  return path.join(os.homedir(), ".paseo", "cubesandbox-plugin", "cubesandbox");
}

export function contributeServer(server: PluginServerContext) {
  const records = new WorkRecordStore(resolveStateDirectory());
  const works = new WorkService(
    records,
    new CubeSdkRuntime(),
    new PaseoSdkConnector(),
    loadRuntimeIdentityFiles,
  );
  const tools = new CubeToolServer(works);
  const ready = (async () => {
    await records.initialize();
    await Promise.all([works.start(), tools.start()]);
  })();

  server.before("agent.create", async ({ request }) => {
    await ready;
    const repositoryRoot = await findGitRoot(request.config.cwd);
    if (!repositoryRoot) return request;
    const url = tools.createCapability(repositoryRoot);
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          cubesandbox: { type: "http", url },
        },
      },
    };
  });

  server.handle(listWorkRpc, async () => {
    await ready;
    return {
      works: await works.list(undefined, true),
      canInitialize: works.canInitialize(),
    };
  });
  server.handle(initConfigRpc, async () => {
    await ready;
    return {
      path: await works.initializeBoundRepository(),
      created: true as const,
    };
  });
  server.handle(pauseWorkRpc, async ({ workId }) => {
    await ready;
    return { work: await works.pause(undefined, workId) };
  });
  server.handle(resumeWorkRpc, async ({ workId }) => {
    await ready;
    return { work: await works.resume(undefined, workId) };
  });
  server.handle(destroyWorkRpc, async ({ workId }) => {
    await ready;
    await works.destroy(undefined, workId);
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

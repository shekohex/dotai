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
import { discoverGitProject } from "./project-config.js";
import { PaseoSdkConnector } from "./remote-paseo.js";
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
  );
  const tools = new CubeToolServer(works);
  const ready = Promise.all([records.initialize(), tools.start()]);

  server.before("agent.create", async ({ request }) => {
    await ready;
    const project = await discoverGitProject(request.config.cwd).catch(
      () => null,
    );
    if (!project) return request;
    const url = tools.createCapability(project.root);
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
    await Promise.allSettled([works.close(), tools.close()]);
  };
}

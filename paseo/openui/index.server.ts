import type { PaseoApi } from "@getpaseo/client";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { OPENUI_MCP_SERVER } from "./shared/render";
import { imageRpc, shareRpc } from "./shared/media";
import { attachRpc, formatSetup } from "./shared/attach";
import { embedOpenRpc, embedRpc } from "./shared/embed";
import { embedFileHtml, embedOpenUrl } from "./server/embed";
import { rasterRpc } from "./shared/raster";
import { respondRpc } from "./shared/respond";
import path from "node:path";
import { componentsText, guideText } from "./server/guide";
import { DEFAULT_GLOBAL_DIRECTORY, FileStore, Library, projectRootOf } from "./server/library";
import { expandRpc } from "./shared/components";
import { readImage, shareableFile } from "./server/files";
import { renderRaster } from "./server/raster";
import { MediaServer, privateLanAddress, tailscaleCli } from "./server/media-server";
import { SourceService } from "./server/source-service";
import { SourceRunner, StreamHub } from "./server/sources";
import { RenderToolServer } from "./server/tool-server";
import { sourceCallRpc, sourceReadRpc, sourceStopRpc } from "./shared/sources";
import { Waiters } from "./server/waiters";

async function agentProjectRoot(paseo: PaseoApi, agentId: string): Promise<string | undefined> {
  const agent = paseo.agents.ref(agentId);
  await agent.refresh();
  return agent.cwd ? projectRootOf(agent.cwd) : undefined;
}

async function agentLocation(paseo: PaseoApi, agentId: string): Promise<{ cwd: string; projectRoot?: string } | undefined> {
  const agent = paseo.agents.ref(agentId);
  await agent.refresh();
  if (!agent.cwd) return undefined;
  const projectRoot = await projectRootOf(agent.cwd);
  return { cwd: agent.cwd, ...(projectRoot ? { projectRoot } : {}) };
}

export default function contribute(server: PluginServerContext) {
  const waiters = new Waiters();
  const media = new MediaServer({ tailscale: tailscaleCli(), lanAddress: () => privateLanAddress() });
  const library = new Library(new FileStore(DEFAULT_GLOBAL_DIRECTORY));
  const runner = new SourceRunner();
  const sources = new SourceService(library, runner, new StreamHub(runner));
  const tools = new RenderToolServer(waiters, library, runner);
  const toolsReady = tools.start().then(() => {
    console.log(`OpenUI MCP server listening at ${tools.url}`);
  });

  // Loads MathJax and resvg now so the first formula is fast, and logs if their install is missing.
  void renderRaster({ kind: "latex", source: "x", display: false, color: "#000000", scale: 1, maxWidth: 100 }).then(
    () => console.log("OpenUI rasterizer ready (LaTeX, SVG, Graphviz, QR)"),
    (error: unknown) => console.error(`OpenUI rasterizer unavailable: ${error instanceof Error ? error.message : String(error)}. Run npm install in the plugin directory.`),
  );

  server.before("agent.create", async ({ request }) => {
    await toolsReady;
    if (request.config.internal) return request;
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          [OPENUI_MCP_SERVER]: { type: "http", url: `${tools.url}?cwd=${encodeURIComponent(request.config.cwd)}` },
        },
      },
    };
  });

  server.handle(respondRpc, async ({ agentId, key, text }, { paseo }) => {
    if (waiters.answer(key, text)) return { delivered: "tool_result" as const };
    await paseo.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
    return { delivered: "message" as const };
  });

  server.handle(attachRpc, async ({ agentId }, { paseo }) => {
    const snapshot = await library.snapshot(await agentProjectRoot(paseo, agentId));
    await paseo.agents.ref(agentId).send(formatSetup(`${guideText("fence")}\n\n${componentsText(snapshot, false)}`), { activeTurnBehavior: "steer" });
    return { ok: true as const };
  });

  server.handle(expandRpc, async ({ agentId, ui }, { paseo }) => library.expand(ui, await agentProjectRoot(paseo, agentId)));

  server.handle(sourceCallRpc, async ({ agentId, source, args, intent }, { paseo }) => {
    const where = await agentLocation(paseo, agentId);
    if (!where) return { ok: false as const, error: { kind: "spawn" as const, message: "This agent has no working directory, so a source has nowhere to run." } };
    return sources.call({ id: agentId, ...where }, source, args ?? {}, intent);
  });

  server.handle(sourceReadRpc, ({ streamId, cursor, waitMs }) => sources.read(streamId, cursor, waitMs));

  server.handle(sourceStopRpc, ({ streamId }) => {
    sources.stop(streamId);
    return { ok: true as const };
  });

  server.handle(rasterRpc, (request) => renderRaster(request));

  server.handle(embedRpc, async ({ agentId, path: requested }, { paseo }) => ({ html: await embedFileHtml(paseo, agentId, requested) }));

  server.handle(embedOpenRpc, async (input, { paseo }) => ({ url: await embedOpenUrl(paseo, media, input) }));

  server.handle(imageRpc, ({ agentId, path: requested }, { paseo }) => readImage(paseo, agentId, requested));

  server.handle(shareRpc, async ({ agentId, path: requested }, { paseo }) => {
    const file = await shareableFile(paseo, agentId, requested);
    return { url: await media.share(file, path.basename(file)) };
  });

  return async () => {
    await toolsReady.catch(() => undefined);
    sources.close();
    await Promise.all([tools.close(), media.close()]);
  };
}

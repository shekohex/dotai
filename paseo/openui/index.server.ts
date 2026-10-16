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
import { RenderToolServer } from "./server/tool-server";
import { Waiters } from "./server/waiters";

async function agentProjectRoot(paseo: PaseoApi, agentId: string): Promise<string | undefined> {
  const agent = paseo.agents.ref(agentId);
  await agent.refresh();
  return agent.cwd ? projectRootOf(agent.cwd) : undefined;
}

export default function contribute(server: PluginServerContext) {
  const waiters = new Waiters();
  const media = new MediaServer({ tailscale: tailscaleCli(), lanAddress: () => privateLanAddress() });
  const library = new Library(new FileStore(DEFAULT_GLOBAL_DIRECTORY));
  const tools = new RenderToolServer(waiters, library);
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
    await Promise.all([tools.close(), media.close()]);
  };
}

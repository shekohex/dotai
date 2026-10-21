import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";

import { insideWorkspace, mediaTypeOf } from "./files.js";
import { shareOverTailscale, type TailscaleShare } from "./tailscale.js";

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000;
const SHARE_RETRY_MS = 60_000;

interface Grant {
  absolutePath: string;
  mimeType: string;
  expiresAt: number;
}

/**
 * Serves workspace media over HTTP with Range support, so a video can start at once and seek. It listens
 * on loopback only, and every URL carries an unguessable token that is granted for one workspace file.
 */
export function createMediaServer() {
  const grants = new Map<string, Grant>();
  let server: Server | null = null;
  let starting: Promise<number> | null = null;
  let share: Promise<TailscaleShare | null> | null = null;
  let shareFailedAt = 0;

  const handle: Parameters<typeof createServer>[1] = async (request, response) => {
    // Tailscale mounts the files under /prism-media and may or may not strip that prefix.
    const token = /^(?:\/prism-media)?\/m\/([0-9a-f]+)$/.exec((request.url ?? "").split("?")[0] ?? "")?.[1];
    const grant = token ? grants.get(token) : undefined;
    if (!grant || grant.expiresAt < Date.now()) {
      response.writeHead(404).end();
      return;
    }
    try {
      const { size } = await stat(grant.absolutePath);
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
      let start = 0;
      let end = size - 1;
      if (range) {
        const [, from = "", to = ""] = range;
        if (from === "") {
          start = Math.max(0, size - Number(to));
        } else {
          start = Number(from);
          if (to !== "") end = Math.min(end, Number(to));
        }
        if (start > end || start >= size) {
          response.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
          return;
        }
      }
      response.writeHead(range ? 206 : 200, {
        "Content-Type": grant.mimeType,
        "Content-Length": String(end - start + 1),
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
      });
      if (request.method === "HEAD" || size === 0) {
        response.end();
        return;
      }
      const stream = createReadStream(grant.absolutePath, { start, end });
      response.once("close", () => stream.destroy());
      stream.on("error", () => response.destroy());
      stream.pipe(response);
    } catch {
      if (!response.headersSent) response.writeHead(404).end();
    }
  };

  const listen = (): Promise<number> => {
    starting ??= new Promise<number>((resolvePort, reject) => {
      const created = createServer(handle);
      created.once("error", reject);
      created.listen(0, "127.0.0.1", () => {
        server = created;
        const address = created.address();
        resolvePort(typeof address === "object" && address ? address.port : 0);
      });
    });
    return starting;
  };

  const tailnetShare = async (port: number, enabled: boolean): Promise<TailscaleShare | null> => {
    if (!enabled) return null;
    if (share && (await share) === null && Date.now() - shareFailedAt > SHARE_RETRY_MS) share = null;
    share ??= shareOverTailscale(port).then((result) => {
      if (result === null) shareFailedAt = Date.now();
      return result;
    });
    return share;
  };

  const stopShare = async () => {
    const current = share;
    share = null;
    await (await current)?.stop();
  };

  return {
    stopShare,
    /**
     * URLs for one workspace media file, best first: the tailnet HTTPS address when Tailscale can publish
     * it (works from other machines), then loopback. Empty when the file is not media.
     */
    async urlsFor(cwd: string, path: string, useTailscale: boolean): Promise<string[]> {
      const media = mediaTypeOf(path);
      if (!media) return [];
      const absolutePath = insideWorkspace(cwd, path);
      const port = await listen();
      const now = Date.now();
      for (const [key, grant] of grants) if (grant.expiresAt < now) grants.delete(key);
      const token = randomBytes(24).toString("hex");
      grants.set(token, { absolutePath, mimeType: media[1], expiresAt: now + TOKEN_TTL_MS });
      const tailnet = await tailnetShare(port, useTailscale);
      return [...(tailnet ? [`${tailnet.origin}/m/${token}`] : []), `http://127.0.0.1:${port}/m/${token}`];
    },
    async close() {
      await stopShare();
      grants.clear();
      server?.close();
      server?.closeAllConnections();
      server = null;
      starting = null;
    },
  };
}

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { networkInterfaces } from "node:os";
import path from "node:path";

/** Media the app can't play itself (video, audio, PDF, ...) opens in a browser from this server. */
const IDLE_MS = 10 * 60_000;

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".vtt": "text/vtt; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
};

export function mimeType(filePath: string): string {
  return (
    MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
  );
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}

/** What an HTML page may load from its folder: markup, styles, scripts, media, fonts, data. */
const SITE_EXTENSIONS = new Set([
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".json",
  ".txt",
  ".csv",
  ".vtt",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".svg",
  ".ico",
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mp3",
  ".m4a",
  ".wav",
  ".ogg",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
]);
const MEDIA_MAX_BYTES = 1024 ** 3;
const ASSET_MAX_BYTES = 25 * 1024 ** 2;

export function isHtml(filePath: string): boolean {
  return /\.html?$/i.test(filePath);
}

/**
 * The file a page's relative URL names inside `root`, or null when it isn't allowed: outside the
 * folder (also through symlinks), a dotfile or dot folder, an extension pages don't need, or too big.
 */
export async function siteAsset(
  root: string,
  relative: string,
): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relative);
  } catch {
    return null;
  }
  const parts = decoded.split(/[\\/]+/).filter(Boolean);
  if (
    !parts.length ||
    parts.some((part) => part.startsWith(".") || part.includes("\0"))
  )
    return null;
  const ext = path.extname(decoded).toLowerCase();
  if (!SITE_EXTENSIONS.has(ext)) return null;
  const realRoot = await realpath(root).catch(() => null);
  const real = await realpath(path.join(root, ...parts)).catch(() => null);
  if (!realRoot || !real || !real.startsWith(`${realRoot}${path.sep}`))
    return null;
  const info = await stat(real).catch(() => null);
  if (!info?.isFile()) return null;
  const mime = mimeType(real);
  const max =
    mime.startsWith("video/") || mime.startsWith("audio/")
      ? MEDIA_MAX_BYTES
      : ASSET_MAX_BYTES;
  return info.size <= max ? real : null;
}

/** The page for one shared file: the browser's own player or viewer, and a Close server button. */
export function mediaPage(title: string, filePath: string): string {
  const mime = mimeType(filePath);
  const name = escapeHtml(title);
  // A page runs sandboxed in a frame: its scripts work, but it can't touch this wrapper.
  const media = isHtml(filePath)
    ? `<iframe class="site" src="site/${encodeURIComponent(path.basename(filePath))}" title="${name}" sandbox="allow-scripts allow-popups allow-forms"></iframe>`
    : mime.startsWith("video/")
      ? `<video src="file" controls autoplay playsinline></video>`
      : mime.startsWith("audio/")
        ? `<audio src="file" controls autoplay></audio>`
        : mime.startsWith("image/")
          ? `<img src="file" alt="${name}">`
          : mime === "application/pdf" || mime.startsWith("text/")
            ? `<iframe src="file" title="${name}"></iframe>`
            : `<p><a href="file" download>Download ${name}</a></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{margin:0;display:flex;flex-direction:column;min-height:100vh}
header{display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid #8884}
h1{flex:1;font-size:17px;margin:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{font:inherit;font-size:15px;padding:8px 14px;border-radius:8px;border:1px solid #8886;cursor:pointer}
main{flex:1;display:flex;align-items:center;justify-content:center;padding:16px}
video,img{max-width:100%;max-height:calc(100vh - 110px)}
iframe{width:100%;height:calc(100vh - 110px);border:0}
main:has(iframe.site){padding:0}
iframe.site{height:calc(100vh - 62px)}
p{font-size:16px}
</style></head>
<body><header><h1>${name}</h1><button id="close" type="button">Close server</button></header>
<main>${media}</main>
<script>
document.getElementById("close").addEventListener("click", async () => {
  try { await fetch("close", { method: "POST" }); } catch {}
  document.querySelector("main").innerHTML = "<p>Server closed. You can close this tab.</p>";
  document.getElementById("close").disabled = true;
});
</script></body></html>`;
}

/** The first private IPv4 address of this machine (192.168.x.x, 10.x.x.x, 172.16-31.x.x), or null. */
export function privateLanAddress(interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string | null {
  const privateRange = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  for (const addresses of Object.values(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal && privateRange.test(address.address)) return address.address;
    }
  }
  return null;
}

/** Exposes the local server on the tailnet (never the internet), or reports that it can't. */
export interface Tailscale {
  /** Returns the tailnet URL prefix for `mountPath`, or null when Tailscale isn't usable. */
  expose(port: number, mountPath: string): Promise<string | null>;
  unexpose(mountPath: string): Promise<void>;
}

type Run = (file: string, args: string[]) => Promise<string>;

const runFile: Run = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 15_000 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout),
    );
  });

// The daemon's PATH may not include Homebrew or the macOS app bundle.
const TAILSCALE_BINARIES = [
  "tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/** `tailscale serve` on its own path, so other serve config on the machine is left alone. */
export function tailscaleCli(run: Run = runFile): Tailscale {
  let binary: string | null | undefined;
  const find = async (): Promise<{ binary: string; host: string } | null> => {
    for (const candidate of binary === undefined
      ? TAILSCALE_BINARIES
      : binary
        ? [binary]
        : []) {
      try {
        const status = JSON.parse(
          await run(candidate, ["status", "--json"]),
        ) as { BackendState?: string; Self?: { DNSName?: string } };
        binary = candidate;
        const host = status.Self?.DNSName?.replace(/\.$/, "");
        return status.BackendState === "Running" && host
          ? { binary: candidate, host }
          : null;
      } catch {
        // Not installed here, or not logged in.
      }
    }
    binary = null;
    return null;
  };
  return {
    async expose(port, mountPath) {
      const found = await find();
      if (!found) return null;
      try {
        await run(found.binary, [
          "serve",
          "--bg",
          "--https=443",
          `--set-path=${mountPath}`,
          `http://127.0.0.1:${port}${mountPath}`,
        ]);
        return `https://${found.host}${mountPath}`;
      } catch (error) {
        console.warn("OpenUI media: tailscale serve failed", error);
        return null;
      }
    },
    async unexpose(mountPath) {
      if (!binary) return;
      await run(binary, [
        "serve",
        "--https=443",
        `--set-path=${mountPath}`,
        "off",
      ]).catch((error: unknown) =>
        console.warn("OpenUI media: tailscale serve off failed", error),
      );
    },
  };
}

interface Share {
  filePath: string;
  title: string;
}

/**
 * A temporary localhost server for files the app can't show. Started on the first share; stops
 * when the page's Close server button is pressed, after `idleMs` without requests, or on unload.
 * Every URL carries an unguessable mount path and token.
 */
export class MediaServer {
  private server: Server | undefined;
  private starting: Promise<{ local: string; public: string }> | undefined;
  private readonly shares = new Map<string, Share>();
  private mountPath = "";
  private exposed = false;
  private idle: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly options: {
      idleMs?: number;
      tailscale?: Tailscale | null;
      /** The machine's address on the local network, used when Tailscale is not; null keeps the server on localhost. */
      lanAddress?: (() => string | null) | null;
    } = {},
  ) {}

  get running(): boolean {
    return Boolean(this.server);
  }

  /** Serves `filePath` and returns the URL of its page. The caller checks it may be served. */
  async share(filePath: string, title: string): Promise<string> {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Only files can be opened this way");
    const base = await this.start();
    const token = randomBytes(18).toString("base64url");
    this.shares.set(token, { filePath, title });
    this.touch();
    return `${base.public}/${token}/`;
  }

  private start(): Promise<{ local: string; public: string }> {
    this.starting ??= (async () => {
      this.mountPath = `/openui-${randomBytes(12).toString("base64url")}`;
      const server = createServer((request, response) => {
        void this.handle(request, response);
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      this.server = server;
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const local = `http://127.0.0.1:${port}${this.mountPath}`;
      const tailnet = await (this.options.tailscale?.expose(
        port,
        this.mountPath,
      ) ?? Promise.resolve(null));
      this.exposed = Boolean(tailnet);
      if (tailnet) return { local, public: tailnet };
      // No Tailscale: a daemon on another machine can only be reached by its network address.
      const lan = this.options.lanAddress?.() ?? null;
      if (lan) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(port, "0.0.0.0", () => {
            server.off("error", reject);
            resolve();
          });
        });
        return { local, public: `http://${lan}:${port}${this.mountPath}` };
      }
      return { local, public: local };
    })().catch((error: unknown) => {
      this.starting = undefined;
      throw error;
    });
    return this.starting;
  }

  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(
      () => void this.close(),
      this.options.idleMs ?? IDLE_MS,
    );
    this.idle.unref?.();
  }

  async close(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = undefined;
    const server = this.server;
    const mountPath = this.mountPath;
    const exposed = this.exposed;
    this.server = undefined;
    this.starting = undefined;
    this.exposed = false;
    this.shares.clear();
    if (exposed) await this.options.tailscale?.unexpose(mountPath);
    if (server) {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const prefix = `${this.mountPath}/`;
    const rest = url.pathname.startsWith(prefix)
      ? url.pathname.slice(prefix.length)
      : null;
    const [token = "", action = ""] = rest?.split("/") ?? [];
    const share = this.shares.get(token);
    if (!share) {
      response
        .writeHead(404, { "content-type": "text/plain" })
        .end("Not found");
      return;
    }
    this.touch();
    if (action === "close" && request.method === "POST") {
      response.writeHead(200, { "content-type": "text/plain" }).end("Closed");
      setImmediate(() => void this.close());
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    if (action === "") {
      response
        .writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        })
        .end(mediaPage(share.title, share.filePath));
      return;
    }
    if (action === "file") {
      await this.sendFile(share.filePath, request, response);
      return;
    }
    if (action === "site" && isHtml(share.filePath)) {
      const relative = rest?.split("/").slice(2).join("/") ?? "";
      const asset = await siteAsset(path.dirname(share.filePath), relative);
      if (asset) await this.sendFile(asset, request, response);
      else response.writeHead(404).end();
      return;
    }
    response.writeHead(404).end();
  }

  /** Streams the file, honoring a single byte range so players can seek. */
  private async sendFile(
    filePath: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) {
      response.writeHead(404).end();
      return;
    }
    const headers = {
      "content-type": mimeType(filePath),
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? "");
    if (range && (range[1] || range[2])) {
      const start = range[1]
        ? Number(range[1])
        : Math.max(0, info.size - Number(range[2]));
      const end =
        range[1] && range[2]
          ? Math.min(Number(range[2]), info.size - 1)
          : info.size - 1;
      if (start > end || start >= info.size) {
        response
          .writeHead(416, { "content-range": `bytes */${info.size}` })
          .end();
        return;
      }
      response.writeHead(206, {
        ...headers,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${info.size}`,
      });
      if (request.method === "HEAD") return void response.end();
      createReadStream(filePath, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, { ...headers, "content-length": info.size });
    if (request.method === "HEAD") return void response.end();
    createReadStream(filePath).pipe(response);
  }
}

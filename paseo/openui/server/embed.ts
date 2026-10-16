import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PaseoApi } from "@getpaseo/client";
import { htmlDocument } from "../shared/embed";
import type { MediaServer } from "./media-server";
import { resolveShowable, shareableFile } from "./files";

const EMBED_DIR = path.join(tmpdir(), "openui-embed");
const ASSET_MAX_BYTES = 6_000_000;
const TOTAL_MAX_BYTES = 12_000_000;
const ASSET_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".avif": "image/avif",
};

/** True for a reference that points at another file on disk (not a URL, data URI, anchor or absolute web path). */
function isLocalReference(reference: string): boolean {
  return reference !== "" && !/^([a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(reference);
}

/**
 * The HTML file's text with its local stylesheets, scripts and images inlined, so the app can draw
 * it from a string. Assets go through the same access rules as any file an agent shows.
 */
export async function embedFileHtml(paseo: PaseoApi, agentId: string, requested: string): Promise<string> {
  const real = await resolveShowable(paseo, agentId, requested);
  if (!/\.html?$/i.test(real)) throw new Error("Embed needs an .html file (or a URL)");
  const base = path.dirname(real);
  let html = await readFile(real, "utf8");
  let budget = TOTAL_MAX_BYTES - html.length;

  const load = async (reference: string): Promise<Buffer | null> => {
    if (!isLocalReference(reference)) return null;
    const clean = reference.split(/[?#]/)[0] ?? "";
    try {
      const file = await resolveShowable(paseo, agentId, path.resolve(base, decodeURIComponent(clean)));
      const info = await stat(file);
      if (info.size > ASSET_MAX_BYTES || info.size > budget) return null;
      budget -= info.size;
      return await readFile(file);
    } catch {
      return null;
    }
  };

  const replaceAsync = async (pattern: RegExp, make: (match: RegExpExecArray) => Promise<string | null>) => {
    const parts: string[] = [];
    let last = 0;
    for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
      parts.push(html.slice(last, match.index), (await make(match)) ?? match[0]);
      last = match.index + match[0].length;
    }
    html = parts.join("") + html.slice(last);
  };

  const escapeScript = (code: string) => code.replace(/<\/script/gi, "<\\/script");
  await replaceAsync(/<link\b[^>]*\brel=["']?stylesheet["']?[^>]*>/gi, async (match) => {
    const href = /\bhref=["']([^"']+)["']/i.exec(match[0])?.[1];
    const data = href ? await load(href) : null;
    return data ? `<style>${data.toString("utf8").replace(/<\/style/gi, "<\\/style")}</style>` : null;
  });
  await replaceAsync(/<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)>\s*<\/script>/gi, async (match) => {
    const data = await load(match[2] as string);
    const attributes = `${match[1] ?? ""} ${match[3] ?? ""}`.trim();
    return data ? `<script${attributes ? ` ${attributes}` : ""}>${escapeScript(data.toString("utf8"))}</script>` : null;
  });
  await replaceAsync(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi, async (match) => {
    const data = await load(match[1] as string);
    const mime = ASSET_MIME[path.extname((match[1] as string).split(/[?#]/)[0] ?? "").toLowerCase()];
    return data && mime ? match[0].replace(match[1] as string, `data:${mime};base64,${data.toString("base64")}`) : null;
  });
  return html;
}

/** A browser-openable URL for the page, from the file server. Started only when the user taps Open. */
export async function embedOpenUrl(
  paseo: PaseoApi,
  media: MediaServer,
  input: { agentId: string; path?: string | undefined; html?: string | undefined },
): Promise<string> {
  let file: string;
  if (input.html !== undefined) {
    const document = htmlDocument(input.html);
    const folder = path.join(EMBED_DIR, createHash("sha1").update(document).digest("hex").slice(0, 16));
    await mkdir(folder, { recursive: true });
    file = path.join(folder, "index.html");
    await writeFile(file, document);
  } else {
    file = await shareableFile(paseo, input.agentId, input.path ?? "");
    if (!/\.html?$/i.test(file)) throw new Error("Embed needs an .html file (or a URL)");
  }
  const page = await media.share(file, path.basename(file));
  return `${page}site/${encodeURIComponent(path.basename(file))}`;
}

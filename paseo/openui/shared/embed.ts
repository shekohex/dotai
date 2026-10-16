import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const EMBED_MAX_HTML = 2_000_000;
export const EMBED_DEFAULT_HEIGHT = 320;
export const EMBED_MAX_HEIGHT = 900;

/** The HTML of a file in the agent's project, with its relative styles, scripts and images inlined, to draw in a frame. */
export const embedRpc = defineRpc({
  name: "openui.embed",
  input: z.object({ agentId: z.string(), path: z.string().min(1) }).strict(),
  output: z.object({ html: z.string() }),
});

/** Opens an HTML file or snippet in the browser from the daemon's file server (Tailscale or network address); only on a tap. */
export const embedOpenRpc = defineRpc({
  name: "openui.embed.open",
  input: z
    .object({
      agentId: z.string(),
      path: z.string().min(1).optional(),
      html: z.string().min(1).max(EMBED_MAX_HTML).optional(),
    })
    .strict()
    .refine((input) => (input.path === undefined) !== (input.html === undefined), "Pass exactly one of path or html"),
  output: z.object({ url: z.string() }),
});

const HEAD =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:light dark}body{font:14px system-ui,sans-serif;margin:12px}</style>';

/** A bare snippet becomes a full document so it has a charset and a viewport; a full page is used as written. */
export function htmlDocument(html: string): string {
  return /<html[\s>]|<!doctype/i.test(html) ? html : `${HEAD}${html}`;
}

export type EmbedSource = { kind: "url"; url: string } | { kind: "file"; path: string } | { kind: "invalid"; reason: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Video links become their embeddable player; web pages stay as written; anything else is a file path. */
export function embedSource(raw: string): EmbedSource {
  const src = raw.trim();
  if (src === "") return { kind: "invalid", reason: "Embed needs a URL or an HTML file path" };
  if (!/^[a-z][a-z0-9+.-]*:/i.test(src)) return { kind: "file", path: src };
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return { kind: "invalid", reason: `Not a valid URL: ${src.slice(0, 60)}` };
  }
  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtube.com" || host === "m.youtube.com" || host === "youtu.be") {
    const id = host === "youtu.be" ? url.pathname.slice(1) : (url.searchParams.get("v") ?? /^\/(?:shorts|embed)\/([\w-]+)/.exec(url.pathname)?.[1] ?? "");
    if (/^[\w-]{6,20}$/.test(id)) return { kind: "url", url: `https://www.youtube-nocookie.com/embed/${id}` };
  }
  if (host === "vimeo.com") {
    const id = /^\/(\d+)/.exec(url.pathname)?.[1];
    if (id) return { kind: "url", url: `https://player.vimeo.com/video/${id}` };
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) return { kind: "url", url: url.toString() };
  return { kind: "invalid", reason: "Embed only loads https:// pages (or an HTML file path)" };
}

export function embedHeight(value: unknown): number {
  const height = Number(value);
  return Number.isFinite(height) && height > 0 ? Math.min(EMBED_MAX_HEIGHT, Math.max(120, Math.round(height))) : EMBED_DEFAULT_HEIGHT;
}

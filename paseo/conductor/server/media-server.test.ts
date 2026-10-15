import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MediaServer,
  mediaPage,
  siteAsset,
  type Tailscale,
  tailscaleCli,
} from "./media-server.js";

let media: MediaServer | undefined;
afterEach(async () => {
  await media?.close();
});

async function videoFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "media-"));
  const file = path.join(dir, "demo.mp4");
  await writeFile(file, Buffer.from("0123456789"));
  return file;
}

function fakeTailscale(url: string | null) {
  const calls: string[] = [];
  const tailscale: Tailscale = {
    async expose(_port, mountPath) {
      calls.push(`expose ${mountPath}`);
      return url ? `${url}${mountPath}` : null;
    },
    async unexpose(mountPath) {
      calls.push(`unexpose ${mountPath}`);
    },
  };
  return { tailscale, calls };
}

describe("MediaServer", () => {
  it("serves a page and the file with ranges, and nothing else", async () => {
    media = new MediaServer({ tailscale: null });
    const url = await media.share(await videoFile(), "Demo <clip>");
    expect(url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/conductor-[\w-]+\/[\w-]{24}\/$/,
    );

    const page = await fetch(url);
    const html = await page.text();
    expect(html).toContain('<video src="file"');
    expect(html).toContain("Demo &lt;clip&gt;");
    expect(html).toContain("Close server");

    const part = await fetch(`${url}file`, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("2345");
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");

    expect(
      (await fetch(`${url.replace(/[\w-]{24}\/$/, "x".repeat(24))}/`)).status,
    ).toBe(404);
    expect((await fetch(new URL("/", url))).status).toBe(404);
  });

  it("closes from the page's button and tears Tailscale down", async () => {
    const { tailscale, calls } = fakeTailscale("https://box.tailnet.ts.net");
    media = new MediaServer({ tailscale });
    const url = await media.share(await videoFile(), "Demo");
    expect(url).toMatch(/^https:\/\/box\.tailnet\.ts\.net\/conductor-/);
    const local = new URL(
      url.replace("https://box.tailnet.ts.net", "http://x"),
    );
    expect(media.running).toBe(true);
    // Through Tailscale the same path reaches the local server; call it directly here.
    const port = (
      media as unknown as { server: { address(): { port: number } } }
    ).server.address().port;
    const close = await fetch(
      `http://127.0.0.1:${port}${local.pathname}close`,
      { method: "POST" },
    );
    expect(close.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(media.running).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]?.replace("expose", "unexpose"));
  });

  it("closes itself after the idle timeout", async () => {
    media = new MediaServer({ tailscale: null, idleMs: 50 });
    const url = await media.share(await videoFile(), "Demo");
    expect(media.running).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(media.running).toBe(false);
    await expect(fetch(url)).rejects.toThrow();
  });

  it("refuses folders", async () => {
    media = new MediaServer({ tailscale: null });
    await expect(media.share(os.tmpdir(), "tmp")).rejects.toThrow(/Only files/);
  });
});

describe("mediaPage", () => {
  it("picks a player by type", () => {
    expect(mediaPage("a", "/x/a.mp3")).toContain("<audio");
    expect(mediaPage("a", "/x/a.pdf")).toContain("<iframe");
    expect(mediaPage("a", "/x/a.bin")).toContain("download");
  });
});

describe("tailscaleCli", () => {
  it("serves on a path of the tailnet and never uses funnel", async () => {
    const runs: string[][] = [];
    const cli = tailscaleCli(async (file, args) => {
      runs.push([file, ...args]);
      if (args[0] === "status")
        return JSON.stringify({
          BackendState: "Running",
          Self: { DNSName: "box.tailnet.ts.net." },
        });
      return "";
    });
    expect(await cli.expose(1234, "/conductor-abc")).toBe(
      "https://box.tailnet.ts.net/conductor-abc",
    );
    await cli.unexpose("/conductor-abc");
    expect(runs.slice(1)).toEqual([
      [
        "tailscale",
        "serve",
        "--bg",
        "--https=443",
        "--set-path=/conductor-abc",
        "http://127.0.0.1:1234/conductor-abc",
      ],
      ["tailscale", "serve", "--https=443", "--set-path=/conductor-abc", "off"],
    ]);
    expect(runs.flat().join(" ")).not.toContain("funnel");
  });

  it("falls back when Tailscale is missing or logged out", async () => {
    const missing = tailscaleCli(async () => {
      throw new Error("not found");
    });
    expect(await missing.expose(1, "/p")).toBeNull();
    const stopped = tailscaleCli(async () =>
      JSON.stringify({ BackendState: "Stopped" }),
    );
    expect(await stopped.expose(1, "/p")).toBeNull();
  });
});

describe("HTML pages", () => {
  async function site() {
    const outside = await mkdtemp(path.join(os.tmpdir(), "outside-"));
    await writeFile(path.join(outside, "secret.css"), "body{}");
    const dir = await mkdtemp(path.join(os.tmpdir(), "site-"));
    await mkdir(path.join(dir, "assets"));
    await mkdir(path.join(dir, ".git"));
    await writeFile(path.join(dir, "index.html"), "<h1>Hi</h1>");
    await writeFile(path.join(dir, "assets", "clip.mp4"), "0123456789");
    await writeFile(path.join(dir, "assets", "style.css"), "h1{}");
    await writeFile(path.join(dir, ".git", "config.css"), "x");
    await writeFile(path.join(dir, ".env"), "TOKEN=1");
    await writeFile(path.join(dir, "notes.sh"), "rm -rf /");
    await symlink(
      path.join(outside, "secret.css"),
      path.join(dir, "assets", "link.css"),
    );
    return { dir, page: path.join(dir, "index.html"), outside };
  }

  it("wraps the page in a sandboxed frame and serves its assets", async () => {
    const { page } = await site();
    media = new MediaServer({ tailscale: null });
    const url = await media.share(page, "Explainer");
    const wrapper = await (await fetch(url)).text();
    expect(wrapper).toContain('src="site/index.html"');
    expect(wrapper).toContain('sandbox="allow-scripts');
    expect(wrapper).toContain("Close server");
    expect(await (await fetch(`${url}site/index.html`)).text()).toBe(
      "<h1>Hi</h1>",
    );
    const css = await fetch(`${url}site/assets/style.css`);
    expect(css.headers.get("content-type")).toContain("text/css");
    const part = await fetch(`${url}site/assets/clip.mp4`, {
      headers: { range: "bytes=0-3" },
    });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("0123");
  });

  it("refuses traversal, dotfiles, symlinks out, and other extensions", async () => {
    const { dir, outside } = await site();
    const refused = [
      "../secret.css",
      `..%2F${path.basename(outside)}%2Fsecret.css`,
      "%2e%2e/x.css",
      ".env",
      ".git/config.css",
      "notes.sh",
      "assets/link.css",
      "assets/missing.css",
      "assets",
    ];
    for (const relative of refused)
      expect(await siteAsset(dir, relative), relative).toBeNull();
    expect(await siteAsset(dir, "assets/style.css")).toMatch(/style\.css$/);
  });

  it("serves nothing under site/ for a shared file that isn't a page", async () => {
    media = new MediaServer({ tailscale: null });
    const url = await media.share(await videoFile(), "Demo");
    expect((await fetch(`${url}site/demo.mp4`)).status).toBe(404);
  });
});

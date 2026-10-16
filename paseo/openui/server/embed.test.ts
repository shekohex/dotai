import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PaseoApi } from "@getpaseo/client";
import { embedFileHtml } from "./embed";
import { MediaServer, privateLanAddress } from "./media-server";

async function project() {
  const cwd = await mkdtemp(path.join(tmpdir(), "openui-embed-"));
  await mkdir(path.join(cwd, "assets"));
  await writeFile(path.join(cwd, "assets", "app.css"), "body{color:red}");
  await writeFile(path.join(cwd, "assets", "app.js"), "window.ok = '</script>'");
  await writeFile(path.join(cwd, "assets", "dot.png"), Buffer.from([137, 80, 78, 71]));
  await writeFile(path.join(cwd, ".secret.css"), "top-secret");
  await writeFile(
    path.join(cwd, "page.html"),
    '<link rel="stylesheet" href="assets/app.css"><link rel="stylesheet" href=".secret.css"><link rel="stylesheet" href="https://cdn/x.css"><script src="assets/app.js"></script><img src="assets/dot.png" alt="d"><img src="missing.png">',
  );
  const paseo = { agents: { ref: () => ({ refresh: async () => {}, cwd }) } } as unknown as PaseoApi;
  return { paseo };
}

describe("embedFileHtml", () => {
  it("inlines local assets, leaves URLs and unreadable files alone", async () => {
    const { paseo } = await project();
    const html = await embedFileHtml(paseo, "a", "page.html");
    expect(html).toContain("<style>body{color:red}</style>");
    expect(html).toContain("<script>window.ok = '<\\/script>'</script>");
    expect(html).toContain("data:image/png;base64,iVBORw==");
    expect(html).toContain('href="https://cdn/x.css"');
    expect(html).toContain('href=".secret.css"');
    expect(html).not.toContain("top-secret");
    expect(html).toContain('src="missing.png"');
  });

  it("only reads html files", async () => {
    const { paseo } = await project();
    await expect(embedFileHtml(paseo, "a", "assets/app.css")).rejects.toThrow(/\.html/);
  });
});

describe("network address", () => {
  it("picks the first private IPv4 and skips loopback, public and IPv6", () => {
    const interfaces = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [
        { address: "fe80::1", family: "IPv6", internal: false },
        { address: "203.0.113.5", family: "IPv4", internal: false },
        { address: "192.168.1.20", family: "IPv4", internal: false },
      ],
    } as unknown as Parameters<typeof privateLanAddress>[0];
    expect(privateLanAddress(interfaces)).toBe("192.168.1.20");
    expect(privateLanAddress({} as never)).toBeNull();
  });

  it("gives a network URL when there is no Tailscale", async () => {
    const media = new MediaServer({ tailscale: null, lanAddress: () => "127.0.0.1" });
    const dir = await mkdtemp(path.join(tmpdir(), "openui-media-"));
    const file = path.join(dir, "a.html");
    await writeFile(file, "<p>hi</p>");
    const url = await media.share(file, "a.html");
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/openui-/);
    expect(await (await fetch(`${url}site/a.html`)).text()).toBe("<p>hi</p>");
    await media.close();
  });
});

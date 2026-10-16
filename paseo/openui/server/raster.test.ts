import { describe, expect, it } from "vitest";
import { renderRaster, type RasterRequest } from "./raster";

const base = { color: "#f0efec", scale: 2, maxWidth: 360 };
const png = (data: string) => Buffer.from(data, "base64").subarray(1, 4).toString("latin1") === "PNG";
const request = (kind: RasterRequest["kind"], source: string, extra: Partial<RasterRequest> = {}): RasterRequest => ({ kind, source, ...base, ...extra });

describe("renderRaster", () => {
  it("draws LaTeX", async () => {
    const result = await renderRaster(request("latex", "\\frac{a}{b} + \\sqrt{x^2}", { display: true }));
    expect(png(result.data)).toBe(true);
    expect(result.width).toBeGreaterThan(20);
    expect(result.height).toBeGreaterThan(10);
  });

  it("reports a LaTeX error", async () => {
    await expect(renderRaster(request("latex", "\\frac{"))).rejects.toThrow(/LaTeX error/);
  });

  it("draws an SVG and fits it to the width", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500"><rect width="1000" height="500" fill="currentColor"/></svg>';
    const result = await renderRaster(request("svg", svg));
    expect(png(result.data)).toBe(true);
    expect(result.width).toBe(360);
    expect(result.height).toBe(180);
  });

  it("refuses non-SVG sources and strips scripts and external images", async () => {
    await expect(renderRaster(request("svg", "<div/>"))).rejects.toThrow(/svg/);
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40"><script>alert(1)</script><image href="/etc/passwd" width="40" height="40"/><rect width="40" height="40" fill="red"/></svg>';
    expect(png((await renderRaster(request("svg", svg))).data)).toBe(true);
  });

  it("draws Graphviz and a QR code", async () => {
    expect(png((await renderRaster(request("dot", "digraph { a -> b }"))).data)).toBe(true);
    const qr = await renderRaster(request("qr", "https://paseo.sh"));
    expect(qr.width).toBe(200);
  });

  it("draws Arabic text", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="40"><text x="10" y="28" font-size="22" font-family="Noto Sans Arabic" fill="#fff">مرحباً</text></svg>';
    expect(png((await renderRaster(request("svg", svg))).data)).toBe(true);
  });

  it("serves a repeat request from the cache", async () => {
    const first = await renderRaster(request("latex", "x^2"));
    expect(await renderRaster(request("latex", "x^2"))).toBe(first);
  });
});

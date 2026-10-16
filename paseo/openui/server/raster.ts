import { createRequire } from "node:module";
import path from "node:path";
import { PLUGIN_DIR } from "./paths.generated";

/**
 * Turns SVG, LaTeX, Graphviz DOT and QR sources into PNGs. The libraries load through a require
 * rooted at the plugin directory so the bundler leaves them (and resvg's native addon) in
 * node_modules.
 */

export interface RasterRequest {
  kind: "svg" | "latex" | "dot" | "qr";
  source: string;
  display?: boolean | undefined;
  color: string;
  scale: number;
  maxWidth: number;
}

export interface RasterResult {
  data: string;
  width: number;
  height: number;
}

const external = createRequire(path.join(PLUGIN_DIR, "package.json"));

interface ResvgImage {
  width: number;
  height: number;
  asPng(): Uint8Array;
}
interface ResvgInstance {
  width: number;
  height: number;
  render(): ResvgImage;
}
type ResvgConstructor = new (svg: string, options: object) => ResvgInstance;

const MAX_PIXELS_WIDE = 2400;
const LATEX_ZOOM = 1.4;
const QR_CSS_SIZE = 200;
const CACHE_LIMIT = 64;
const cache = new Map<string, RasterResult>();

function resvg(): ResvgConstructor {
  return (external("@resvg/resvg-js") as { Resvg: ResvgConstructor }).Resvg;
}

interface MathJaxAdaptor {
  innerHTML(node: unknown): string;
}
interface MathJaxDocument {
  convert(tex: string, options: { display: boolean }): unknown;
}
let math: { document: MathJaxDocument; adaptor: MathJaxAdaptor } | undefined;

function mathjax() {
  if (math) return math;
  const { mathjax: core } = external("mathjax-full/js/mathjax.js");
  const { TeX } = external("mathjax-full/js/input/tex.js");
  const { SVG } = external("mathjax-full/js/output/svg.js");
  const { liteAdaptor } = external("mathjax-full/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = external("mathjax-full/js/handlers/html.js");
  const { AllPackages } = external("mathjax-full/js/input/tex/AllPackages.js");
  const adaptor = liteAdaptor() as MathJaxAdaptor;
  RegisterHTMLHandler(adaptor);
  const document = core.document("", {
    InputJax: new TeX({ packages: AllPackages }),
    OutputJax: new SVG({ fontCache: "none" }),
  }) as MathJaxDocument;
  math = { document, adaptor };
  return math;
}

function latexToSvg(tex: string, display: boolean, color: string): string {
  const { document, adaptor } = mathjax();
  const html = adaptor.innerHTML(document.convert(tex, { display }));
  const error = /data-mjx-error="([^"]*)"/.exec(html);
  if (error) throw new Error(`LaTeX error: ${error[1]}`);
  const svg = html.slice(html.indexOf("<svg"), html.lastIndexOf("</svg>") + "</svg>".length);
  return svg.replaceAll("currentColor", color);
}

interface VizInstance {
  renderString(source: string, options: { format: string }): string;
}
let viz: Promise<VizInstance> | undefined;

async function dotToSvg(dot: string, color: string): Promise<string> {
  viz ??= (external("@viz-js/viz") as { instance(): Promise<VizInstance> }).instance();
  const svg = (await viz).renderString(dot, { format: "svg" });
  // Graphviz text carries no fill and would default to black; the root fill is inherited.
  return svg
    .replace("<svg", `<svg fill="${color}"`)
    .replace(/(fill|stroke)="(black|#000000)"/g, `$1="${color}"`)
    .replace(/fill="(white|#ffffff)"/g, 'fill="none"')
    .replace(/stroke="transparent"/g, 'stroke="none"')
    .replace(/font-family="[^"]*"/g, 'font-family="Noto Sans, sans-serif"');
}

async function qrToSvg(value: string, color: string): Promise<string> {
  const qr = external("qrcode") as {
    toString(value: string, options: object): Promise<string>;
  };
  return qr.toString(value, { type: "svg", margin: 1, color: { dark: color, light: "#00000000" } });
}

/** An agent-written SVG: no scripts, no embedded HTML, no images except inline data URIs. */
function cleanSvg(svg: string, color: string): string {
  if (!/<svg[\s>]/i.test(svg)) throw new Error("Svg source must be an <svg> document");
  return svg
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, "")
    .replace(/<image\b[^>]*?(?:xlink:)?href\s*=\s*["'](?!data:)[^"']*["'][^>]*>/gi, "")
    .replaceAll("currentColor", color);
}

function rasterize(svg: string, request: RasterRequest, zoom: number): RasterResult {
  const Resvg = resvg();
  const options = {
    background: "rgba(0, 0, 0, 0)",
    font: { loadSystemFonts: true, defaultFontFamily: "Noto Sans" },
  };
  const natural = new Resvg(svg, options).width;
  const widthPx = Math.min(MAX_PIXELS_WIDE, request.maxWidth * request.scale);
  const fitTo =
    natural * zoom > widthPx || request.kind === "qr"
      ? { mode: "width", value: Math.round(request.kind === "qr" ? Math.min(QR_CSS_SIZE, request.maxWidth) * request.scale : widthPx) }
      : { mode: "zoom", value: zoom };
  const image = new Resvg(svg, { ...options, fitTo }).render();
  return {
    data: Buffer.from(image.asPng()).toString("base64"),
    width: Math.round(image.width / request.scale),
    height: Math.round(image.height / request.scale),
  };
}

export async function renderRaster(request: RasterRequest): Promise<RasterResult> {
  const key = JSON.stringify(request);
  const hit = cache.get(key);
  if (hit) return hit;
  const { kind, source, color, scale } = request;
  let result: RasterResult;
  switch (kind) {
    case "latex":
      result = rasterize(latexToSvg(source, request.display ?? true, color), request, scale * LATEX_ZOOM);
      break;
    case "dot":
      result = rasterize(await dotToSvg(source, color), request, scale);
      break;
    case "qr":
      result = rasterize(await qrToSvg(source, color), request, scale);
      break;
    case "svg":
      result = rasterize(cleanSvg(source, color), request, scale);
      break;
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  cache.set(key, result);
  return result;
}

import { z } from "zod";

export const OPENUI_MCP_SERVER = "openui";
export const RENDER_TOOL = "render";

export const renderInputSchema = z.object({
  ui: z.string().optional().describe("OpenUI Lang program. Omit only when guide is true."),
  title: z.string().optional().describe("Short heading shown above the UI"),
  wait: z
    .boolean()
    .optional()
    .describe(
      "Default false. When true the call blocks until the user taps a button or submits a form, and returns their answer as the result.",
    ),
  guide: z
    .boolean()
    .optional()
    .describe("When true, return the component reference and syntax guide instead of rendering."),
  define: z
    .object({
      name: z.string().describe("Letters, digits, - and _; starts with a letter."),
      kind: z
        .enum(["component", "program"])
        .optional()
        .describe(
          'Default component: one OpenUI expression used inline as @Use("name", {props}). program: a whole multi-statement program (with root = ...) used as the entire ui: @Run("name", {props}).',
        ),
      scope: z
        .enum(["project", "global"])
        .optional()
        .describe("Default project: saved in this project's .paseo/openui/ and visible to agents working in it. global: visible in every project. A project definition wins over a global one of the same name."),
      template: z
        .string()
        .optional()
        .describe('The OpenUI source with {{prop}} holes, e.g. Card([Heading("{{title}}")]). Omit to delete.'),
      description: z.string().optional().describe("One line on what it shows and which props it takes."),
      example: z.unknown().optional().describe("Sample props object; the template is test-rendered with it before saving."),
      overwrite: z.boolean().optional().describe("Replace an existing definition of the same name in the same scope. Default false: you get the existing one back instead."),
    })
    .optional()
    .describe("Save (or delete) a reusable component or program instead of rendering."),
});

export type RenderInput = z.infer<typeof renderInputSchema>;

/** Claude: mcp__openui__render. Codex: openui.render. Other providers vary and are probed in the spike. */
const RENDER_TOOL_NAMES = new Set([
  `mcp__${OPENUI_MCP_SERVER}__${RENDER_TOOL}`,
  `${OPENUI_MCP_SERVER}.${RENDER_TOOL}`,
  `${OPENUI_MCP_SERVER}_${RENDER_TOOL}`,
  `${OPENUI_MCP_SERVER}__${RENDER_TOOL}`,
]);

export function isRenderToolName(name: string): boolean {
  return RENDER_TOOL_NAMES.has(name);
}

export function mentionsOpenUi(name: string): boolean {
  return name.toLowerCase().includes(OPENUI_MCP_SERVER);
}

export const renderCallSchema = z.object({
  ui: z.string(),
  title: z.string().optional(),
  wait: z.boolean().optional(),
  status: z.enum(["running", "completed", "failed", "canceled"]),
  phase: z.enum(["streaming", "complete"]),
  output: z.string().optional(),
});

export type RenderCall = z.infer<typeof renderCallSchema>;

/** Providers report MCP input as an object or, for Codex, a JSON string. */
function inputObject(raw: unknown): Record<string, unknown> | null {
  const value: unknown =
    typeof raw === "string"
      ? (() => {
          try {
            return JSON.parse(raw) as unknown;
          } catch {
            return null;
          }
        })()
      : raw;
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Text out of whatever shape a provider reports for an MCP result. */
export function resultText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts = value.map(resultText).filter(Boolean);
    return parts.length ? parts.join("\n") : undefined;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") return record.text;
    if ("content" in record) return resultText(record.content);
    if ("message" in record && typeof record.message === "string") return record.message;
  }
  return undefined;
}

/** The render data when a timeline tool call is ours and already carries `ui`, else null. */
export function renderCall(
  item: {
    name: string;
    status: string;
    detail: { type: string; input?: unknown; output?: unknown };
  },
  phase: RenderCall["phase"],
): RenderCall | null {
  if (!isRenderToolName(item.name)) return null;
  const input = inputObject(item.detail.type === "unknown" ? item.detail.input : undefined);
  if (!input || typeof input.ui !== "string" || input.ui.length === 0) return null;
  const status = (
    ["running", "completed", "failed", "canceled"].includes(item.status) ? item.status : "completed"
  ) as RenderCall["status"];
  const output = item.detail.type === "unknown" ? resultText(item.detail.output) : undefined;
  return {
    ui: input.ui,
    ...(typeof input.title === "string" ? { title: input.title } : {}),
    ...(input.wait === true ? { wait: true } : {}),
    status,
    phase,
    ...(output ? { output } : {}),
  };
}

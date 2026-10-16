import { z } from "zod";

/**
 * How a tap or form answer travels to the agent: readable to a model, and recognisable to the app
 * so the same text can be drawn as a small card instead of raw XML.
 */
const TAG = "openui-answer";

export const answerSchema = z.object({
  title: z.string().optional(),
  message: z.string(),
  values: z.record(z.string(), z.unknown()).optional(),
  context: z.unknown().optional(),
});

export type Answer = z.infer<typeof answerSchema>;

const escapeText = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unescapeText = (value: string) => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const escapeAttribute = (value: string) => escapeText(value).replace(/"/g, "&quot;");
const unescapeAttribute = (value: string) => unescapeText(value.replace(/&quot;/g, '"'));
/** JSON inside a tag must not be able to close it. */
const jsonText = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

export function formatAnswer(answer: Answer): string {
  const open = answer.title ? `<${TAG} title="${escapeAttribute(answer.title)}">` : `<${TAG}>`;
  return [
    open,
    `<message>${escapeText(answer.message || "(no message)")}</message>`,
    ...(answer.values && Object.keys(answer.values).length > 0 ? [`<values>${jsonText(answer.values)}</values>`] : []),
    ...(answer.context === undefined ? [] : [`<context>${jsonText(answer.context)}</context>`]),
    `</${TAG}>`,
  ].join("\n");
}

const WHOLE = new RegExp(`^\\s*<${TAG}(?: title="([^"]*)")?>\\s*([\\s\\S]*?)\\s*</${TAG}>\\s*$`);

function section(body: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(body)?.[1];
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The answer in `text` when the whole text is one answer, else null. */
export function parseAnswer(text: string): Answer | null {
  const match = WHOLE.exec(text);
  if (!match) return null;
  const body = match[2] ?? "";
  const values = parseJson(section(body, "values"));
  const context = parseJson(section(body, "context"));
  return {
    ...(match[1] ? { title: unescapeAttribute(match[1]) } : {}),
    message: unescapeText(section(body, "message") ?? ""),
    ...(values && typeof values === "object" && !Array.isArray(values) ? { values: values as Record<string, unknown> } : {}),
    ...(context === undefined ? {} : { context }),
  };
}

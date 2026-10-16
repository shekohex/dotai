import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** A click or form submit in a rendered UI. Answers a waiting render, else reaches the agent as a message. */
export const respondRpc = defineRpc({
  name: "openui.respond",
  input: z
    .object({
      agentId: z.string(),
      key: z.string(),
      text: z.string().max(20_000),
    })
    .strict(),
  output: z.object({ delivered: z.enum(["tool_result", "message"]) }),
});

function unwrap(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return (value as { value: unknown }).value;
  }
  return value;
}

/** Form fields and $variables out of the store snapshot, without the internal { value, componentType } wrappers. */
export function plainState(
  snapshot: Record<string, unknown>,
  formName?: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(snapshot)) {
    const isForm =
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      !("value" in entry) &&
      !key.startsWith("$");
    if (isForm) {
      if (formName && key !== formName) continue;
      out[key] = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([field, raw]) => [field, unwrap(raw)]),
      );
    } else if (!formName) {
      out[key] = unwrap(entry);
    }
  }
  return out;
}

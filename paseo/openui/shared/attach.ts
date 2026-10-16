import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** `/openui`: teach an already running agent to draw UI, since its session cannot gain the render tool. */
export const attachRpc = defineRpc({
  name: "openui.attach",
  input: z.object({ agentId: z.string() }).strict(),
  output: z.object({ ok: z.literal(true) }),
});

const OPEN = "<openui-setup>";
const CLOSE = "</openui-setup>";

/** The message sent to the agent; the timeline folds it into a one-line notice. */
export function formatSetup(guide: string): string {
  return [
    OPEN,
    "OpenUI is on for this conversation. You do not have a render tool in this session, so draw UI by putting an OpenUI Lang program in a fenced block tagged openui. Paseo renders the block as native UI in the chat.",
    "Taps and form answers reach you later as <openui-answer> messages.",
    "Reference:",
    guide,
    CLOSE,
    "Reply with one short line saying OpenUI is ready. Do not draw anything yet.",
  ].join("\n");
}

export function isSetup(text: string): boolean {
  return text.trimStart().startsWith(OPEN);
}

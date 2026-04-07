import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const COMMENTARY_PROMPT = `
## Response channels

Use commentary for short progress updates while working and final for the completed response.

### commentary channel

Only use commentary for intermediary updates. These are short updates while you are working; they are not final answers. Keep updates brief and only send them when they add meaningful new information: a discovery, a tradeoff, a blocker, a substantial plan, or the start of a non-trivial edit or verification step.

Do not narrate routine reads, searches, obvious next steps, or minor confirmations. Combine related progress into a single update.

Before substantial work, send a short commentary update describing your first step. Before editing files, send a short commentary update describing the edit.

### final channel

Use final for the completed response.
`;

export default function commentaryModeExtension(pi: ExtensionAPI) {
  let enabled = true;

  pi.registerCommand("commentary-mode", {
    description: "Toggle commentary/final response channel instructions (on by default)",
    getArgumentCompletions(argumentPrefix) {
      const items = ["on", "off", "status"]
        .filter((value) => value.startsWith(argumentPrefix.trim().toLowerCase()))
        .map((value) => ({ value, label: value }));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const value = args.trim().toLowerCase();
      if (value === "on") {
        enabled = true;
      } else if (value === "off") {
        enabled = false;
      } else if (value === "status") {
        ctx.ui.notify(`Commentary mode is ${enabled ? "on" : "off"}`, "info");
        return;
      } else {
        enabled = !enabled;
      }

      ctx.ui.notify(`Commentary mode ${enabled ? "enabled" : "disabled"}`, "info");
    },
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled) {
      return undefined;
    }

    const model = ctx.model;
    if (!model || !shouldUseCommentaryPrompt(model.provider, model.id)) {
      return undefined;
    }

    if (event.systemPrompt.includes("## Response channels")) {
      return undefined;
    }

    return {
      systemPrompt: `${event.systemPrompt}\n\n${COMMENTARY_PROMPT.trim()}`,
    };
  });
}

function shouldUseCommentaryPrompt(provider: string, modelId: string): boolean {
  const normalizedProvider = provider.toLowerCase();
  const normalizedModelId = modelId.toLowerCase();

  if (!normalizedModelId.includes("gpt")) {
    return false;
  }

  return (
    normalizedProvider === "codex-openai" ||
    normalizedProvider === "openai" ||
    normalizedProvider === "openai-codex"
  );
}

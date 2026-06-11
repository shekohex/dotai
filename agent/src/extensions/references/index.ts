import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getReferencesArgumentCompletions, handleReferencesCommand } from "./commands.js";
import {
  buildReferenceExpansionContent,
  REFERENCE_EXPANSION_MESSAGE,
  registerReferenceMessageRenderers,
} from "./messages.js";
import {
  buildReferencesSystemContext,
  createReferenceRuntimeState,
  createReferencesAutocompleteProvider,
  refreshLoadedReferences,
  reloadReferenceConfig,
  refreshReferences,
  resolveReferenceMentions,
} from "./runtime.js";

export default function referencesExtension(pi: ExtensionAPI): void {
  const state = createReferenceRuntimeState();
  let autocompleteRegistered = false;

  registerReferenceMessageRenderers(pi);

  pi.registerCommand("references", {
    description: "Manage project references",
    getArgumentCompletions: getReferencesArgumentCompletions,
    handler: (args, ctx) => handleReferencesCommand(pi, state, args, ctx),
  });

  pi.on("session_start", async (event, ctx) => {
    await reloadReferenceConfig(ctx.cwd, state);
    if (!autocompleteRegistered) {
      autocompleteRegistered = true;
      ctx.ui.addAutocompleteProvider((current) =>
        createReferencesAutocompleteProvider(current, state),
      );
    }
    if (event.reason === "startup") {
      scheduleStartupRefresh(pi, state);
    }
  });

  pi.on("before_agent_start", (event) => {
    const context = buildReferencesSystemContext(state);
    const mentions = resolveReferenceMentions(event.prompt, state);
    const content = buildReferenceExpansionContent(mentions);
    const result = {
      ...(context.length === 0 ? {} : { systemPrompt: `${event.systemPrompt}\n\n${context}` }),
      ...(content.length === 0
        ? {}
        : {
            message: {
              customType: REFERENCE_EXPANSION_MESSAGE,
              content,
              display: false,
              details: { mentions },
            },
          }),
    };
    return result;
  });
}

function scheduleStartupRefresh(
  pi: ExtensionAPI,
  state: ReturnType<typeof createReferenceRuntimeState>,
): void {
  const timeout = setTimeout(() => {
    void refreshLoadedReferences(pi, state, { remoteOnly: true });
  }, 0);
  timeout.unref?.();
}

export {
  buildReferencesSystemContext,
  createReferenceRuntimeState,
  createReferencesAutocompleteProvider,
  refreshLoadedReferences,
  reloadReferenceConfig,
  refreshReferences,
  resolveReferenceMentions,
  rewriteReferenceMentions,
} from "./runtime.js";

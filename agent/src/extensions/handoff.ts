/**
 * Handoff extension - transfer context to a new focused session
 *
 * Instead of compacting (which is lossy), handoff extracts what matters
 * for your next task and creates a new session with a generated prompt.
 *
 * Usage:
 *   /handoff now implement this for teams as well
 *   /handoff execute phase one of the plan
 *   /handoff check other places that need this fix
 *
 * The generated prompt appears as a draft in the editor for review/editing.
 */

import { complete, type Message } from "@mariozechner/pi-ai";
import type { ExtensionAPI, SessionEntry } from "@mariozechner/pi-coding-agent";
import { BorderedLoader, convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";

const SYSTEM_PROMPT = `You are a context transfer assistant. Given a conversation history and the user's goal for a new thread, generate a focused prompt that:

1. Summarizes relevant context from the conversation (decisions made, approaches taken, key findings)
2. Lists any relevant files that were discussed or modified
3. Clearly states the next task based on the user's goal
4. Is self-contained - the new thread should be able to proceed without the old conversation

Format your response as a prompt the user can send to start the new thread. Be concise but include all necessary context. Do not include any preamble like "Here's the prompt" - just output the prompt itself.

Example output format:
## Context
We've been working on X. Key decisions:
- Decision 1
- Decision 2

Files involved:
- path/to/file1.ts
- path/to/file2.ts

## Task
[Clear description of what to do next based on user's goal]`;


const HANDOFF_PROVIDER = "codex-openai" as const;
const HANDOFF_MODEL = "gpt-5.4-mini" as const;

export default function (pi: ExtensionAPI) {
  pi.registerCommand("handoff", {
    description: "Transfer context to a new focused session",
    handler: async (args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("handoff requires interactive mode", "error");
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify("No model selected", "error");
        return;
      }

      const goal = args.trim();
      if (!goal) {
        ctx.ui.notify("Usage: /handoff <goal for new thread>", "error");
        return;
      }

      // Gather conversation context from current branch
      const branch = ctx.sessionManager.getBranch();
      const messages = branch
        .filter((entry): entry is SessionEntry & { type: "message" } => entry.type === "message")
        .map((entry) => entry.message);

      if (messages.length === 0) {
        ctx.ui.notify("No conversation to hand off", "error");
        return;
      }

      // Convert to LLM format and serialize
      const llmMessages = convertToLlm(messages);
      const conversationText = serializeConversation(llmMessages);
      const currentSessionFile = ctx.sessionManager.getSessionFile();

      const model = ctx.modelRegistry.find(HANDOFF_PROVIDER, HANDOFF_MODEL);
      if (!model) {
        ctx.ui.notify(`Could not find ${HANDOFF_PROVIDER}/${HANDOFF_MODEL} model for handoff, using current session model.`, "warning");
      }


      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model ?? ctx.model);
      if (!auth.ok) {
        ctx.ui.notify(`Compaction auth failed: ${auth.error}`, "warning");
        return;
      }

      if (!auth.apiKey) {
        ctx.ui.notify(`No API key for ${model?.provider ?? ctx.model.provider}, using default compaction`, "warning");
        return;
      }


      // Generate the handoff prompt with loader UI
      const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, `Generating handoff prompt...`);
        loader.onAbort = () => done(null);


        const doGenerate = async () => {
          const userMessage: Message = {
            role: "user",
            content: [
              {
                type: "text",
                text: `## Conversation History\n\n${conversationText}\n\n## User's Goal for New Thread\n\n${goal}`,
              },
            ],
            timestamp: Date.now(),
          };

          const response = await complete(
            model ?? ctx.model!,
            { systemPrompt: SYSTEM_PROMPT, messages: [userMessage] },
            { apiKey: auth.apiKey, headers: auth.headers, signal: loader.signal },
          );

          if (response.stopReason === "aborted") {
            return null;
          }

          return response.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
        };

        doGenerate()
          .then(done)
          .catch((err) => {
            console.error("Handoff generation failed:", err);
            done(null);
          });

        return loader;
      });

      if (result === null) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // Let user edit the generated prompt
      const editedPrompt = await ctx.ui.editor("Edit handoff prompt", result);

      if (editedPrompt === undefined) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // Create new session with parent tracking
      const newSessionResult = await ctx.newSession({
        parentSession: currentSessionFile,
      });

      if (newSessionResult.cancelled) {
        ctx.ui.notify("New session cancelled", "info");
        return;
      }

      // Set the edited prompt in the main editor for submission
      ctx.ui.setEditorText(editedPrompt);
      ctx.ui.notify("Handoff ready. Submit when ready.", "info");
    },
  });
}

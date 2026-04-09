import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSession, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type ModelFamilySystemPrompt = "codex" | "gpt" | "gemini" | "kimi" | "default";

const extensionDir = dirname(fileURLToPath(import.meta.url));
const systemPromptDir = join(extensionDir, "..", "resources", "system");
const promptFiles: Record<ModelFamilySystemPrompt, string> = {
  codex: join(systemPromptDir, "codex.md"),
  gpt: join(systemPromptDir, "gpt.md"),
  gemini: join(systemPromptDir, "gemini.md"),
  kimi: join(systemPromptDir, "kimi.md"),
  default: join(systemPromptDir, "default.md"),
};
const promptTexts = Object.fromEntries(
  Object.entries(promptFiles).map(([family, path]) => [family, readFileSync(path, "utf8").trim()]),
) as Record<ModelFamilySystemPrompt, string>;
const promptMarker = "Available tools:\n";
const patchSymbol = Symbol.for("@shekohex/agent/model-family-system-prompt-patched");

type SessionPromptState = {
  _baseSystemPrompt: string;
  agent: { state: { systemPrompt: string } };
  model?: { id?: string };
};

type AgentSessionPrototype = typeof AgentSession.prototype & {
  [patchSymbol]?: true;
};

export function resolveModelFamilySystemPrompt(modelId: string | undefined): ModelFamilySystemPrompt {
  const normalizedModelId = modelId?.trim().toLowerCase() ?? "";

  if (normalizedModelId.includes("codex")) {
    return "codex";
  }

  if (normalizedModelId.includes("gemini")) {
    return "gemini";
  }

  if (normalizedModelId.includes("kimi")) {
    return "kimi";
  }

  if (normalizedModelId.includes("gpt-5")) {
    return "gpt";
  }

  return "default";
}

export function extractPiDynamicTail(systemPrompt: string): string {
  const markerIndex = systemPrompt.indexOf(promptMarker);
  return markerIndex === -1 ? systemPrompt : systemPrompt.slice(markerIndex);
}

export function buildModelFamilySystemPrompt(systemPrompt: string, modelId: string | undefined): string {
  const family = resolveModelFamilySystemPrompt(modelId);
  const tail = extractPiDynamicTail(systemPrompt).trimStart();
  return tail.length > 0 ? `${promptTexts[family]}\n\n${tail}` : promptTexts[family];
}

function applySystemPrompt(session: AgentSession): void {
  const state = session as unknown as SessionPromptState;
  state.agent.state.systemPrompt = buildModelFamilySystemPrompt(state._baseSystemPrompt, state.model?.id);
}

function patchAgentSession(): void {
  const prototype = AgentSession.prototype as AgentSessionPrototype;
  if (prototype[patchSymbol]) {
    return;
  }

  const originalBindExtensions = prototype.bindExtensions;
  prototype.bindExtensions = async function patchedBindExtensions(this: AgentSession, bindings) {
    await originalBindExtensions.call(this, bindings);
    applySystemPrompt(this);
  };

  const originalSetModel = prototype.setModel;
  prototype.setModel = async function patchedSetModel(this: AgentSession, model) {
    await originalSetModel.call(this, model);
    applySystemPrompt(this);
  };

  const originalCycleModel = prototype.cycleModel;
  prototype.cycleModel = async function patchedCycleModel(this: AgentSession, direction) {
    const result = await originalCycleModel.call(this, direction);
    applySystemPrompt(this);
    return result;
  };

  const originalSetActiveToolsByName = prototype.setActiveToolsByName;
  prototype.setActiveToolsByName = function patchedSetActiveToolsByName(this: AgentSession, toolNames) {
    originalSetActiveToolsByName.call(this, toolNames);
    applySystemPrompt(this);
  };

  const originalReload = prototype.reload;
  prototype.reload = async function patchedReload(this: AgentSession) {
    await originalReload.call(this);
    applySystemPrompt(this);
  };

  prototype[patchSymbol] = true;
}

export default function modelFamilySystemPromptExtension(pi: ExtensionAPI): void {
  patchAgentSession();

  pi.on("before_agent_start", async (event, ctx) => ({
    systemPrompt: buildModelFamilySystemPrompt(event.systemPrompt, ctx.model?.id),
  }));
}

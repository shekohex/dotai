import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AgentSession, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

export type ModelFamilySystemPrompt = "codex" | "gpt" | "gemini" | "kimi" | "default";

const extensionDir = import.meta.dirname;
const systemPromptDir = join(extensionDir, "..", "resources", "system");
const promptFiles: Record<ModelFamilySystemPrompt, string> = {
  codex: join(systemPromptDir, "codex.md"),
  gpt: join(systemPromptDir, "gpt.md"),
  gemini: join(systemPromptDir, "gemini.md"),
  kimi: join(systemPromptDir, "kimi.md"),
  default: join(systemPromptDir, "default.md"),
};
const promptTexts: Record<ModelFamilySystemPrompt, string> = {
  codex: readFileSync(promptFiles.codex, "utf8").trim(),
  gpt: readFileSync(promptFiles.gpt, "utf8").trim(),
  gemini: readFileSync(promptFiles.gemini, "utf8").trim(),
  kimi: readFileSync(promptFiles.kimi, "utf8").trim(),
  default: readFileSync(promptFiles.default, "utf8").trim(),
};
const promptMarker = "Available tools:\n";
const patchSymbol = Symbol.for("@shekohex/agent/model-family-system-prompt-patched");

type AgentSessionPrototype = typeof AgentSession.prototype & {
  [patchSymbol]?: true;
};

function readStringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readModelId(session: AgentSession): string | undefined {
  const model = Reflect.get(session, "model");
  if (model === null || typeof model !== "object" || Array.isArray(model)) {
    return undefined;
  }

  return readStringField(Reflect.get(model, "id"));
}

function readBaseSystemPrompt(session: AgentSession): string | undefined {
  return readStringField(Reflect.get(session, "_baseSystemPrompt"));
}

function writeSystemPrompt(session: AgentSession, prompt: string): void {
  const agent = Reflect.get(session, "agent");
  if (agent === null || typeof agent !== "object" || Array.isArray(agent)) {
    return;
  }

  const state = Reflect.get(agent, "state");
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    return;
  }

  Reflect.set(state, "systemPrompt", prompt);
}

function readMethod(target: object, key: string): ((...args: unknown[]) => unknown) | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  const methodValue: unknown = descriptor?.value;
  if (typeof methodValue !== "function") {
    return undefined;
  }

  return function methodProxy(this: unknown, ...args: unknown[]): unknown {
    return Reflect.apply(methodValue, this, args);
  };
}

export function resolveModelFamilySystemPrompt(
  modelId: string | undefined,
): ModelFamilySystemPrompt {
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

export function buildModelFamilySystemPrompt(
  systemPrompt: string,
  modelId: string | undefined,
): string {
  const family = resolveModelFamilySystemPrompt(modelId);
  const tail = extractPiDynamicTail(systemPrompt).trimStart();
  return tail.length > 0 ? `${promptTexts[family]}\n\n${tail}` : promptTexts[family];
}

function applySystemPrompt(session: AgentSession): void {
  const baseSystemPrompt = readBaseSystemPrompt(session);
  if (baseSystemPrompt === undefined || baseSystemPrompt.length === 0) {
    return;
  }

  writeSystemPrompt(session, buildModelFamilySystemPrompt(baseSystemPrompt, readModelId(session)));
}

function patchAgentSession(): void {
  const prototype = AgentSession.prototype as AgentSessionPrototype;
  if (prototype[patchSymbol]) {
    return;
  }

  const originalBindExtensions = readMethod(prototype, "bindExtensions");
  if (!originalBindExtensions) {
    throw new TypeError("AgentSession.bindExtensions is unavailable");
  }
  prototype.bindExtensions = async function patchedBindExtensions(this: AgentSession, bindings) {
    await originalBindExtensions.call(this, bindings);
    applySystemPrompt(this);
  };

  const originalSetModel = readMethod(prototype, "setModel");
  if (!originalSetModel) {
    throw new TypeError("AgentSession.setModel is unavailable");
  }
  prototype.setModel = async function patchedSetModel(this: AgentSession, model) {
    await originalSetModel.call(this, model);
    applySystemPrompt(this);
  };

  const originalSetActiveToolsByName = readMethod(prototype, "setActiveToolsByName");
  if (!originalSetActiveToolsByName) {
    throw new TypeError("AgentSession.setActiveToolsByName is unavailable");
  }
  prototype.setActiveToolsByName = function patchedSetActiveToolsByName(
    this: AgentSession,
    toolNames,
  ) {
    originalSetActiveToolsByName.call(this, toolNames);
    applySystemPrompt(this);
  };

  const originalReload = readMethod(prototype, "reload");
  if (!originalReload) {
    throw new TypeError("AgentSession.reload is unavailable");
  }
  prototype.reload = async function patchedReload(this: AgentSession) {
    await originalReload.call(this);
    applySystemPrompt(this);
  };

  prototype[patchSymbol] = true;
}

export default function modelFamilySystemPromptExtension(pi: ExtensionAPI): void {
  patchAgentSession();

  pi.on("before_agent_start", (event, ctx) => ({
    systemPrompt: buildModelFamilySystemPrompt(event.systemPrompt, ctx.model?.id),
  }));
}

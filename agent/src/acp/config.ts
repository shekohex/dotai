import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { loadModeRegistry } from "../mode-utils.js";
import { MODE_STATE_ENTRY } from "../extensions/modes/index.js";
import { isThinkingLevel, readActiveModeFromEntry } from "../extensions/modes/events.js";
import type { AcpConfigOption } from "./core.js";

export async function buildAcpConfigOptions(session: AgentSession): Promise<AcpConfigOption[]> {
  const options: AcpConfigOption[] = [];
  const models = session.modelRuntime.getAvailableSnapshot();
  const currentModel = session.model;
  const modelValues = models.map((model) => ({
    value: modelValue(model.provider, model.id),
    name: `${model.provider}: ${model.name}`,
  }));
  if (
    currentModel !== undefined &&
    !modelValues.some((item) => item.value === modelValue(currentModel.provider, currentModel.id))
  ) {
    modelValues.unshift({
      value: modelValue(currentModel.provider, currentModel.id),
      name: `${currentModel.provider}: ${currentModel.name}`,
    });
  }
  if (currentModel !== undefined && modelValues.length > 0) {
    options.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: modelValue(currentModel.provider, currentModel.id),
      options: modelValues,
    });
  }

  const modes = await loadModeRegistry(session.sessionManager.getCwd());
  const modeValues = Object.entries(modes.resolvedData.modes).map(([name, spec]) => ({
    value: name,
    name,
    description: spec.description,
  }));
  const activeMode = currentMode(session) ?? modes.resolvedData.currentMode;
  if (activeMode !== undefined && modeValues.some((mode) => mode.value === activeMode)) {
    options.push({
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: activeMode,
      options: modeValues,
    });
  }

  const thinkingLevels = session.getAvailableThinkingLevels();
  if (thinkingLevels.length > 0) {
    options.push({
      id: "thinking",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: session.thinkingLevel,
      options: thinkingLevels.map((level) => ({ value: level, name: level })),
    });
  }
  return options;
}

export async function applyAcpConfigOption(
  session: AgentSession,
  configId: string,
  value: string | boolean,
): Promise<void> {
  if (typeof value !== "string") throw new Error(`ACP config ${configId} requires a string value`);
  const options = await buildAcpConfigOptions(session);
  const option = options.find((candidate) => candidate.id === configId);
  if (option === undefined) throw new Error(`Unknown ACP config option: ${configId}`);
  if (!option.options.some((candidate) => candidate.value === value)) {
    throw new Error(`Unknown value for ACP config ${configId}: ${value}`);
  }
  if (configId === "model") {
    const separator = value.indexOf("/");
    const model = session.modelRuntime.getModel(
      value.slice(0, separator),
      value.slice(separator + 1),
    );
    if (model === undefined) throw new Error(`ACP model no longer available: ${value}`);
    await session.setModel(model);
    return;
  }
  if (configId === "mode") {
    await session.prompt(`/mode ${value}`, { source: "rpc" });
    await session.waitForIdle();
    return;
  }
  if (configId === "thinking") {
    if (!isThinkingLevel(value)) throw new TypeError(`Invalid ACP thinking level: ${value}`);
    session.setThinkingLevel(value);
    return;
  }
  throw new Error(`Unknown ACP config option: ${configId}`);
}

function currentMode(session: AgentSession): string | undefined {
  return session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === MODE_STATE_ENTRY)
    .map((entry) => readActiveModeFromEntry(entry))
    .filter((mode): mode is string => mode !== undefined)
    .at(-1);
}

function modelValue(provider: string, modelId: string): string {
  return `${provider}/${modelId}`;
}

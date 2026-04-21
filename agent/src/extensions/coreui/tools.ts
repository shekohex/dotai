import {
  bashToolDefinition,
  editToolDefinition,
  readToolDefinition,
  writeToolDefinition,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";
import { bashToolParams, createBashToolOverrideDefinition } from "./tools-bash-render.js";
import {
  createEditToolOverrideDefinition,
  createWriteToolOverrideDefinition,
} from "./tools-edit-write.js";
import {
  countTextLines,
  formatDurationHuman,
  getTextContent,
  styleToolOutput,
  summarizeLineCount,
} from "./tools-output.js";
import { formatToolRail } from "./tools-status.js";
import {
  applyLinePrefix,
  createTextComponent,
  renderStreamingPreview,
  renderToolError,
  type CoreUIToolTheme,
  type StreamingPreviewOptions,
} from "./tools-render.js";
import { createReadToolOverrideDefinition } from "./tools-read.js";
import { formatMutedDirSuffix, getToolPathDisplay } from "./tools-path-render.js";

export { countTextLines, formatDurationHuman, getTextContent, styleToolOutput, summarizeLineCount };
export type { ToolOutputStyleOptions } from "./tools-output.js";
export { formatToolRail } from "./tools-status.js";
export { bashToolParams, createBashToolOverrideDefinition } from "./tools-bash-render.js";
export {
  createEditToolOverrideDefinition,
  createWriteToolOverrideDefinition,
} from "./tools-edit-write.js";
export { createReadToolOverrideDefinition } from "./tools-read.js";
export {
  applyLinePrefix,
  createTextComponent,
  renderStreamingPreview,
  renderToolError,
} from "./tools-render.js";
export type { CoreUIToolTheme, StreamingPreviewOptions } from "./tools-render.js";
export { formatMutedDirSuffix, getToolPathDisplay } from "./tools-path-render.js";

export function registerCoreUIToolOverrides(pi: ExtensionAPI): (activeToolNames: string[]) => void {
  const registeredToolNames = new Set<string>();

  return (activeToolNames: string[]) => {
    const activeTools = new Set(activeToolNames);

    if (
      activeTools.has(readToolDefinition.name) &&
      !registeredToolNames.has(readToolDefinition.name)
    ) {
      registerReadToolOverride(pi);
      registeredToolNames.add(readToolDefinition.name);
    }

    if (
      activeTools.has(bashToolDefinition.name) &&
      !registeredToolNames.has(bashToolDefinition.name)
    ) {
      registerBashToolOverride(pi);
      registeredToolNames.add(bashToolDefinition.name);
    }

    if (
      activeTools.has(editToolDefinition.name) &&
      !registeredToolNames.has(editToolDefinition.name)
    ) {
      registerEditToolOverride(pi);
      registeredToolNames.add(editToolDefinition.name);
    }

    if (
      activeTools.has(writeToolDefinition.name) &&
      !registeredToolNames.has(writeToolDefinition.name)
    ) {
      registerWriteToolOverride(pi);
      registeredToolNames.add(writeToolDefinition.name);
    }
  };
}

function registerBashToolOverride(pi: ExtensionAPI): void {
  pi.registerTool(createBashToolOverrideDefinition());
}

function registerReadToolOverride(pi: ExtensionAPI): void {
  pi.registerTool(createReadToolOverrideDefinition());
}

function registerEditToolOverride(pi: ExtensionAPI): void {
  pi.registerTool(createEditToolOverrideDefinition());
}

function registerWriteToolOverride(pi: ExtensionAPI): void {
  pi.registerTool(createWriteToolOverrideDefinition());
}

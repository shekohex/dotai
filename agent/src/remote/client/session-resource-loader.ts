import {
  createExtensionRuntime,
  createSyntheticSourceInfo,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import type { RemoteExtensionMetadata } from "../schemas.js";

function toRemoteLoadedExtension(
  extension: RemoteExtensionMetadata,
): LoadExtensionsResult["extensions"][number] {
  const path = extension.path;
  return {
    path,
    resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, {
      source: "remote-runtime",
      scope: "temporary",
      origin: "top-level",
    }),
    handlers: new Map(),
    tools: new Map(),
    messageRenderers: new Map(),
    commands: new Map(),
    flags: new Map(),
    shortcuts: new Map(),
  };
}

export function createRemoteResourceLoader(
  getExtensionsMetadata: () => RemoteExtensionMetadata[],
): ResourceLoader {
  const extensionRuntime = createExtensionRuntime();
  return {
    getExtensions: (): LoadExtensionsResult => ({
      extensions: getExtensionsMetadata().map((extension) => toRemoteLoadedExtension(extension)),
      errors: [],
      runtime: extensionRuntime,
    }),
    getSkills: (): ReturnType<ResourceLoader["getSkills"]> => ({ skills: [], diagnostics: [] }),
    getPrompts: (): ReturnType<ResourceLoader["getPrompts"]> => ({ prompts: [], diagnostics: [] }),
    getThemes: (): ReturnType<ResourceLoader["getThemes"]> => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: (): ReturnType<ResourceLoader["getAgentsFiles"]> => ({ agentsFiles: [] }),
    getSystemPrompt: (): ReturnType<ResourceLoader["getSystemPrompt"]> => undefined,
    getAppendSystemPrompt: (): ReturnType<ResourceLoader["getAppendSystemPrompt"]> => [],
    extendResources: (_paths: Parameters<ResourceLoader["extendResources"]>[0]) => {},
    reload: async () => {},
  };
}

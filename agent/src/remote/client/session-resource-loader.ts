import {
  DefaultResourceLoader,
  createSyntheticSourceInfo,
  type LoadExtensionsResult,
  type PromptTemplate,
  type ResourceLoader,
  type Skill,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import type { RemoteExtensionMetadata, RemoteResourceBundle, SessionSnapshot } from "../schemas.js";
import { RemoteResourceBundleSchema } from "../schemas.js";
import { createRemoteThemeFromContent } from "./remote-theme.js";
import { assertType } from "../typebox.js";

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

function toClientLoadedExtension(
  extension: LoadExtensionsResult["extensions"][number],
  metadata: RemoteExtensionMetadata | undefined,
): LoadExtensionsResult["extensions"][number] {
  if (!metadata) {
    return extension;
  }

  const path = metadata.path;
  return {
    ...extension,
    path,
    resolvedPath: path,
    sourceInfo: createSyntheticSourceInfo(path, {
      source: "remote-runtime",
      scope: "temporary",
      origin: "top-level",
    }),
  };
}

function readRemoteResources(snapshot: SessionSnapshot): RemoteResourceBundle {
  const resources = snapshot.resources;
  if (resources === undefined) {
    return {
      skills: [],
      prompts: [],
      themes: [],
      systemPrompt: null,
      appendSystemPrompt: [],
    };
  }

  assertType(RemoteResourceBundleSchema, resources);
  return resources;
}

function toRemoteSkills(resources: RemoteResourceBundle): Skill[] {
  return resources.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    disableModelInvocation: skill.disableModelInvocation,
    sourceInfo: createSyntheticSourceInfo(skill.filePath, {
      source: "remote-runtime",
      scope: "temporary",
      origin: "top-level",
    }),
  }));
}

function toRemotePrompts(resources: RemoteResourceBundle): PromptTemplate[] {
  return resources.prompts.map((prompt) => ({
    name: prompt.name,
    description: prompt.description,
    filePath: prompt.filePath,
    content: prompt.content,
    sourceInfo: createSyntheticSourceInfo(prompt.filePath, {
      source: "remote-runtime",
      scope: "temporary",
      origin: "top-level",
    }),
  }));
}

function toRemoteThemes(resources: RemoteResourceBundle): Theme[] {
  if (resources.themes.length === 0) {
    return [];
  }

  const loaded: Theme[] = [];
  for (const theme of resources.themes) {
    try {
      loaded.push(
        createRemoteThemeFromContent({
          sourcePath: theme.sourcePath,
          content: theme.content,
        }),
      );
    } catch {
      continue;
    }
  }

  return loaded;
}

export function createRemoteResourceLoader(input: {
  baseLoader: DefaultResourceLoader;
  snapshot: SessionSnapshot;
  getExtensionsMetadata: () => RemoteExtensionMetadata[];
  clientExtensions: RemoteExtensionMetadata[];
}): ResourceLoader {
  const remoteResources = readRemoteResources(input.snapshot);
  const remoteThemes = toRemoteThemes(remoteResources);

  return createRemoteResourceLoaderView({
    baseLoader: input.baseLoader,
    getExtensionsMetadata: input.getExtensionsMetadata,
    clientExtensions: input.clientExtensions,
    remoteResources,
    remoteThemes,
  });
}

function createRemoteResourceLoaderView(input: {
  baseLoader: DefaultResourceLoader;
  getExtensionsMetadata: () => RemoteExtensionMetadata[];
  clientExtensions: RemoteExtensionMetadata[];
  remoteResources: RemoteResourceBundle;
  remoteThemes: Theme[];
}): ResourceLoader {
  const remoteSkills = toRemoteSkills(input.remoteResources);
  const remotePrompts = toRemotePrompts(input.remoteResources);
  const remoteSystemPrompt = input.remoteResources.systemPrompt ?? undefined;
  const remoteAppendSystemPrompt = input.remoteResources.appendSystemPrompt;

  return {
    getExtensions: (): LoadExtensionsResult =>
      mergeRemoteAndClientExtensions({
        loaded: input.baseLoader.getExtensions(),
        getExtensionsMetadata: input.getExtensionsMetadata,
        clientExtensions: input.clientExtensions,
      }),
    getSkills: (): ReturnType<ResourceLoader["getSkills"]> => ({
      skills: [...remoteSkills],
      diagnostics: [],
    }),
    getPrompts: (): ReturnType<ResourceLoader["getPrompts"]> => ({
      prompts: [...remotePrompts],
      diagnostics: [],
    }),
    getThemes: (): ReturnType<ResourceLoader["getThemes"]> => ({
      themes: [...input.remoteThemes],
      diagnostics: [],
    }),
    getAgentsFiles: (): ReturnType<ResourceLoader["getAgentsFiles"]> => ({ agentsFiles: [] }),
    getSystemPrompt: (): ReturnType<ResourceLoader["getSystemPrompt"]> => remoteSystemPrompt,
    getAppendSystemPrompt: (): ReturnType<ResourceLoader["getAppendSystemPrompt"]> => [
      ...remoteAppendSystemPrompt,
    ],
    extendResources: (_paths: Parameters<ResourceLoader["extendResources"]>[0]) => {},
    reload: () => Promise.resolve(),
  };
}
function mergeRemoteAndClientExtensions(input: {
  loaded: LoadExtensionsResult;
  getExtensionsMetadata: () => RemoteExtensionMetadata[];
  clientExtensions: RemoteExtensionMetadata[];
}): LoadExtensionsResult {
  const syntheticRemote = input
    .getExtensionsMetadata()
    .filter((extension) => extension.runtime === "server")
    .map((extension) => toRemoteLoadedExtension(extension));
  const loadedClient = input.loaded.extensions.map((extension, index) =>
    toClientLoadedExtension(extension, input.clientExtensions[index]),
  );

  return {
    extensions: [...syntheticRemote, ...loadedClient],
    errors: [...input.loaded.errors],
    runtime: input.loaded.runtime,
  };
}

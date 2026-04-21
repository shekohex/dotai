import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import {
  DefaultResourceLoader,
  createSyntheticSourceInfo,
  type ExtensionFactory,
  type LoadExtensionsResult,
  type PromptTemplate,
  type ResourceLoader,
  type Skill,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { loadThemeFromPath } from "../../../node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { RemoteExtensionMetadata, RemoteResourceBundle, SessionSnapshot } from "../schemas.js";
import { RemoteResourceBundleSchema } from "../schemas.js";
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
  const resources: unknown = Reflect.get(snapshot, "resources");
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

function toSafeFileName(input: string): string {
  const normalized = input.trim().replaceAll(/[^a-zA-Z0-9._-]/g, "-");
  if (normalized.length === 0) {
    return "resource";
  }
  return normalized;
}

async function toRemoteThemes(resources: RemoteResourceBundle): Promise<Theme[]> {
  if (resources.themes.length === 0) {
    return [];
  }

  const tmpRoot = await mkdtemp(join(tmpdir(), "pi-remote-themes-"));
  const themesDir = join(tmpRoot, "themes");
  await mkdir(themesDir, { recursive: true });

  const loaded: Theme[] = [];
  for (let index = 0; index < resources.themes.length; index += 1) {
    const theme = resources.themes[index];
    const preferredName = basename(theme.sourcePath);
    const safeName = toSafeFileName(preferredName.length > 0 ? preferredName : theme.name);
    const extension = extname(safeName).length > 0 ? "" : ".json";
    const filePath = join(themesDir, `${index + 1}-${safeName}${extension}`);
    await writeFile(filePath, theme.content, "utf8");

    try {
      loaded.push(loadThemeFromPath(filePath));
    } catch {
      continue;
    }
  }

  return loaded;
}

export async function createRemoteResourceLoader(input: {
  cwd: string;
  agentDir: string;
  snapshot: SessionSnapshot;
  getExtensionsMetadata: () => RemoteExtensionMetadata[];
  clientExtensionFactories: ExtensionFactory[];
  clientExtensions: RemoteExtensionMetadata[];
}): Promise<ResourceLoader> {
  const baseLoader = await createBaseClientResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    clientExtensionFactories: input.clientExtensionFactories,
  });
  const remoteResources = readRemoteResources(input.snapshot);
  const remoteThemes = await toRemoteThemes(remoteResources);

  return createRemoteResourceLoaderView({
    baseLoader,
    getExtensionsMetadata: input.getExtensionsMetadata,
    clientExtensions: input.clientExtensions,
    remoteResources,
    remoteThemes,
  });
}

async function createBaseClientResourceLoader(input: {
  cwd: string;
  agentDir: string;
  clientExtensionFactories: ExtensionFactory[];
}): Promise<DefaultResourceLoader> {
  const baseLoader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir: input.agentDir,
    extensionFactories: input.clientExtensionFactories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await baseLoader.reload();
  return baseLoader;
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
    reload: async () => {
      await input.baseLoader.reload();
    },
  };
}

function mergeRemoteAndClientExtensions(input: {
  loaded: LoadExtensionsResult;
  getExtensionsMetadata: () => RemoteExtensionMetadata[];
  clientExtensions: RemoteExtensionMetadata[];
}): LoadExtensionsResult {
  const syntheticRemote = input
    .getExtensionsMetadata()
    .filter((extension) => extension.host === "server-bound")
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

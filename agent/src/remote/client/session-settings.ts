import type { SettingsManager } from "@mariozechner/pi-coding-agent";
import type { SettingsUpdateRequest } from "../schemas.js";

type SettingsSnapshotState = {
  globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>;
  projectSettings: ReturnType<SettingsManager["getProjectSettings"]>;
};

type SettingsMutationQueue = (
  execute: () => Promise<void>,
  rollback: () => void,
  label: string,
) => void;

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMergeSettings(base: RecordLike, overrides: RecordLike): RecordLike {
  const result: RecordLike = { ...base };

  for (const key of Object.keys(overrides)) {
    const overrideValue = overrides[key];
    const baseValue = base[key];

    if (overrideValue === undefined) {
      continue;
    }

    if (isRecord(overrideValue) && isRecord(baseValue)) {
      result[key] = {
        ...baseValue,
        ...overrideValue,
      };
      continue;
    }

    result[key] = overrideValue;
  }

  return result;
}

function serializeSettings(settings: RecordLike): string | undefined {
  return Object.keys(settings).length > 0 ? JSON.stringify(settings) : undefined;
}

function getSettingsManagerState(settingsManager: SettingsManager): SettingsSnapshotState {
  return {
    globalSettings: settingsManager.getGlobalSettings(),
    projectSettings: settingsManager.getProjectSettings(),
  };
}

function setInternalField(target: object, key: string, value: unknown): void {
  Reflect.set(target, key, value);
}

type WrapSingleMutation = <TArg>(config: {
  applyLocal: (value: TArg) => void;
  assign: (wrapped: (value: TArg) => void) => void;
  buildRequest: (value: TArg) => SettingsUpdateRequest;
}) => void;

export function applySettingsManagerStateInPlace(
  settingsManager: SettingsManager,
  state: SettingsSnapshotState,
): void {
  const globalSettings = structuredClone(state.globalSettings);
  const projectSettings = structuredClone(state.projectSettings);
  const globalRecord = { ...globalSettings };
  const projectRecord = { ...projectSettings };
  const mergedSettings = deepMergeSettings(globalRecord, projectRecord);

  const storageCandidate: unknown = Reflect.get(settingsManager, "storage");
  if (isRecord(storageCandidate)) {
    setInternalField(storageCandidate, "global", serializeSettings(globalRecord));
    setInternalField(storageCandidate, "project", serializeSettings(projectRecord));
  }

  setInternalField(settingsManager, "globalSettings", globalSettings);
  setInternalField(settingsManager, "projectSettings", projectSettings);
  setInternalField(settingsManager, "settings", mergedSettings);
  setInternalField(settingsManager, "modifiedFields", new Set());
  setInternalField(settingsManager, "modifiedNestedFields", new Map());
  setInternalField(settingsManager, "modifiedProjectFields", new Set());
  setInternalField(settingsManager, "modifiedProjectNestedFields", new Map());
  setInternalField(settingsManager, "globalSettingsLoadError", null);
  setInternalField(settingsManager, "projectSettingsLoadError", null);
}

export function applyRemoteSettingsSnapshotInPlace(
  settingsManager: SettingsManager,
  settings: RecordLike,
): void {
  applySettingsManagerStateInPlace(settingsManager, {
    globalSettings: structuredClone(settings),
    projectSettings: {},
  });
}

export function patchSettingsManagerForRemoteSettingsSync(input: {
  settingsManager: SettingsManager;
  enqueueMutation: SettingsMutationQueue;
  clientUpdate: (request: SettingsUpdateRequest) => Promise<void>;
}): void {
  const label = "Update remote settings";
  const readState = () => getSettingsManagerState(input.settingsManager);
  const restoreState = (state: SettingsSnapshotState) => {
    applySettingsManagerStateInPlace(input.settingsManager, state);
  };

  const wrap = <TArg>(config: {
    applyLocal: (value: TArg) => void;
    assign: (wrapped: (value: TArg) => void) => void;
    buildRequest: (value: TArg) => SettingsUpdateRequest;
  }) => {
    config.assign((value) => {
      const previousState = readState();
      config.applyLocal(value);
      input.enqueueMutation(
        async () => {
          await input.clientUpdate(config.buildRequest(value));
        },
        () => {
          restoreState(previousState);
        },
        label,
      );
    });
  };

  registerGeneralSettingsMutations(input.settingsManager, wrap);
  registerResourceSettingsMutations(input.settingsManager, wrap);
  registerUiSettingsMutations(input.settingsManager, wrap);
}

function registerGeneralSettingsMutations(
  settingsManager: SettingsManager,
  wrap: WrapSingleMutation,
): void {
  wrap<string>({
    applyLocal: settingsManager.setLastChangelogVersion.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setLastChangelogVersion = wrapped;
    },
    buildRequest: (version) => ({ method: "setLastChangelogVersion", args: [version] }),
  });
  wrap<Parameters<SettingsManager["setSteeringMode"]>[0]>({
    applyLocal: settingsManager.setSteeringMode.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setSteeringMode = wrapped;
    },
    buildRequest: (mode) => ({ method: "setSteeringMode", args: [mode] }),
  });
  wrap<Parameters<SettingsManager["setFollowUpMode"]>[0]>({
    applyLocal: settingsManager.setFollowUpMode.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setFollowUpMode = wrapped;
    },
    buildRequest: (mode) => ({ method: "setFollowUpMode", args: [mode] }),
  });
  wrap<string>({
    applyLocal: settingsManager.setTheme.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setTheme = wrapped;
    },
    buildRequest: (theme) => ({ method: "setTheme", args: [theme] }),
  });
  wrap<Parameters<SettingsManager["setTransport"]>[0]>({
    applyLocal: settingsManager.setTransport.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setTransport = wrapped;
    },
    buildRequest: (transport) => ({ method: "setTransport", args: [transport] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setCompactionEnabled.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setCompactionEnabled = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setCompactionEnabled", args: [enabled] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setRetryEnabled.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setRetryEnabled = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setRetryEnabled", args: [enabled] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setHideThinkingBlock.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setHideThinkingBlock = wrapped;
    },
    buildRequest: (hidden) => ({ method: "setHideThinkingBlock", args: [hidden] }),
  });
  wrap<Parameters<SettingsManager["setShellPath"]>[0]>({
    applyLocal: settingsManager.setShellPath.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setShellPath = wrapped;
    },
    buildRequest: (path) => ({ method: "setShellPath", args: [path ?? null] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setQuietStartup.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setQuietStartup = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setQuietStartup", args: [enabled] }),
  });
  wrap<Parameters<SettingsManager["setShellCommandPrefix"]>[0]>({
    applyLocal: settingsManager.setShellCommandPrefix.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setShellCommandPrefix = wrapped;
    },
    buildRequest: (prefix) => ({ method: "setShellCommandPrefix", args: [prefix ?? null] }),
  });
  wrap<Parameters<SettingsManager["setNpmCommand"]>[0]>({
    applyLocal: settingsManager.setNpmCommand.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setNpmCommand = wrapped;
    },
    buildRequest: (command) => ({ method: "setNpmCommand", args: [command ?? null] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setCollapseChangelog.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setCollapseChangelog = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setCollapseChangelog", args: [enabled] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setEnableInstallTelemetry.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setEnableInstallTelemetry = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setEnableInstallTelemetry", args: [enabled] }),
  });
}

function registerResourceSettingsMutations(
  settingsManager: SettingsManager,
  wrap: WrapSingleMutation,
): void {
  wrap<Parameters<SettingsManager["setPackages"]>[0]>({
    applyLocal: settingsManager.setPackages.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setPackages = wrapped;
    },
    buildRequest: (packages) => ({ method: "setPackages", args: [packages] }),
  });
  wrap<Parameters<SettingsManager["setProjectPackages"]>[0]>({
    applyLocal: settingsManager.setProjectPackages.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setProjectPackages = wrapped;
    },
    buildRequest: (packages) => ({ method: "setProjectPackages", args: [packages] }),
  });
  wrap<Parameters<SettingsManager["setExtensionPaths"]>[0]>({
    applyLocal: settingsManager.setExtensionPaths.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setExtensionPaths = wrapped;
    },
    buildRequest: (paths) => ({ method: "setExtensionPaths", args: [paths] }),
  });
  wrap<Parameters<SettingsManager["setProjectExtensionPaths"]>[0]>({
    applyLocal: settingsManager.setProjectExtensionPaths.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setProjectExtensionPaths = wrapped;
    },
    buildRequest: (paths) => ({ method: "setProjectExtensionPaths", args: [paths] }),
  });
  wrap<Parameters<SettingsManager["setSkillPaths"]>[0]>({
    applyLocal: settingsManager.setSkillPaths.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setSkillPaths = wrapped;
    },
    buildRequest: (paths) => ({ method: "setSkillPaths", args: [paths] }),
  });
  wrap<Parameters<SettingsManager["setProjectSkillPaths"]>[0]>({
    applyLocal: settingsManager.setProjectSkillPaths.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setProjectSkillPaths = wrapped;
    },
    buildRequest: (paths) => ({ method: "setProjectSkillPaths", args: [paths] }),
  });
  wrap<Parameters<SettingsManager["setPromptTemplatePaths"]>[0]>({
    applyLocal: settingsManager.setPromptTemplatePaths.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setPromptTemplatePaths = wrapped;
    },
    buildRequest: (paths) => ({ method: "setPromptTemplatePaths", args: [paths] }),
  });
  wrap<Parameters<SettingsManager["setProjectPromptTemplatePaths"]>[0]>({
    applyLocal: settingsManager.setProjectPromptTemplatePaths.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setProjectPromptTemplatePaths = wrapped;
    },
    buildRequest: (paths) => ({ method: "setProjectPromptTemplatePaths", args: [paths] }),
  });
  wrap<Parameters<SettingsManager["setThemePaths"]>[0]>({
    applyLocal: settingsManager.setThemePaths.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setThemePaths = wrapped;
    },
    buildRequest: (paths) => ({ method: "setThemePaths", args: [paths] }),
  });
  wrap<Parameters<SettingsManager["setProjectThemePaths"]>[0]>({
    applyLocal: settingsManager.setProjectThemePaths.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setProjectThemePaths = wrapped;
    },
    buildRequest: (paths) => ({ method: "setProjectThemePaths", args: [paths] }),
  });
}

function registerUiSettingsMutations(
  settingsManager: SettingsManager,
  wrap: WrapSingleMutation,
): void {
  wrap<boolean>({
    applyLocal: settingsManager.setEnableSkillCommands.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setEnableSkillCommands = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setEnableSkillCommands", args: [enabled] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setShowImages.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setShowImages = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setShowImages", args: [enabled] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setClearOnShrink.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setClearOnShrink = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setClearOnShrink", args: [enabled] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setImageAutoResize.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setImageAutoResize = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setImageAutoResize", args: [enabled] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setBlockImages.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setBlockImages = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setBlockImages", args: [enabled] }),
  });
  wrap<Parameters<SettingsManager["setDoubleEscapeAction"]>[0]>({
    applyLocal: settingsManager.setDoubleEscapeAction.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setDoubleEscapeAction = wrapped;
    },
    buildRequest: (action) => ({ method: "setDoubleEscapeAction", args: [action] }),
  });
  wrap<Parameters<SettingsManager["setTreeFilterMode"]>[0]>({
    applyLocal: settingsManager.setTreeFilterMode.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setTreeFilterMode = wrapped;
    },
    buildRequest: (mode) => ({ method: "setTreeFilterMode", args: [mode] }),
  });
  wrap<boolean>({
    applyLocal: settingsManager.setShowHardwareCursor.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setShowHardwareCursor = wrapped;
    },
    buildRequest: (enabled) => ({ method: "setShowHardwareCursor", args: [enabled] }),
  });
  wrap<number>({
    applyLocal: settingsManager.setEditorPaddingX.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setEditorPaddingX = wrapped;
    },
    buildRequest: (padding) => ({ method: "setEditorPaddingX", args: [padding] }),
  });
  wrap<number>({
    applyLocal: settingsManager.setAutocompleteMaxVisible.bind(settingsManager),
    assign: (wrapped) => {
      settingsManager.setAutocompleteMaxVisible = wrapped;
    },
    buildRequest: (maxVisible) => ({ method: "setAutocompleteMaxVisible", args: [maxVisible] }),
  });
}

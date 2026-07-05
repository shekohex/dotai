# Architecture overview

How `@shekohex/agent` boots, wires its extensions, resolves modes, and manages settings. The package is a thin wrapper: it does pre-flight setup, then delegates to upstream `@earendil-works/pi-coding-agent`'s `main()`.

## Boot sequence

`src/cli.ts` is the entry point (`bin/pi.js` shim → compiled `dist/cli.js`). It runs:

1. **Install bundled resource paths** — `installBundledResourcePaths()` (`src/extensions/bundled-resources.ts`) monkeypatches `DefaultResourceLoader.prototype.reload` so the upstream loader also scans `src/resources/` for skills, prompt templates, and themes. See [Resources](../resources/overview.md).
2. **Update intercept** — `handleWrapperUpdateCommand({ args })` (`src/update/command.ts`). If the user ran `pi update`, it performs the GitHub Packages self-update and exits. See [Build & update](../operations/build-and-update.md#self-update).
3. **Resolve cwd** — `resolveCwd(process.cwd())` (`src/utils/cwd.ts`) expands `~` and `$VAR`. Upstream's `normalizePath` only expands `~`, so this catches `$HOME`/`$VAR` before upstream treats them as relative paths and produces corrupt session dirs.
4. **Remote mode** — `isRemoteMode(args)` (`src/remote/mode.ts`). If `--mode remote` is present, `runRemoteMode()` starts the TCP server and the process exits when done. See [Remote mode](../sessions/remote.md).
5. **Seed/merge settings** — `ensureRuntimeDefaultSettings()` (`src/runtime-default-settings.ts`), skipped for `--help`/`--version`.
6. **Hand off** — `main(args, { extensionFactories: bundledExtensionFactories })`. Upstream pi starts its interactive loop with every bundled extension registered.

```ts
// src/cli.ts (abridged)
installBundledResourcePaths();
if (await handleWrapperUpdateCommand({ args })) process.exit(process.exitCode ?? 0);
const resolvedCwd = resolveCwd(process.cwd());
if (resolvedCwd !== process.cwd()) process.chdir(resolvedCwd);
if (isRemoteMode(args)) { await runRemoteMode(parseRemoteModeArgs(args, resolvedCwd)); process.exit(0); }
if (shouldEnsureRuntimeDefaultSettings(args)) await ensureRuntimeDefaultSettings();
await main(args, { extensionFactories: bundledExtensionFactories });
```

## Extension system

Extensions are upstream pi `ExtensionFactory` functions. The wrapper groups them into three registries and adds the subagent extension:

- `src/extensions/definitions-group-a.ts` (14) — core UI, providers, tools, modes, commit.
- `src/extensions/definitions-group-b.ts` (16) — review, sessions, context, files, workflows.
- `src/extensions/definitions-group-c.ts` (16) — goals, workflows, external tools, integrations, web UIs.
- `subagent` — built separately via `createSubagentExtension({ enabled: true })`.

`src/extensions/index.ts` concatenates these into `bundledExtensionDefinitions` (46 + subagent = **47**), applies `setInlineExtensionName(factory, id)` to give each a stable inline name, and exposes `bundledExtensionFactories` (the array of factories passed to `main()`) plus `findBundledExtensionDefinitionByFactory()` for lookups.

`installInlineExtensionNamePatch()` (`src/extensions/inline-extension-names.ts`) patches the upstream so each extension's inline tool/label rendering uses its `id`.

Each extension lives in its own directory under `src/extensions/<id>/` (or a single `src/extensions/<id>.ts` for smaller ones) and typically exports a default factory. See the [Extensions catalog](../extensions/catalog.md) for the full list.

To add an extension: write the factory, add `{ id, factory }` to the appropriate `definitions-group-*.ts`, and rebuild. Nothing else is needed for it to register.

## Mode system

Modes are preset bundles of (provider, model, thinking level, tools, system prompt, fallbacks, color, tmux target). They are how the wrapper maps a named mode like `build` or `review` to a concrete model configuration.

- **Schema** — `src/mode-definitions.ts` defines `ModeSpecSchema`, `ModesFileSchema` (TypeBox). A `ModeSpec` includes `provider`, `modelId`, `thinkingLevel` (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`), `tools` (allow/deny list, e.g. `["*", "!subagent"]`), `fallbacks` (ordered candidate models), `systemPrompt` + `systemPromptMode` (`append`/`replace`), `autoExit`, `tmuxTarget` (`pane`/`window`), and a `color`.
- **Presets** — `src/default-modes.ts` defines the built-in modes (`build`, `deep`, `review`, `cheap-review`, `fast-review`, `commiter`, `search`, `docs`, `rush`, `painter`, `ask`, `worker`, `websearch`, `poke`, `openwiki`). Mode system prompts are read from `src/resources/modes/<mode>.md` at module load.
- **Registry** — `src/mode-loading.ts` merges built-in mode sources into a `ModesFile`, validates consistency (`currentMode` must exist in `modes`), and exposes `loadModeRegistry(Sync)`, `resolveModeSpec`, and `registerBuiltInModes`/`unregisterBuiltInModes` for other extensions to contribute modes.
- **Runtime application** — the `modes` extension (`src/extensions/modes/`) reads `~/.pi/agent/modes.json`, applies the active mode's model + tools + system prompt, handles model failover (`failover.ts`, `model-failure.ts`, `model-health-store.ts`), and restores the mode on session resume (`restore.ts`). See [Providers & models](../providers/overview.md) for how providers/fallbacks resolve.

## Settings

- **Defaults** — `src/default-settings.ts` exports `defaultSettings` (typed as `DefaultSettings`), composed from per-extension default settings (e.g. `defaultOpenAIBetterSettings`, `defaultContextPruneSettings`, `defaultDynamicWorkflowSettings`, `defaultAiAutocompleteSettings`, ...). Key top-level defaults: `defaultProvider: "openai-codex"`, `defaultModel: "gpt-5.5"`, `theme: "catppuccin-mocha"`, `hideThinkingBlock: true`, `retry.maxRetries: 1024`.
- **Seed** — `scripts/postinstall.mjs` copies `dist/defaults/{settings,modes}.json` into `~/.pi/agent/` **only if absent** (`SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL=1` skips this). Existing files are never overwritten.
- **Runtime merge** — `ensureRuntimeDefaultSettings()` (`src/runtime-default-settings.ts`) runs on every launch (unless `--help`/`--version`). It takes a `proper-lockfile` lock on `~/.pi/agent/settings.json`, reads the user file through upstream `SettingsManager.inMemory(...).getGlobalSettings()` (so upstream migrations apply), then `mergeMissingDefaults()` recursively fills in any default keys the user file is missing. Writes are atomic (temp file + `rename`). Returns `false` (no throw) on any read/parse failure — a corrupt user file is left alone rather than clobbered.

The net contract: **new default keys reach existing users; user overrides are always preserved.**

## Bundled-resource injection

`src/extensions/bundled-resources.ts` exposes the bundled assets to upstream pi without copying them into upstream's expected locations:

- `installBundledResourcePaths()` patches `DefaultResourceLoader.prototype.reload` so each reload appends bundled `additionalSkillPaths` / `additionalPromptTemplatePaths` / `additionalThemePaths` discovered by scanning `src/resources/{skills,prompts,themes}`.
- The extension's `resources_discover` handler returns the same paths so they merge with project/user resources.

At build time, `scripts/copy-bundled-resources.mjs` copies `src/resources/` → `dist/resources/` so the published package ships them. Details and the full resource tree are in [Resources](../resources/overview.md).

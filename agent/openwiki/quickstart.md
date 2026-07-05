# OpenWiki quickstart

`@shekohex/agent` is a TypeScript wrapper around [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi) (currently `0.80.3`). It keeps the upstream `pi` command, the `.pi` project folder, and the `~/.pi` user config unchanged, then layers on team defaults: a bundled model/provider setup (LiteLLM gateway + several providers), ~47 extensions, themes, system prompts, skills, dynamic workflows, a self-update path, and a couple of alternative ways to drive a session (subagents, remote TCP mode).

The package is published to GitHub Packages and installs a single `pi` binary.

## What this repository does

- Wraps upstream `pi` via a thin `src/cli.ts` entrypoint that calls upstream `main()` with a curated set of bundled extension factories.
- Bundles default `settings.json` / `modes.json`, seeded into `~/.pi/agent/` on install (and re-merged at runtime for missing keys).
- Adds a provider layer on top of upstream pi-ai: a LiteLLM gateway selector, model fallback chains, an OpenAI "fast"/image extension, and live usage tracking.
- Ships a large extension surface grouped into three registries (A/B/C) plus the subagent extension — covering tool rendering, modes, sessions, workflows/goals, external tool execution, and more.
- Includes a self-contained subagent SDK (`src/subagent-sdk/`) for spawning child agent sessions, and a remote TCP mode (`src/remote/`) for driving a session over an SSH port-forward.
- Self-updates from GitHub Packages via `pi update`.
- Carries small upstream UI/retry patches applied through `patch-package` at install time.

## Repository layout

| Path | What lives here |
| --- | --- |
| `src/cli.ts` | Entry point — boot sequence (see [Architecture](./architecture/overview.md)). |
| `src/default-settings.ts`, `src/default-modes.ts` | Bundled defaults seeded into `~/.pi/agent/`. |
| `src/mode-*.ts` | Mode registry schema, loading, and the built-in mode presets. |
| `src/extensions/` | ~47 bundled extensions, registered in three groups + subagent. See [Extensions catalog](./extensions/catalog.md). |
| `src/subagent-sdk/` | In-process machinery for spawning child agent sessions. See [Subagent SDK](./sessions/subagent-sdk.md). |
| `src/remote/` | TCP JSONL remote control mode. See [Remote mode](./sessions/remote.md). |
| `src/update/` | `pi update` self-update from GitHub Packages. See [Build & update](./operations/build-and-update.md). |
| `src/resources/` | Bundled prompts, themes, skills, workflows, and the GSD system. See [Resources](./resources/overview.md). |
| `src/utils/` | Small shared helpers (cwd, xml, clipboard, browser, errors). |
| `scripts/` | Build, postinstall, settings generation, bin prep. |
| `patches/` | `patch-package` patches against upstream pi packages. |
| `support/oxlint-plugin-project-rules/` | Custom oxlint rules enforcing the repo's boundary/type discipline. |
| `vendor/plannotator-ui/` | Vendored React UI built into static HTML at build time. |
| `test/` | Vitest suite. See [Testing](./operations/testing.md). |
| `docs/`, `REMOTE.md`, `plans/` | Additional in-repo reference docs. |

## Boot flow (TL;DR)

`src/cli.ts` runs, in order:

1. `installBundledResourcePaths()` — patches the upstream resource loader so bundled skills/prompts/themes are discovered.
2. `handleWrapperUpdateCommand({ args })` — intercepts `pi update`; exits if handled.
3. `resolveCwd()` — expands `~`/`$VAR` in the launch cwd before upstream reads it.
4. `isRemoteMode(args)` — if `pi --mode remote`, run the TCP server and exit.
5. `ensureRuntimeDefaultSettings()` — merge any missing default keys into `~/.pi/agent/settings.json`.
6. `main(args, { extensionFactories: bundledExtensionFactories })` — hand off to upstream pi with all bundled extensions.

Full detail in [Architecture overview](./architecture/overview.md).

## Run, build, and test

```bash
npm run pi                         # run locally (tsx, skips version check)
npm run pi -- -p "hello"           # one-shot prompt
npm run build                      # build plannotator UI, tsc, copy resources, gen defaults, prep bin
npm test                           # vitest run
npm run typecheck && npm run lint && npm run format:check   # quality gates
```

`pi --mode remote --host 127.0.0.1 --port 0 --token <secret>` exposes the session over TCP — see [Remote mode](./sessions/remote.md) and `REMOTE.md`.

## Documentation map

- [Architecture overview](./architecture/overview.md) — boot sequence, extension system, mode system, settings, bundled-resource injection.
- [Extensions catalog](./extensions/catalog.md) — all bundled extensions grouped by purpose, with key source files.
- [Providers & models](./providers/overview.md) — LiteLLM gateway, provider roster, fallbacks, fast/image, usage tracking, auth.
- [Subagent SDK](./sessions/subagent-sdk.md) — mux backends, lite vs process runtime, IPC, structured output.
- [Remote mode](./sessions/remote.md) — TCP JSONL control protocol.
- [Resources](./resources/overview.md) — system prompts, themes, skills, workflows, GSD, web UIs.
- [Build & update](./operations/build-and-update.md) — build pipeline, postinstall, patches, self-update.
- [Testing](./operations/testing.md) — vitest layout, harness, custom oxlint rules.

## Notes for future agents

- This is a **wrapper**: most behavior comes from upstream `@earendil-works/pi-coding-agent`. When upstream changes, re-verify the patches and the tool-preview/harness tests (see [Upstream patches](./operations/build-and-update.md#upstream-patches)).
- User-visible semantics are split across `src/cli.ts`, `src/extensions/*` (each extension owns its commands/tools/UI), and the resource files under `src/resources/`.
- Settings and modes are seeded, never overwritten — changes to defaults only reach users with missing keys (see [Settings](./architecture/overview.md#settings)).
- When upstream pi is mentioned, assume repo `earendil-works/pi`. Related repos: `durable-streams/durable-streams`, `anomalyco/opencode`, `gsd-build/get-shit-done`.

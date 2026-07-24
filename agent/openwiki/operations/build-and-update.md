# Build & update

How the package is built, how install seeds defaults and applies patches, and how `pi update` self-updates from GitHub Packages.

## Build pipeline (`npm run build`)

`package.json#scripts.build` runs, in order:

1. **`node --import tsx scripts/build-plannotator-ui.mts`** — builds the vendored React apps in `vendor/plannotator-ui/` (`apps/review`, `apps/hook`, and the `packages/*`) with Vite, then copies the resulting `index.html` files to `src/resources/plannotator/plannotator.html` and `review-editor.html`. Skippable via `SHEKOHEX_AGENT_SKIP_PLANNOTATOR_BUILD=true` when cached outputs exist; in CI it installs vendor deps automatically, locally it errors if they're missing.
2. **`tsc -p tsconfig.json`** — compiles `src/` → `dist/`.
3. **`node scripts/copy-bundled-resources.mjs`** — copies `src/resources/` → `dist/resources/` (and `src/extensions/interview/form/` → `dist/extensions/interview/form/`), replacing the target first.
4. **`node scripts/generate-default-settings.mjs`** — imports the compiled `dist/default-settings.js` and writes `dist/defaults/{settings.json,modes.json}` from the `defaultSettings` / `defaultModes` exports.
5. **`node scripts/prepare-bin.mjs`** — writes `bin/pi.js` (Unix shim) and `bin/pi.cmd` (Windows shim) and marks Unix entrypoints executable.

`npm run prepare` runs `build`; `npm run postinstall` / `postprepare` run `scripts/postinstall.mjs`.

Other scripts: `pi` (run via tsx with `PI_SKIP_VERSION_CHECK=1`), `preview:tools[:once|:watch]` (tool-preview harness), `patch:deps` (regenerate patches), `format`/`lint`/`test*` (see [Testing](./testing.md)).

## Postinstall: settings seed + patches

`scripts/postinstall.mjs` runs after install:

1. **Seed defaults** — copies `dist/defaults/settings.json` → `~/.pi/agent/settings.json` and `dist/defaults/modes.json` → `~/.pi/agent/modes.json`, **only if each target is absent**. Existing files are kept. `SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL=1` skips seeding entirely.
2. **Apply dependency patches** — `ensureDependencyPatches()` runs `patch-package` once per package directory, gated by a marker file at `~/.pi/agent/state/dependency-patches/<sha256(packageDir)>.applied`. It only runs when the patched packages are actually present in `node_modules` and the marker is older than the patch files. Patch application forces `commit.gpgSign=false` via git config env.

At runtime, `ensureRuntimeDefaultSettings()` (`src/runtime-default-settings.ts`) additionally **merges missing default keys** into an existing user `settings.json` on every launch (see [Architecture → Settings](../architecture/overview.md#settings)).

## Patches (`patches/`)

Three `patch-package` patches against upstream `@earendil-works` packages:

| Patch                                                                 | Target                                                                | Effect                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@earendil-works+pi-ai+0.82.0.patch`                                  | `pi-ai/dist/utils/retry.js`                                           | Adds retryable error patterns: `request failed`, `failed after retries`, `no response body`, `websocket transport is not available`, `stream closed before response.completed`, `invalid codex sse json`, `invalid codex websocket json`, `error occurred while processing your request`. |
| `@earendil-works+pi-coding-agent++@earendil-works+pi-ai+0.82.0.patch` | the **nested** copy of `pi-ai` inside `pi-coding-agent/node_modules/` | Identical retry-pattern additions (handles npm's non-deduped nested install).                                                                                                                                                                                                             |
| `@earendil-works+pi-coding-agent+0.82.0.patch`                        | `pi-coding-agent/dist/modes/interactive/components/tool-execution.js` | Removes the internal leading spacer from tool execution rendering.                                                                                                                                                                                                                        |

### Upstream patches

When upgrading upstream pi packages:

1. Inspect the freshly installed `node_modules` files and rerun targeted tests (`test:tool-preview`, `test:harness`) before deleting or declaring a patch obsolete.
2. If still needed, regenerate with `npm run patch:deps` or `npx patch-package <pkg>`.
3. Test: `npm run test:tool-preview && npm run test:harness`.
4. Rebuild and reload pi to verify the runtime matches the preview harness.

Never remove or downgrade functionality/dependencies to fix type errors — upgrade instead.

## Self-update

`pi update` is intercepted at the top of `src/cli.ts` by `handleWrapperUpdateCommand()` (`src/update/command.ts`); if handled, the process exits. The flow:

| File                            | Role                                                                                                                                                                                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/update/command.ts`         | Parses `update` args and target (`--self` / `--extensions` / `--all`, default all), orchestrates the run.                                                                                                                                                        |
| `src/update/version.ts`         | `getRuntimeVersion` — reads `package.json`, classifies the channel (`latest` vs `preview`; preview versions match a `dev.<commit>` pattern).                                                                                                                     |
| `src/update/github-packages.ts` | `getLatestPackageRelease` — queries the GitHub Packages npm registry for dist-tag metadata; for the preview channel also hits the GitHub Releases API.                                                                                                           |
| `src/update/auth.ts`            | `resolveAuthToken` — checks `$NODE_AUTH_TOKEN`/`$NPM_TOKEN`/`$GH_TOKEN`/`$GITHUB_TOKEN`, falling back to `gh auth token`. `verifyGitHubPackagesAccess` confirms the token has `read:packages`.                                                                   |
| `src/update/package-manager.ts` | `resolveInstallMethod` — infers npm/pnpm/bun/yarn from install-state or by probing global roots; `withTemporaryNpmrc` writes a temp `.npmrc` with `@shekohex:registry=https://npm.pkg.github.com` + the token; `createUpdateCommand` builds the install command. |
| `src/update/install-state.ts`   | Reads/writes `~/.pi/agent/install.json` (schema version, method, channel, version, commit).                                                                                                                                                                      |

Runtime steps:

1. Parse target. `--extensions` delegates to upstream pi via `spawnSync` with `SHEKOHEX_AGENT_BYPASS_UPDATE=1` (prevents recursive update).
2. Resolve an auth token and verify GitHub Packages access (public packages still require auth).
3. Read install state; resolve the install method (from state, inferred from package dir, or forced via `--npm`/`--pnpm`/`--bun`/`--yarn`).
4. Fetch the latest release for the channel; bail if already current (compares version, then commit hash).
5. Create a temp `.npmrc` and run the package manager's global install for the resolved version.
6. Write the updated install state.

The package is published to GitHub Packages (`publishConfig.registry = https://npm.pkg.github.com`); the `bin` entry is `pi` → `./bin/pi.js`.

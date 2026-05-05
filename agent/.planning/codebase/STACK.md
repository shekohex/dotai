# Technology Stack

**Analysis Date:** 2026-05-05

## Languages

**Primary:**

- TypeScript - main application code in `src/**/*.ts`, test code in `test/**/*.test.ts`, and most runtime modules under `src/extensions/**`.

**Secondary:**

- JavaScript / ESM - CLI shim in `bin/pi.js`, build scripts in `scripts/*.mjs`, and bundled browser helper code in `src/extensions/interview/form/script.js`.
- JSON - package metadata and build/runtime config in `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `.oxlintrc.json`, `.oxfmtrc.json`, and generated defaults in `dist/defaults/*.json`.
- Markdown - bundled prompts and docs in `src/resources/**/*.md` and `docs/*.md`.
- Shell - command wrappers and install-time helpers in `bin/*.cmd` and package scripts.

## Runtime

**Environment:**

- Node.js ESM runtime - version not pinned in repo; code uses modern Node APIs such as `fetch`, `AbortSignal.timeout`, `import.meta.dirname`, and `Array.prototype.toSorted`.

**Package Manager:**

- npm
- Lockfile: present (`package-lock.json`, lockfile v3)

## Frameworks

**Core:**

- `@mariozechner/pi-coding-agent@0.72.1` - runtime host, extension API, session manager, auth storage, and shared UI primitives used across `src/extensions/**`.
- `@mariozechner/pi-ai@0.72.1` - direct runtime import for model streaming, completions, and grounded search in `src/extensions/interview/**`, `src/extensions/websearch/**`, and `src/extensions/session-query/**`.
- `@mariozechner/pi-agent-core@0.72.1` - upstream runtime helpers imported directly by `src/extensions/**` and `scripts/**`.
- `@mariozechner/pi-tui@0.72.1` - terminal UI primitives used in `src/extensions/coreui/**`, `src/extensions/files/**`, `src/extensions/review/**`, `src/extensions/gsd/**`, and `src/extensions/interview/**`.
- `@modelcontextprotocol/sdk@^1.29.0` - Streamable HTTP MCP client in `src/extensions/executor/mcp-client.ts`.
- `typebox@^1.1.24` - runtime schema validation and parsing for tool inputs, persisted state, and external payloads in `src/extensions/**` and `src/subagent-sdk/**`.

**Testing:**

- `vitest@^4.1.5` - test runner for `test/**/*.test.ts`.
- `@vitest/coverage-v8` - coverage collection.
- `@vitest/ui` - interactive test UI.
- `@marcfargas/pi-test-harness@^0.5.0` - harness integration tests and tool-preview coverage in `test/harness.test.ts` and `test/tool-preview.test.ts`.

**Build/Dev:**

- `typescript@^6.0.2` and `tsc` - compile `src` into `dist`.
- `tsx@^4.21.0` - direct TypeScript execution for `pi` and preview scripts.
- `oxlint@^1.59.0` and `@oxlint/plugins` - linting plus custom project rules in `support/oxlint-plugin-project-rules`.
- `oxfmt@^0.44.0` - formatting.
- `patch-package@8.0.1` - postinstall patch application for upstream `@mariozechner/pi-coding-agent`.
- `vite@^8.0.10` - Vitest runtime/tooling.

## Key Dependencies

**Critical:**

- `@mariozechner/pi-coding-agent@0.72.1` - primary runtime and extension API.
- `@modelcontextprotocol/sdk@^1.29.0` - remote tool execution over Streamable HTTP.
- `typebox@^1.1.24` - boundary validation and structured config.
- `@mariozechner/pi-ai@0.72.1` - model I/O and grounded search helper layer.
- `@mariozechner/pi-agent-core@0.72.1` - upstream runtime helpers used by source modules and scripts.
- `@mariozechner/pi-tui@0.72.1` - terminal and preview rendering.

**Infrastructure:**

- `@mendable/firecrawl-js@^4.18.1` - `webfetch` backend in `src/extensions/fetch/`.
- `beautiful-mermaid@^1.1.3` - ASCII Mermaid renderer in `src/extensions/mermaid/renderable.ts`.
- `mermaid@^11.14.0` - browser Mermaid runtime for interview assets in `src/extensions/interview/server-assets.ts` and `src/extensions/interview/server-runtime-support.ts`.
- `diff@^8.0.4` - diff rendering in file, patch, and review flows under `src/extensions/files/**`, `src/extensions/patch/**`, and `src/extensions/review/**`.
- `patch-package@8.0.1` - dependency patching from `patches/`.

## Configuration

**Environment:**

- `package.json` sets `piConfig.configDir` to `.pi`; `src/extensions/interview/settings.ts` and `src/extensions/prompt-stash/storage.ts` also respect `PI_CODING_AGENT_DIR` when present.
- `scripts/postinstall.mjs` seeds `~/.pi/agent/settings.json` and `~/.pi/agent/modes.json` from generated defaults in `dist/defaults/`.
- `scripts/generate-default-settings.mjs` materializes defaults from `src/default-settings.ts`.
- `scripts/copy-bundled-resources.mjs` copies `src/resources/` and `src/extensions/interview/form/` into `dist/`.
- `PI_SKIP_VERSION_CHECK=1` is set by `npm run pi`.
- `SHEKOHEX_AGENT_SKIP_SETTINGS_INSTALL=1` disables settings seeding in `scripts/postinstall.mjs`.
- `publishConfig.registry` targets `https://npm.pkg.github.com`.

**Build:**

- `tsconfig.json` sets `NodeNext` module resolution, strict type-checking, `ESNext` output, and `jsxImportSource: "hono/jsx"`.
- `vitest.config.ts` configures tests in `test/` with V8 coverage.
- `.oxlintrc.json` and `.oxfmtrc.json` define lint and format rules plus ignore patterns.
- `scripts/prepare-bin.mjs` writes `bin/pi.js` and `bin/pi.cmd` wrappers.

## Platform Requirements

**Development:**

- Modern Node.js with ESM, built-in `fetch`, `AbortSignal.timeout`, and `toSorted`.
- npm install triggers build and postinstall hooks that generate defaults and apply patches.
- Network access is required for live model routing, web fetch, usage queries, and grounded search.
- `tmux` is required for subagent pane management when the tmux-backed mux adapter is active.

**Production:**

- CLI entrypoints are `bin/pi.js` and `bin/pi.cmd`.
- Runtime artifacts live in `dist/` plus copied resources from `src/resources/`.
- User state is stored under `~/.pi/agent/` or the path set by `PI_CODING_AGENT_DIR`.

---

_Stack analysis: 2026-05-05_

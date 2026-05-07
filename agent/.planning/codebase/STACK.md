# Technology Stack

**Analysis Date:** 2026-05-07

## Languages

**Primary:**

- TypeScript (`ESNext` / `NodeNext`) - all runtime code in `src/**/*.ts`, CLI entry in `src/cli.ts`, extension code under `src/extensions/**`, SDK code under `src/subagent-sdk/**`.

**Secondary:**

- JSON - package/config/state files such as `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.config.ts`, `src/resources/**/*.json`, and generated defaults in `dist/defaults/*.json`.
- Markdown - prompts, docs, and bundled resources in `src/resources/**` and `src/extensions/executor/docker/README.md`.
- Bash - install/distribution helper in `scripts/install-github-package.sh`.
- JavaScript - browser assets in `src/extensions/interview/form/script.js` and bundled compatibility scripts in `src/resources/gsd/bin/lib/*.cjs`.

## Runtime

**Environment:**

- Node.js ESM runtime.
- TypeScript compiler target: `ESNext`.
- Module format: `NodeNext` with `verbatimModuleSyntax` enabled in `tsconfig.json`.
- CLI launches through `tsx` during development via `package.json` script `pi` and runs compiled output through `bin/pi.js`.
- No Node engine version is pinned in the repository.

**Package Manager:**

- npm.
- Lockfile: present (`package-lock.json`).
- `packageManager` field: not present.

## Frameworks

**Core:**

- `@mariozechner/pi-coding-agent` `0.72.1` - host runtime, extension API, session lifecycle, tool registry, TUI primitives, and bundled resource loader used by `src/cli.ts`, `src/extensions/**`, and `src/subagent-sdk/**`.
- `@mariozechner/pi-ai` `0.72.1` - model/provider abstraction and streaming used by `src/extensions/websearch/**` and `src/extensions/litellm.ts`.
- `@mariozechner/pi-tui` `0.72.1` - terminal UI widgets used by renderers such as `src/extensions/websearch/render.ts` and `src/extensions/session-breakdown/ui.ts`.

**Testing:**

- Vitest `4.1.5` - unit and scenario tests under `test/`.
- `@vitest/coverage-v8` `4.1.5` - coverage reporting.
- `@vitest/ui` `4.1.5` - interactive test UI.

**Build/Dev:**

- TypeScript `6.0.2` - compile and typecheck.
- `tsx` `4.21.0` - dev runner for CLI and preview scripts.
- Vite `8.0.10` - Vitest runtime dependency.
- `oxlint` `1.59.0` - linting.
- `oxfmt` `0.44.0` - formatting.
- `patch-package` `8.0.1` - applies repo patches under `patches/`.

## Key Dependencies

**Critical:**

- `@mariozechner/pi-coding-agent` `0.72.1` - primary runtime and extension host.
- `@mariozechner/pi-ai` `0.72.1` - provider registry, model lookup, and streaming.
- `typebox` `1.1.24` - runtime schemas and validation for tool inputs, persisted state, and external payloads.
- `@modelcontextprotocol/sdk` `1.29.0` - MCP client for executor bridging in `src/extensions/executor/mcp-client.ts`.
- `@mendable/firecrawl-js` `4.18.1` - Firecrawl client for `webfetch` in `src/extensions/fetch/execution.ts`.

**Infrastructure:**

- `mermaid` `11.14.0` - mermaid parsing/rendering support.
- `beautiful-mermaid` `1.1.3` - ASCII/terminal mermaid rendering in `src/extensions/mermaid/renderable.ts`.
- `diff` `8.0.4` - patch/diff generation in `src/extensions/patch/**` and tests.
- `@oxlint/plugins` `1.61.0` - lint plugins.
- `@types/json-schema` `7.0.15` - schema typing for interop.

## Configuration

**Environment:**

- Runtime settings are seeded into `~/.pi/agent/settings.json` and `~/.pi/agent/modes.json` by `scripts/postinstall.mjs`.
- Package metadata sets `piConfig.name = "pi"` and `piConfig.configDir = ".pi"` in `package.json`.
- Bundled resources are discovered from `src/resources/**` and copied into `dist/resources` by `scripts/copy-bundled-resources.mjs`.
- `src/extensions/bundled-resources.ts` patches `DefaultResourceLoader` so bundled skills, prompt templates, and themes are discoverable at runtime.
- No repo-level `.env` or `.env.*` files are present.

**Build:**

- `tsconfig.json` - `strict`, `noImplicitAny`, `noFallthroughCasesInSwitch`, `forceConsistentCasingInFileNames`, `skipLibCheck`, `jsxImportSource: "hono/jsx"`.
- `vitest.config.ts` - test directory, coverage, and worker settings.
- `scripts/generate-default-settings.mjs` - writes `dist/defaults/settings.json` and `dist/defaults/modes.json` from `src/default-settings.ts` and `src/default-modes.ts`.
- `scripts/prepare-bin.mjs` - writes `bin/pi.js` and `bin/pi.cmd` wrappers.
- `patches/@mariozechner+pi-coding-agent+0.72.1.patch` - active dependency patch.

## Platform Requirements

**Development:**

- Node.js with npm.
- `git` for review, commit, and repository-aware flows.
- `gh` for GitHub PR workflows in `src/extensions/review/**`.
- `tmux` for tmux-backed subagent/session workflows in `src/subagent-sdk/tmux.ts` and related extensions.

**Production:**

- Local CLI distribution only.
- Entry binary: `bin/pi.js` -> `dist/cli.js`.
- No hosted backend or separate deployment target detected.

---

_Stack analysis: 2026-05-07_

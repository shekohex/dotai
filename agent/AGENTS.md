# @shekohex/agent

TypeScript wrapper around `@earendil-works/pi-coding-agent` with bundled defaults, extensions, resources, and providers.

## Working Style

- Make progress with reasonable assumptions; ask only when missing info changes outcome or risk.
- For tool-heavy work, start with brief action update.
- Use minimum evidence needed; search deeper only when key facts are missing.
- Stop once request is complete. No extra polish loops.
- Preserve requested artifact shape/length/genre when editing.
- Never invent names, metrics, roadmap status, customer outcomes, or capabilities.
- Speech-to-text may make user wording weird; infer carefully.
- Do not give time estimates.

## Code Rules

- Lint enforces import, TypeScript, TypeBox, Reflect, JSON.parse, unsafe-boundary, and complexity rules. Do not fight lint; fix code shape.
- Use TypeBox schemas for data crossing boundaries: persisted JSON/JSONL, tool inputs/outputs, env structured config, and external responses whose shape matters.
- Prefer TypeScript narrowing and typed contracts over defensive runtime checks in internal code.
- Check `node_modules` for external API types before guessing.
- Split reusable code into modules; avoid abstractions for single-use code.
- Ask before removing intentional functionality.
- Never remove or downgrade functionality/dependencies to fix type errors; upgrade dependencies instead.
- Do not preserve backward compatibility unless explicitly asked.

## Bug Workflow

- Start with failing unit test that reproduces bug.
- Fix bug.
- Prove with passing tests.
- For workflow bugs, add end-to-end regression test.

## Upstream Patches

When upgrading upstream pi packages:

1. Inspect fresh installed `node_modules` files and rerun targeted tests before deleting or declaring patch obsolete.
2. If patch still needed, regenerate with `npm run patch:deps` or `npx patch-package <pkg>`.
3. Test: `npm run test:tool-preview && npm run test:harness`.
4. Rebuild: `npm run build`.

## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

## External Repos

When user mentions upstream pi, assume `earendil-works/pi`; use librarian skill. Related repos:

- `earendil-works/pi`: pi coding agent and packages
- `durable-streams/durable-streams`: durable-streams
- `anomalyco/opencode`: opencode
- `gsd-build/get-shit-done`: upstream GSD

## Task Completion

Run before final reply:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
```

Fix failures and rerun.

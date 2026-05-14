# Local Plannotator UI Changes

This vendor copy contains local changes that were previously captured in `patches/plannotator-ui-v0.19.12-local.patch` and `patches/plannotator-ui-v0.19.14-local.patch`.

Current upstream vendor base: `v0.19.16`.

Those patch files have been removed. Future upgrades should diff this vendor tree against upstream and explicitly review the items below.

## Why this exists

We vendor `plannotator-ui` directly in this repo. The old patch-package artifacts were only acting as historical diff dumps for local behavior changes. This document replaces them with upgrade guidance.

## Local changes to carry forward

### 1. Vendored package wiring instead of workspaces

Files:
- `package.json`
- `apps/hook/package.json`
- `apps/review/package.json`
- `packages/editor/package.json`
- `packages/review-editor/package.json`
- `packages/ui/package.json`

What changed:
- Removed workspace assumptions from upstream package setup.
- Repointed internal package dependencies from `workspace:*` to local `file:` paths.
- Added direct app dependencies needed when building inside this repo instead of upstream monorepo.
- Added direct package dependencies needed when isolated vendored apps import transitive upstream packages directly.

Why it matters on upgrade:
- Upstream may keep monorepo-only dependency declarations.
- Our vendored copy must remain buildable in isolation inside `vendor/plannotator-ui/`.
- Example: `packages/review-editor/package.json` carries `sonner` because upstream review-editor imports it while the upstream workspace can otherwise resolve it transitively.

### 2. Vite/react dedupe and local aliasing for vendored builds

Files:
- `apps/hook/vite.config.ts`
- `apps/review/vite.config.ts`

What changed:
- Added `esbuild.jsx = 'automatic'` and `jsxImportSource = 'react'`.
- Added `dedupe: ['react', 'react-dom']`.
- Aliased `react` and `react-dom` to app-local `node_modules`.

Why it matters on upgrade:
- Prevents duplicate React copies and hook/runtime mismatches in vendored app builds.

### 3. Removed remote font loading from shipped HTML

Files:
- `apps/hook/index.html`
- `apps/review/index.html`

What changed:
- Removed Google Fonts `<link>` tags.

Why it matters on upgrade:
- Keeps UI self-contained.
- Avoids external network dependency for local/browser sessions.

### 4. Review editor support for editor annotations across all review surfaces

Files:
- `packages/review-editor/App.tsx`
- `packages/review-editor/components/AllFilesDiffView.tsx`
- `packages/review-editor/components/DiffViewer.tsx`
- `packages/review-editor/components/ReviewSidebar.tsx`
- `packages/review-editor/dock/ReviewStateContext.tsx`
- `packages/review-editor/dock/panels/ReviewAgentJobDetailPanel.tsx`
- `packages/review-editor/dock/panels/ReviewAllFilesDiffPanel.tsx`
- `packages/review-editor/dock/panels/ReviewDiffPanel.tsx`
- `packages/shared/types.ts`

What changed:
- Threaded editor annotations through review app state and dock panels.
- Enabled selecting editor annotations from sidebar/diff surfaces.
- Included editor annotations in submission/export flows.

Why it matters on upgrade:
- Upstream review UI may not preserve these integration points.
- Review behavior regression likely if these paths disappear.

### 5. Editor annotation card rendering tweaks

File:
- `packages/ui/components/EditorAnnotationCard.tsx`

What changed:
- Adjusted layout/styling.
- Added optional `reasoning` rendering.

Why it matters on upgrade:
- UI for agent-produced/editor-imported annotations may lose metadata or formatting.

### 6. Editor annotations transport changed from polling-only to SSE-first

Files:
- `packages/ui/hooks/useEditorAnnotations.ts`
- `packages/server/editor-annotations.ts`
- `packages/server/editor-annotations.test.ts`
- `packages/editor/App.tsx`
- `packages/review-editor/App.tsx`

What changed:
- Client hook now prefers `EventSource('/api/editor-annotations/stream')`.
- Server now serves `/api/editor-annotations/stream` and broadcasts `snapshot`/`add`/`remove` events.
- Hook still falls back to snapshot polling if SSE fails before first snapshot.
- Hook now supports `enabled` gating.
- Plan editor disables editor-annotation transport for `annotate-last` message mode and archive mode.
- Review editor only enables hook when connected to API-backed review session.
- Added stream test coverage.

Why it matters on upgrade:
- Upstream client/server must stay in sync.
- If upstream reintroduces polling-only server behavior while retaining SSE client behavior, `/api/editor-annotations` can be hammered in a 500ms loop.
- `annotate-last` should not subscribe to editor annotations at all.

### 7. Update check disabled locally

File:
- `packages/ui/hooks/useUpdateCheck.ts`

What changed:
- Early return added before GitHub release fetch.

Why it matters on upgrade:
- Prevents outbound update-check traffic in this environment.

### 8. Version/plugin metadata drift in vendored app assets

Files:
- `apps/hook/.claude-plugin/plugin.json`
- `package.json`

What changed:
- Local vendored metadata/version values differ from upstream package snapshots used to generate old patch files.

Why it matters on upgrade:
- Reconcile intentionally. Do not blindly overwrite without checking build/runtime assumptions.

### 9. Local lockfile artifacts existed in patch history

File:
- `packages/editor/package-lock.json`

What changed:
- Old patch artifacts included lockfile state for vendored package builds.

Why it matters on upgrade:
- Treat lockfiles as derived state, not source of truth. Re-evaluate whether they are still needed.

## Upgrade checklist

When upgrading `vendor/plannotator-ui`:

1. Diff upstream against this vendor tree.
2. Re-check isolated build wiring for all app/package `package.json` files.
3. Re-check Vite alias/dedupe settings.
4. Re-check review-editor support for editor annotations.
5. Re-check `packages/ui/hooks/useEditorAnnotations.ts` and `packages/server/editor-annotations.ts` together.
6. Verify `annotate-last` does not open editor-annotation transport.
7. Verify update-check behavior remains intentionally disabled or re-decide it explicitly.
8. Run repo validation after merge.

## Validation paths most likely to catch regressions

- Open `/plannotator last` and confirm no repeated `GET /api/editor-annotations` loop.
- Open plan/file annotation session and confirm editor annotations appear live.
- Open review session and confirm editor annotations can be selected from sidebar and diff panels.
- Run `npm run typecheck`
- Run `npm test`
- Run `npm run lint`

# Plannotator `v0.19.12` Vendor Upgrade Assessment

## Outcome

- Patch extraction from `vendor/plannotator-ui/` is feasible.
- Fresh upstream copy from `backnotprop/plannotator` `v0.19.12` plus local patch reapply is practical.
- Dry-run patch apply against `v0.19.12` showed only 2 conflicts.
- One conflict is already upstream-equivalent and should be dropped from local patch.
- One conflict is trivial manual merge in `packages/editor/package.json`.
- Actual vendor refresh to `v0.19.12` was completed.
- Local vendor deltas were carried forward successfully.
- Additional explicit vendored dependency sync was needed for new upstream `sonner` usage in `packages/editor`.

## Scope Compared

- Local vendored tree: `vendor/plannotator-ui/`
- Upstream source tags:
  - base: `v0.19.11`
  - target: `v0.19.12`
- Excluded compare noise:
  - `**/node_modules/`
  - `apps/review/dist/`
  - `apps/hook/dist/`

## Source Tracking Policy

`.gitignore` was narrowed from broad vendored-tree ignore to source tracking with only churn ignored:

```gitignore
vendor/plannotator-ui/**/node_modules/
vendor/plannotator-ui/apps/review/dist/
vendor/plannotator-ui/apps/hook/dist/
```

## Generated Local Patch Set

Local vendor patch against upstream `v0.19.11` contains 22 files:

1. `apps/hook/index.html`
2. `apps/hook/package.json`
3. `apps/hook/vite.config.ts`
4. `apps/review/index.html`
5. `apps/review/package.json`
6. `apps/review/vite.config.ts`
7. `package.json`
8. `packages/editor/package.json`
9. `packages/review-editor/App.tsx`
10. `packages/review-editor/components/AllFilesDiffView.tsx`
11. `packages/review-editor/components/DiffViewer.tsx`
12. `packages/review-editor/components/ReviewSidebar.tsx`
13. `packages/review-editor/dock/ReviewStateContext.tsx`
14. `packages/review-editor/dock/panels/ReviewAgentJobDetailPanel.tsx`
15. `packages/review-editor/dock/panels/ReviewAllFilesDiffPanel.tsx`
16. `packages/review-editor/dock/panels/ReviewDiffPanel.tsx`
17. `packages/review-editor/package.json`
18. `packages/server/jj.test.ts`
19. `packages/shared/types.ts`
20. `packages/ui/components/EditorAnnotationCard.tsx`
21. `packages/ui/hooks/useEditorAnnotations.ts`
22. `packages/ui/package.json`

## Patch Apply Result Against `v0.19.12`

Clean apply:

1. `apps/hook/index.html`
2. `apps/hook/package.json`
3. `apps/hook/vite.config.ts`
4. `apps/review/index.html`
5. `apps/review/package.json`
6. `apps/review/vite.config.ts`
7. `package.json`
8. `packages/review-editor/App.tsx`
9. `packages/review-editor/components/AllFilesDiffView.tsx`
10. `packages/review-editor/components/DiffViewer.tsx`
11. `packages/review-editor/components/ReviewSidebar.tsx`
12. `packages/review-editor/dock/ReviewStateContext.tsx`
13. `packages/review-editor/dock/panels/ReviewAgentJobDetailPanel.tsx`
14. `packages/review-editor/dock/panels/ReviewAllFilesDiffPanel.tsx`
15. `packages/review-editor/dock/panels/ReviewDiffPanel.tsx`
16. `packages/review-editor/package.json`
17. `packages/shared/types.ts`
18. `packages/ui/components/EditorAnnotationCard.tsx`
19. `packages/ui/hooks/useEditorAnnotations.ts`
20. `packages/ui/package.json`

Conflicts:

1. `packages/server/jj.test.ts`
2. `packages/editor/package.json`

Conflict assessment:

1. `packages/server/jj.test.ts`
   - Upstream `v0.19.12` already contains the same behavioral change.
   - Action: drop this hunk from local patch queue.

2. `packages/editor/package.json`
   - Local change: replace `workspace:*` with `file:` links for npm vendoring.
   - Upstream `v0.19.12` change: add `"sonner": "^2.0.7"`.
   - Action: keep upstream `sonner` addition and reapply local `file:` dependency links.

## Change Buckets

### Build and Package Manager Adaptation

1. `apps/hook/package.json`
2. `apps/hook/vite.config.ts`
3. `apps/review/package.json`
4. `apps/review/vite.config.ts`
5. `package.json`
6. `packages/editor/package.json`
7. `packages/review-editor/package.json`
8. `packages/ui/package.json`

Notes:

- converts Bun/workspace assumptions to npm-compatible local `file:` links
- keeps React bundling stable in vendored Vite apps
- preserves source-build path used by repo build

### Pi Runtime and Browser Integration

1. `apps/hook/index.html`
2. `apps/review/index.html`

Notes:

- removes Google Fonts dependency from vendored HTML source
- keeps browser assets self-contained and build-safe in Pi runtime

### UI and Review Behavior Fixes

1. `packages/review-editor/App.tsx`
2. `packages/review-editor/components/AllFilesDiffView.tsx`
3. `packages/review-editor/components/DiffViewer.tsx`
4. `packages/review-editor/components/ReviewSidebar.tsx`
5. `packages/review-editor/dock/ReviewStateContext.tsx`
6. `packages/review-editor/dock/panels/ReviewAgentJobDetailPanel.tsx`
7. `packages/review-editor/dock/panels/ReviewAllFilesDiffPanel.tsx`
8. `packages/review-editor/dock/panels/ReviewDiffPanel.tsx`
9. `packages/shared/types.ts`
10. `packages/ui/components/EditorAnnotationCard.tsx`
11. `packages/ui/hooks/useEditorAnnotations.ts`

Notes:

- SSE-first editor annotation updates
- AI review findings rendered inline in diff/editor lane
- editor annotations merged into normal review comment presentation
- AI detail panel reads editor annotation state instead of separate external store

## Upstream `v0.19.12` Additions Not Present in Current Vendor

These appeared in upstream compare and are not blockers to patch-carry viability:

1. `packages/shared/pfm-reminder.ts`
2. `packages/shared/pfm-reminder.test.ts`
3. `packages/ui/components/html-viewer/HtmlViewer.tsx`
4. `packages/ui/components/html-viewer/bridge-script.ts`
5. `packages/ui/components/html-viewer/index.ts`
6. `packages/ui/components/html-viewer/useHtmlAnnotation.ts`
7. `packages/ui/components/settings/HooksTab.tsx`
8. `packages/ui/hooks/pfm/useCodeFilePopout.ts`

## Recommendation

Recommended future vendor upgrade workflow:

1. Copy fresh upstream tag into `vendor/plannotator-ui/`.
2. Reapply local patch queue against vendored source only.
3. Drop patch hunks that upstream already absorbed.
4. Manually merge small manifest conflicts like `packages/editor/package.json`.
5. Rebuild vendored UI.
6. Run repo validation.

This is low-risk and maintainable because:

- patch surface is bounded
- most patch hunks apply cleanly across upstream tags
- remaining conflicts are understandable and mechanical
- no hidden dependence on vendored `node_modules` or built `dist` output was required for compare or patch analysis

## Minimum Ignore Recommendations

To keep vendored source tracked in git while making patching and upgrades practical:

### Git Ignore

Keep only install and build churn ignored:

1. `vendor/plannotator-ui/**/node_modules/`
2. `vendor/plannotator-ui/apps/review/dist/`
3. `vendor/plannotator-ui/apps/hook/dist/`

### Formatting Ignore

Ignore the vendored UI source tree from formatter churn:

1. `vendor/plannotator-ui/`

Rationale:

- avoids large upstream formatting rewrites during vendor refreshes
- keeps first-party source formatting fully covered
- current repo already uses this pattern successfully

### Lint Ignore

Ignore the vendored UI source tree from first-party lint policy:

1. `vendor/plannotator-ui/**`

Rationale:

- upstream vendored source carries large lint debt relative to this repo's stricter rules
- keeps first-party source, tests, generated policy, and repo-specific code under lint
- avoids forcing invasive rewrites of third-party vendored code during routine upstream refreshes

This is the minimum practical lint ignore. Narrower ignore patterns are not enough because the current lint failures are spread broadly across vendored upstream UI files and are not limited to build artifacts or installs.

## Actual Refresh Notes

Actual update procedure that succeeded:

1. Refresh vendored source from upstream `v0.19.12` into `vendor/plannotator-ui/`.
2. Reapply the validated local delta set.
3. Drop local `packages/server/jj.test.ts` carry because upstream already absorbed it.
4. Merge `packages/editor/package.json` by keeping:
   - local `file:` links for vendoring
   - upstream `"sonner": "^2.0.7"`
5. Run explicit sync step:
   - `cd vendor/plannotator-ui/packages/editor && npm install`
6. Rebuild repo.

## Validation Evidence

Command results during assessment:

1. `npm run typecheck` passed
2. `npm test` passed with `695 passed`
3. `npm run format:check` passed
4. `npm run build` passed after vendored `packages/editor` dependency sync for `sonner`
5. `npm run lint` failed after unignoring vendored source because full vendor tree now enters repo lint scope and contains large pre-existing upstream lint debt

That lint failure does not invalidate the patchability assessment. It does mean source tracking and repo-green lint cannot both hold unless vendored source is either cleaned up or intentionally scoped out of lint.

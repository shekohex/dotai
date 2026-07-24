---
name: upgrading-to-upstream-pi
description: Upgrade this agent wrapper to a newly released upstream earendil-works/pi version, including package versions, lockfile, release manifest, patch-package patches, verification, commit, and push. Use when user asks to upgrade Pi, update to a new Pi release/tag/version, regenerate Pi patches, or handle repeated upstream Pi release bumps.
---

# Upgrading To Upstream Pi

## Quick Start

Use this workflow from `/home/coder/dotai/agent` when upgrading `@earendil-works/*` Pi packages.

1. Confirm clean state and latest upstream:
   `git -C /home/coder/dotai status --short`
   `bash /home/coder/.pi/agent/skills/librarian/scripts/checkout.sh earendil-works/pi --force-update --path-only`
   `gh release view --repo earendil-works/pi --json tagName,publishedAt --jq '.'`
   `npm view @earendil-works/pi-coding-agent version`

2. Read changelog for target version with `gh api`, not guess from memory.

3. Install exact target versions:
   `npm install @earendil-works/pi-agent-core@VERSION @earendil-works/pi-ai@VERSION @earendil-works/pi-coding-agent@VERSION @earendil-works/pi-tui@VERSION`

4. Pin patched package exactly in `package.json`:
   `@earendil-works/pi-coding-agent`: `VERSION`

5. Bump wrapper metadata:
   `package.json` `version`
   `../.github/.release-please-manifest.json` `agent`

## Patch Workflow

Our recurring coding-agent patch removes the internal spacer from upstream `ToolExecutionComponent`:

```diff
-        this.addChild(new Spacer(1));
```

Our recurring `pi-ai` patches add transient Codex/OpenAI retry patterns to both the root and nested copies of `pi-ai`.

Check if the spacer is still needed:

`grep -n "this.addChild(new Spacer(1))" node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js | head`

Check if retry patches are still needed:

`npm test -- --run test/modes-failover.test.ts -t "upstream agent auto-retry patch"`

If the spacer or retry assertions still fail:

1. Apply required changes to installed package files using `apply_patch`.
2. Delete old-version patch files using `apply_patch`.
3. Run `npm run patch:deps -- @earendil-works/pi-coding-agent` for the spacer patch.
4. Run `npm run patch:deps -- @earendil-works/pi-ai` for the root retry patch.
5. Run `npm run patch:deps -- @earendil-works/pi-coding-agent/@earendil-works/pi-ai` for the nested retry patch.
6. Confirm all generated patches are minimal and named for the target version.
7. Reverse patches, invalidate the postinstall marker by updating patch mtimes, run `npm install`, and verify all patches reapply.

## Verification

Run these before final response or commit:

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm audit --audit-level=moderate
```

If `npm audit` reports stale hoisted transitives but nested Pi shrinkwrap has fixed versions, inspect with `npm explain <package>`. Prefer `npm update <package>` only when it updates lockfile within declared semver ranges and tests pass.

If generated Plannotator HTML changes only because formatting touched it, restore those files unless directly relevant:

`git -C /home/coder/dotai restore -- agent/src/resources/plannotator/plannotator.html agent/src/resources/plannotator/review-editor.html`

## Commit And Push

When user asks to commit/push, read `git-commiting` skill first.

Stage only upgrade files:

```bash
git -C /home/coder/dotai add \
  .github/.release-please-manifest.json \
  agent/package.json \
  agent/package-lock.json \
  agent/patches/@earendil-works+pi-coding-agent+OLD.patch \
  agent/patches/@earendil-works+pi-coding-agent+VERSION.patch
```

Commit message:

`chore(agent): upgrade pi to VERSION`

Push:

`git -C /home/coder/dotai push origin main`

Final response should include commit hash, pushed branch, clean worktree, and verification summary.

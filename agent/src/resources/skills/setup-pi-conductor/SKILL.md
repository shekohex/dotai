---
name: setup-pi-conductor
description: Set up, repair, or explain Pi Conductor configuration, project dispatch, and workflow hooks. Use for Conductor-specific requests.
---

# Setup Pi Conductor

Set up current repository so `pi conductor` can turn GitHub Project issues into isolated Pi worktree sessions. Preserve existing config; do not overwrite local preferences or repo workflow policy without inspecting them first.

## Artifacts

- Global user config: `~/.pi/agent/conductor/config.json`, plus `config.schema.json`.
- Repo workflow policy: `<repo>/.pi/WORKFLOW.md`, committed when repo-owned policy changes are desired.
- Private local hooks: `<repo>/.git/config` keys named `pi.conductor.hook.<phase>`, never committed.

## Process

1. Scope the repo. Find git root, current remote, default branch, package/test commands, README/CONTRIBUTING guidance, and any existing `.pi/WORKFLOW.md`. If this is a monorepo and target repo/app is ambiguous, ask which checkout/unit should be managed.
2. Discover GitHub context. Run `gh auth status`, `gh repo view --json owner,name,defaultBranchRef`, and inspect available Projects v2 with `gh project list --owner <owner>` or `gh project view <number> --owner <owner>` when project info is missing.
3. Gather preferences only where defaults are not obvious. Use the available question tool or a concise question for unresolved choices that change files: dispatch label, project owner/number, field names/options, launch modes, Follow-Up Rules, Conductor Comments, shared/private hooks, webhook vs polling, and whether to run a live dispatch.
4. Initialize safely. Run `pi conductor config init` from the target repo. It is idempotent: it migrates config, upserts current repo, writes schema, and creates `.pi/WORKFLOW.md` only if missing.
5. Configure global repo entry. Prefer `pi conductor config set/get/format` for simple changes; use careful JSON edits only when path automation is awkward. Fill project owner/number, repo path, dispatch label, field aliases, and status option labels.
6. Configure `.pi/WORKFLOW.md`. Keep repo-owned policy here: prompt body, launch rules, Follow-Up Rules, Conductor Comment Templates, branch template, field aliases/options, and shared hooks. Merge into existing content; keep useful comments; never replace a hand-written prompt with generic prose.
7. Configure private hooks only in git config. Use `git config --local --add pi.conductor.hook.postCreate "..."` for ignored/local setup such as copying `.env`, installing private credentials, or machine-specific caches.
8. Validate. Run `pi conductor config validate`. Fix every reported issue. Run `pi conductor config format` after config edits. Do not run `pi conductor reconcile`, `serve`, or `run` unless user asked to start automation or approved a live dispatch.
9. Report exact results: config path, workflow path, repo/project mapping, dispatch label, status mapping, hooks added, validation commands, and any remaining manual GitHub/webhook steps.

## Configuration details

Read [references/CONFIGURATION.md](references/CONFIGURATION.md) for the branch being configured: preference choices, workflow YAML, feedback rules, comment templates, hooks, or webhooks. Setup-only work does not require configuring every optional branch.

## Verification

Minimum verification:

```bash
pi conductor config validate
```

When editing this agent repo or adding this skill, also run repository gates. For normal target repos, run the repo's own format/typecheck/test commands only if you changed repo files beyond `.pi/WORKFLOW.md` or the user asks for full validation.

Live dispatch can create worktrees, move project cards, and launch agents. Run it when the user already requested or approved those actions; otherwise obtain approval for the specific dispatch after local validation:

```bash
pi conductor run owner/repo#123 --mode-build
pi conductor status --json
```

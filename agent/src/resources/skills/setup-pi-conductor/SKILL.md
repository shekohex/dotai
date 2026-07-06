---
name: setup-pi-conductor
description: Set up Pi Conductor for repositories by configuring global conductor config, repo .pi/WORKFLOW.md, GitHub Projects v2 mapping, workflow prompts, launch rules, and worktree hooks. Use when user asks to set up, bootstrap, initialize, configure, repair, or explain Pi Conductor, conductor workflow files, ready-for-agent automation, project dispatch, or worktree hook setup for a repo.
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
3. Gather preferences only where defaults are not obvious. Use one grouped `ask_user_question` call for choices that change files: dispatch label, project owner/number, field names/options, launch modes, shared/private hooks, webhook vs polling, and whether to run a live dispatch.
4. Initialize safely. Run `pi conductor config init` from the target repo. It is idempotent: it migrates config, upserts current repo, writes schema, and creates `.pi/WORKFLOW.md` only if missing.
5. Configure global repo entry. Prefer `pi conductor config set/get/format` for simple changes; use careful JSON edits only when path automation is awkward. Fill project owner/number, repo path, dispatch label, field aliases, and status option labels.
6. Configure `.pi/WORKFLOW.md`. Keep repo-owned policy here: prompt body, launch rules, branch template, field aliases/options, and shared hooks. Merge into existing content; keep useful comments; never replace a hand-written prompt with generic prose.
7. Configure private hooks only in git config. Use `git config --local --add pi.conductor.hook.postCreate "..."` for ignored/local setup such as copying `.env`, installing private credentials, or machine-specific caches.
8. Validate. Run `pi conductor config validate`. Fix every reported issue. Run `pi conductor config format` after config edits. Do not run `pi conductor reconcile`, `serve`, or `run` unless user asked to start automation or approved a live dispatch.
9. Report exact results: config path, workflow path, repo/project mapping, dispatch label, status mapping, hooks added, validation commands, and any remaining manual GitHub/webhook steps.

## Preference Questions

Ask only when inspection cannot determine the answer. Useful choices:

- Dispatch policy: default `ready-for-agent` label + authenticated assignee, custom label, or manual-only for now.
- Project mapping: inferred project, user-provided project owner/number, or pause until project exists.
- Status mapping: default `Todo/In Progress/Review/Done/Blocked`, custom board options, or no project automation yet.
- Launch rules: default build/deep/painter label rules, custom label-to-mode rules, or no automatic mode selection.
- Worktree prep: repo-shared hooks in `.pi/WORKFLOW.md`, private hooks in `.git/config`, both, or no hooks.
- Operation mode: polling via `serve`, webhook + polling, daemon, or setup-only.

## Workflow Checklist

Frontmatter can include:

```yaml
dispatchLabel: ready-for-agent
branchTemplate: "pi/${{ github.issue.number }}-${{ github.issue.slug }}"
statusField: Status
effortField: Effort
priorityField: Priority
statusOptions:
  ready: "Todo"
  in_progress: "In Progress"
  in_review: "Review"
  done: "Done"
  blocked: "Blocked"
launchRules:
  - if: "${{ contains(github.issue.labels, 'deep') || github.project.effort == 'XL' }}"
    flags: ["--mode-deep"]
worktreeHooks:
  postCreate:
    - npm install
```

Prompt body should be repo-specific. Include what agent must inspect, branch/PR expectations, test commands, coding rules, review/merge policy, and any project-specific done criteria. Use `${{ github.issue.title }}`, `${{ github.project.priority }}`, `${{ conductor.worktreePath }}`, and other supported expression contexts when useful.

## Worktree Hooks

Lifecycle phases:

- `postCreate`: runs after new worktree creation, cwd is worktree, failure blocks launch.
- `preRemove`: runs before cleanup, cwd is worktree, failure blocks removal.
- `postRemove`: runs after removal, cwd is repo root, best effort.

Hook environment: `REPO_ROOT`, `WORKTREE_PATH`, `BRANCH`, `PI_CONDUCTOR_OWNER`, `PI_CONDUCTOR_REPO`, `PI_CONDUCTOR_ISSUE_NUMBER`. Shared workflow hooks run before private git-config hooks. Do not put secrets in committed workflow hooks; use private hooks or external secret managers.

## Webhook Notes

If user wants webhooks, configure `webhook` in global config and tell them the GitHub settings: payload URL `https://<public-host><path>`, content type `application/json`, secret matching config, SSL enabled, and selected events for Issues, Issue comments, Pull requests, Pull request reviews/comments, Check runs, Check suites, Statuses, and Workflow runs. Polling remains safety net.

## Verification

Minimum verification:

```bash
pi conductor config validate
```

When editing this agent repo or adding this skill, also run repository gates. For normal target repos, run the repo's own format/typecheck/test commands only if you changed repo files beyond `.pi/WORKFLOW.md` or the user asks for full validation.

Live verification requires user approval because it can create worktrees, move project cards, and launch agents:

```bash
pi conductor run owner/repo#123 --mode-build
pi conductor status --json
```

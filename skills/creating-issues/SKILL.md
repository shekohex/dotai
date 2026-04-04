---
name: creating-issues
description: Create GitHub issues with `gh` in the user's concise, emoji-free style. Use this whenever the user asks to create, file, open, or report a GitHub issue or bug report, including phrases like "create a GitHub issue for that", "file an issue", "create a GitHub bug report", "report this bug on GitHub", or "open an issue". Infer the target repo automatically, strongly prefer the upstream parent repo over the current fork when working in a forked checkout unless the user explicitly wants the fork, inspect the last 5-7 authored issues to mirror tone and structure, prefer any repo-provided issue template, choose appropriate repo labels, attach the issue to the right project when relevant, and populate project fields such as status, priority, and the active sprint or iteration from recent precedent when clear.
---

# Creating Issues

Open GitHub issues with `gh` in the author's style. Prefer repo conventions over generic defaults.

## Goal

Create a useful issue in the correct target repo, usually the upstream repo rather than the current fork, that matches repo norms, avoids obvious duplicates, uses the right labels and project placement, and returns the issue URL with the important metadata.

## Use This Skill When

- The user asks to create, file, open, or report a GitHub issue
- The user asks to create a GitHub bug report or file a bug on GitHub
- Capturing the current bug, task, or follow-up as a GitHub issue is the next obvious step

## Non-Negotiables

- Use `gh` for GitHub operations
- Be concise and direct
- Do not use emojis
- When working in a fork, prefer creating the issue in the upstream parent repo unless the user explicitly wants the fork
- Prefer repo-provided issue templates over custom prose
- Do not create duplicates when a matching open issue already exists
- Use only labels that actually exist in the target repo
- Add the issue to projects and populate project fields only when there is a clear repo or author precedent
- Return the created issue URL or the existing matching issue URL

## Core Workflow

1. Infer the target repo and owner automatically, checking whether the current checkout is a fork.
2. If the current checkout is a fork, prefer the upstream parent repo unless the user explicitly wants the fork.
3. Search for matching open issues and avoid creating duplicates.
4. Look for repo-provided issue templates. Use them when present.
5. Inspect the last 5-7 authored issues in the same repo, then broaden to the owner if needed.
6. Inspect available repo labels and recent label patterns on similar issues.
7. Inspect milestone and project usage on similar recent issues.
8. Draft a concise title and body that match the author's style.
9. Create the issue with `gh issue create`.
10. Add labels, milestone, assignees, and project linkage when appropriate.
11. Populate project fields one field at a time when the value is clear.
12. Verify the created issue and return the URL with a short status note.

## Infer Repo and Owner

Prefer signals in this order:

1. Explicit user instruction
2. If the current repo is a fork, its upstream parent repo
3. The repo targeted by an existing or intended pull request
4. Current repo from the working tree
5. Current remote from `gh repo view`
6. `upstream`
7. `origin`

Useful checks:

```bash
gh repo view --json nameWithOwner,owner,isFork,parent,defaultBranchRef
git remote -v
gh issue status
gh pr status
```

If the user names a different repo, honor that.

## Prefer Upstream Over Forks

When the current checkout is a fork, the default target for issue creation should usually be the upstream parent repo, not the fork.

This matters most when:

- the user is working on a branch that will become a PR against upstream
- the bug, task, or feature request belongs to the canonical project rather than personal fork-only work
- labels, issue templates, milestones, and projects are maintained on the upstream repo

Rules:

- If `gh repo view --json isFork,parent` shows the current repo is a fork, prefer `parent.nameWithOwner` as the issue target
- If `gh pr status` or branch context suggests the work is for an upstream PR, create the issue in upstream
- Only create the issue in the fork when the user explicitly asks for the fork, or the issue is clearly fork-specific
- Once upstream is selected, use upstream labels, templates, milestones, and projects for the rest of the workflow

## Avoid Duplicates First

Before creating an issue, search open issues in the target repo using the likely title keywords and core symptom or task.

Useful commands:

```bash
gh search issues "<keywords>" --repo <owner/repo> --state open --match title,body --limit 10 --json number,title,url,labels
gh issue list --repo <owner/repo> --state open --search "<keywords>" --limit 10 --json number,title,url,labels
```

Rules:

- If an open issue clearly matches, do not create a duplicate
- Return the existing issue URL and explain the match briefly
- If there is only partial overlap, create the new issue and reference the related issue in the body when useful

## Prefer Repo Templates First

Before drafting the issue body, check whether the repo already defines issue templates. Prefer the repo template over any fallback in this skill.

Common locations:

- `.github/ISSUE_TEMPLATE/*.md`
- `.github/ISSUE_TEMPLATE/*.yml`
- `.github/ISSUE_TEMPLATE.md`
- `.github/issue_template.md`

Rules:

- If the repo has a matching issue template, use it as the starting structure
- If the repo exposes a template name that `gh issue create --template` can use cleanly, prefer that path
- If multiple templates exist, pick the closest match such as bug, feature, task, regression, or documentation
- If the template is an issue form or otherwise noisy, still keep the final prose concise
- If the CLI cannot express the template cleanly, mirror the important required sections manually
- If the repo has no template, use `./references/issue-template.md` only as fallback guidance

`./references/issue-template.md` is guidance, not a rigid schema.

## Mine the Author's Style

Before writing the issue, inspect recent authored examples. Prefer the same repo first. Broaden only if needed.

Useful commands:

```bash
gh issue list --repo <owner/repo> --author "@me" --limit 7 --state all --json number,title,body,labels,projectItems,milestone,url
gh search issues --owner <owner> --author "@me" --state all --limit 7 --json repository,number,title,body,labels,projectItems,url
```

Match the author's habits:

- title length and casing
- whether titles focus on the bug, the task, or the intended outcome
- section names that recur
- bullet density
- level of detail in repro steps and context
- label combinations and project placement patterns

Do not imitate exact sentences. Capture tone, brevity, and structure.

## Issue Title Guidance

Write a short title focused on the actual problem, gap, or requested outcome.

- For bugs, prefer the failing behavior or user-visible symptom
- For tasks or follow-ups, prefer the intended outcome or missing capability
- Avoid commit-log phrasing, implementation trivia, hype, and emojis

## Issue Body Guidance

Follow the repo template first. If there is no repo template, use the fallback reference and adapt it to the issue type.

Rules:

- Keep the first paragraph or bullet block high-signal
- Include repro, expected, and actual behavior for bugs when known
- Include scope, constraints, or acceptance notes for tasks when known
- Include links, screenshots, logs, or error text only when they materially help
- Mention related issues only when relevant
- Remove empty sections

## Label Selection

Labels are repo-specific. List the repo's actual labels before choosing any.

Useful commands:

```bash
gh label list --repo <owner/repo> --limit 200 --json name,description,isDefault
gh issue list --repo <owner/repo> --author "@me" --limit 20 --state all --json number,title,labels,url
```

Rules:

- Prefer exact repo labels over invented names
- Use recent similar issues to infer normal label combinations
- Add only labels that are clearly applicable
- If a broad default label like `bug`, `enhancement`, `documentation`, or `needs-triage` exists and fits, it is usually safe
- If the repo uses specialized prefixes such as area, platform, type, priority, or team, match those conventions only when the issue clearly fits
- If label choice is ambiguous, use fewer labels and report the uncertainty

## Milestones and Projects

Look at recent similar issues before deciding whether the issue should be linked to a milestone or project.

Useful commands:

```bash
gh issue list --repo <owner/repo> --author "@me" --limit 20 --state all --json number,title,milestone,projectItems,url
gh project list --owner <owner> --limit 100 --format json
```

Rules:

- Only attach the issue to a milestone or project when there is clear repo or author precedent
- If similar recent issues consistently land in a specific project, use that project
- If the issue is clearly backlog or sprint work and the repo owner uses projects for that, attach it
- If project operations fail because the token lacks the `project` scope, report the blocker clearly and return the issue URL anyway

## Project Field Population

After project linkage, inspect the chosen project's fields and fill only the values that are actually justified.

Useful commands:

```bash
gh project view <number> --owner <owner> --format json
gh project field-list <number> --owner <owner> --format json
gh project item-list <number> --owner <owner> --limit 100 --format json
gh project item-add <number> --owner <owner> --url <issue-url> --format json
gh project item-edit --id <item-id> --project-id <project-id> --field-id <field-id> --single-select-option-id <option-id>
```

Rules:

- Edit one field at a time with `gh project item-edit`
- Prefer recent similar issues as precedent for field choices
- Fill status, type, priority, team, area, or similar single-select fields only when the value is obvious from the issue or recent precedent
- Do not invent field values just to make the card look complete

### Iteration and Sprint Fields

If the project has an iteration field such as sprint, choose the active iteration when clear.

Rules:

- Prefer the iteration currently active today
- If multiple active or near-current iterations exist, prefer the one used by similar recent issues
- If there is no active iteration, prefer the nearest upcoming iteration only when recent issues show that pattern
- If the project conventions are unclear, leave the iteration empty and report that choice

## Creation Command Pattern

Prefer explicit title, body, labels, and project flags:

```bash
gh issue create \
  --repo <owner/repo> \
  --title "<title>" \
  --body-file - \
  --label "<label-1>" \
  --label "<label-2>" \
  --project "<project-title>"
```

If the repo exposes a matching template, prefer:

```bash
gh issue create \
  --repo <owner/repo> \
  --template "<template-name>" \
  --title "<title>"
```

Add `--milestone` and `--assignee` when appropriate.

## Final Output

After creation, report:

- issue URL
- title
- labels that were applied
- milestone and project, if any
- any project fields that were populated
- any notable blocker such as missing `project` scope or ambiguous labels

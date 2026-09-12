# Issue Project Placement

Use when repository or author precedent supports milestone or project placement.

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


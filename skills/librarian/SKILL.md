---
name: librarian
description: "Cache and refresh remote git repositories under ~/.cache/checkouts/<host>/<org>/<repo> so future references can reuse a local copy. Use this skill when the user points you to a remote git repository or you encountered a remote git repo through other means."
---

Use this skill when the user points you to a remote git repository (GitHub/GitLab/Bitbucket URLs, `git@...`, or `owner/repo` shorthand).

The goal is to keep a reusable local checkout that is:
- **stable** (predictable path)
- **up to date** (periodic fetch + fast-forward when safe)
- **efficient** (partial clone with `--filter=blob:none`, no repeated full clones)

## Cache location

Repositories are stored at:

`~/.cache/checkouts/<host>/<org>/<repo>`

Example:

`github.com/mitsuhiko/minijinja` → `~/.cache/checkouts/github.com/mitsuhiko/minijinja`

## Command

```bash
bash <skill-dir>/scripts/checkout.sh <repo> --path-only
```

Examples:

```bash
bash <skill-dir>/scripts/checkout.sh mitsuhiko/minijinja --path-only
bash <skill-dir>/scripts/checkout.sh github.com/mitsuhiko/minijinja --path-only
bash <skill-dir>/scripts/checkout.sh https://github.com/mitsuhiko/minijinja --path-only
```

The script will:
1. Parse the repo reference into host/org/repo.
2. Clone if missing.
3. Reuse existing checkout if present.
4. Fetch from `origin` when stale (default interval: 300s).
5. Attempt a fast-forward merge if the checkout is clean and has an upstream.

## Update strategy

- Default behavior is **throttled refresh** (every 5 minutes) to avoid unnecessary network calls.
- Force immediate refresh with:

```bash
bash <skill-dir>/scripts/checkout.sh <repo> --force-update --path-only
```


## Citation rules:
- Code-content claims: cite `absolute/local/path:lineStart-lineEnd` from explicit read ranges on cached files.


## Output format (Markdown, exact section order):

## Summary
(1-3 sentences)
## Locations
- `absolute/local/path`, `absolute/local/path:lineStart-lineEnd` — what is here and why it matters;
- If nothing relevant is found: `- (none)`
## Evidence
- `path` or `path:lineStart-lineEnd` — short note on what this proves.
- Include concise snippets only when they add clarity.
- For straightforward path-only/metadata answers, concise command evidence is enough.
- Evidence must only cite downloaded/cached files for code-content claims.
## Searched (only if incomplete / not found)
- Queries, filters, and directory/tree probes used
## Next steps (optional)
- 1-3 narrow fetches/checks to resolve remaining ambiguity

## Recommended workflow

1. Resolve repository path via `<skill-dir>/scripts/checkout.sh --path-only`.
2. Use that path for searching, reading, and analysis.
3. On later references to the same repo, call `<skill-dir>/scripts/checkout.sh` again; it will find and update the cached checkout.

## If edits are needed

Prefer not to edit directly in the shared cache. Create a separate worktree or copy from the cached checkout for task-specific modifications.

## Notes

- `owner/repo` defaults to `github.com`.
- `<skill-dir>` is the current directory of that skill.

# Launch rules use GitHub Actions-like expressions

`.pi/WORKFLOW.md` launch rules will use expression strings modeled after GitHub Actions syntax rather than simple maps. V1 should support a close, safe subset with `${{ ... }}` wrappers, functions like `contains()`, and dot-path access to normalized issue/project context; it will not execute arbitrary JavaScript. The expression context exposes both GitHub-style paths and conductor aliases.

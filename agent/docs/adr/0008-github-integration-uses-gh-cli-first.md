# GitHub integration uses gh CLI first

Pi Conductor will use the GitHub CLI for v1 GitHub operations, including GraphQL and REST calls. This reuses local authentication and keeps the first implementation dependency-light, with the trade-off that conductor requires a working `gh` installation in local mode.

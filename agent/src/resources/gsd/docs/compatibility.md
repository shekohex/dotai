# GSD Compatibility Notes

## Guaranteed In V1

- valid `.planning` directories are detected and continued in place
- bundled built-in commands operate on existing `.planning` state
- prompts, templates, roles, orchestration, and docs are bundled in repo
- `STATE.md` frontmatter accepts upstream YAML blocks, including nested structures
- blank scalar fields such as `current_plan:` remain valid and load as blank strings
- `PLAN.md` frontmatter accepts upstream nested `must_haves`, `requirements`, and `user_setup`
- missing core planning files such as `PROJECT.md` make `/gsd health` unhealthy
- `/gsd health --context` works with explicit numeric flags or bare `--context` when local session/config can supply enough context; missing token usage remains explicit instead of guessed

## Not Guaranteed

- exact runtime parity with old `pi-gsd`
- WXP compatibility
- command-name parity with upstream shell tools
- behavior beyond `.planning` data compatibility

## Compatibility Boundary

Primary durable contract:

- `STATE.md`
- `ROADMAP.md`
- `PROJECT.md`
- `REQUIREMENTS.md`
- `config.json`
- phase directories and plan artifacts

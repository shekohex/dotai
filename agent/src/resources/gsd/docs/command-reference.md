# GSD Command Reference

## Control

- `/gsd`
- `/gsd on`
- `/gsd off`
- `/gsd help`

## Milestones

- `/gsd new-project [brief]`
  flags: `--auto`
- `/gsd new-milestone [milestone]`
- `/gsd complete-milestone [version]`
- `/gsd milestone-summary [version]`

## Planning

- `/gsd map-codebase`
  flags: `--paths <repo/path,...>`, `--fast`, `--focus <tech|arch|quality|concerns|tech+arch>`, `--query <term|status|diff|refresh>`
  modes: `refresh`, `update`, `skip`
- `/gsd discuss-phase [phase] [input]`
  flags: `--phase <phase>`, `--assumptions`, `--auto`, `--all`, `--chain`, `--text`
- `/gsd plan-phase [phase]`
  flags: `--phase <phase>`, `--research-phase <phase>`, `--research`, `--skip-research`, `--skip-verify`, `--gaps`, `--reviews`, `--view`, `--text`

## Execution

- `/gsd execute-phase <phase>`
  flags: `--phase <phase>`, `--wave <n>`, `--gaps-only`, `--interactive`, `--validate`, `--cross-ai`, `--no-cross-ai`, `--auto`, `--tdd`, `--mvp`
  `--cross-ai`, `--no-cross-ai`, `--auto`, `--tdd`, `--mvp` forward to bundled workflow/runtime
- `/gsd secure-phase [phase]`
  flags: `--phase <phase>`
- `/gsd verify-work [phase]`
  flags: `--phase <phase>`
- `/gsd validate-phase [phase]`
  flags: `--phase <phase>`
  unsupported args fail explicitly; omitted phase prefers last completed local SUMMARY-backed phase; non-executed phases fail closed

## Debug

- `/gsd debug [description]`
  flags: `--diagnose`
- `/gsd debug list`
  flags: `--diagnose`
- `/gsd debug status <slug>`
  flags: `--diagnose`
- `/gsd debug continue <slug>`
  flags: `--diagnose`

## Instant

- `/gsd next [phase]`
  flags: `--phase <phase>`, `--force`
- `/gsd stats`
  variants: `json`, `table`, `--json`, `--table`, `--format json`, `--format table`
  unsupported variants fail explicitly instead of falling back to one-line notify output
- `/gsd health`
- `/gsd status`

## Workflow Review

- `/gsd progress`
  default route: bundled workflow-launch review session
  flags: `--next`
  `--phase <phase>`, `--force` only with `/gsd progress --next`
  parsed with explicit unsupported-local error: `--do`, `--forensic`

## Phase Override

Supported forms:

- positional: `/gsd plan-phase 2`
- flag: `/gsd execute-phase --phase 3.1`
- equals flag: `/gsd next --phase=4`
- progress next positional: `/gsd progress --next 2`
- progress next flag: `/gsd progress --next --phase 2`
- progress next force: `/gsd progress --next --force`

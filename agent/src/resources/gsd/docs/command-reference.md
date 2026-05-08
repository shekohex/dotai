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
  flags: `--phase <phase>`
- `/gsd progress [phase]`
  flags: `--phase <phase>`, `--next`
  parsed with explicit unsupported-local error: `--do`, `--forensic`
- `/gsd stats`
- `/gsd health`
- `/gsd status`

## Phase Override

Supported forms:

- positional: `/gsd plan-phase 2`
- flag: `/gsd execute-phase --phase 3.1`
- equals flag: `/gsd next --phase=4`

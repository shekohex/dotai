---
name: run-skill-generator
description: Create or repair a project run skill with verified launch and interaction instructions. Use for run-skill authoring, not ordinary app launches.
---

# Run Skill Generator

Create or repair `<unit>/.pi/skills/run-<unit-name>/` so a future agent can build, launch, and interact with one deployable app, service, or library using verified instructions.

## Locate the unit

Use the requested app and existing project context. Inspect relevant manifests and run scripts. Ask which unit only when multiple candidates remain plausible.

Check existing `.pi/skills/*/SKILL.md` descriptions for launch instructions. Refine an existing matching skill in place, preserving its name and working commands. If migrating a legacy `.pi/run.md`, update its references and preserve its content before removing the old file.

Use one skill per deployable unit, with sections for binaries sharing setup. Match folder and frontmatter names, such as `run-billing-api`. Commands in the generated skill should state their working directory; use paths relative to the unit consistently.

## Establish a working interaction

1. Inspect the current environment and relevant setup instructions. Install required dependencies within the authorized scope and record commands that work.
2. Launch the actual app and drive a representative user flow. A library's public API invocation is its user surface. An internal function probe can supplement an app launch but cannot replace it.
3. Reuse existing automation where possible: a CLI invocation, `curl`, browser tooling, or a terminal driver. Write a helper only when reusable interaction needs it; keep it next to the skill or link to the project's existing harness.
4. Inspect results, including screenshots for GUI flows. Fix in-scope setup and driver failures, then repeat affected checks. Stop processes created for verification when finished.

Read only the relevant starting pattern:

| Unit        | Pattern                                            |
| ----------- | -------------------------------------------------- |
| CLI         | [cli.md](../run-app/examples/cli.md)               |
| Server/API  | [server.md](../run-app/examples/server.md)         |
| TUI         | [tui.md](../run-app/examples/tui.md)               |
| Electron    | [electron.md](../run-app/examples/electron.md)     |
| Web UI      | [playwright.md](../run-app/examples/playwright.md) |
| Library/SDK | [library.md](../run-app/examples/library.md)       |

Treat examples as starting points; verify tools and platform support in the current environment. Use documented development modes or fixtures for restricted dependencies. Do not treat app setup as authorization to bypass account entitlements or alter production access controls.

## Write the skill

Use [template.md](template.md) for structure, retaining only relevant sections. Include:

- Short description that identifies this unit's launch or interaction workflow.
- Verified prerequisites, setup, build, and agent interaction commands.
- Driver location, inputs, expected observable result, artifact locations, and cleanup.
- Human launch path only if meaningfully different.
- Specific troubleshooting learned from actual failures, when any occurred.

Keep platform-specific or optional troubleshooting behind references when substantial. Do not invent obstacles because setup worked on the first attempt. Separate unverified platform notes from executable instructions; never claim a command was tested when it was not.

## Completion

Follow the generated instructions from a fresh shell in the unit directory, including a real interaction and cleanup. Resolve gaps until the documented path works. Run checks appropriate to changed scripts plus required repository gates.

Deliver the skill and any reusable driver with observed validation. Files need to be saved and usable; commit only when authorized. If required access or platform support prevents a real launch, report the concrete blocker and incomplete verification instead of presenting the skill as verified.

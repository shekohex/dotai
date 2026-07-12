# Resources

Bundled assets under `src/resources/` (copied to `dist/resources/` at build by `scripts/copy-bundled-resources.mjs`). At runtime, `src/extensions/bundled-resources.ts` patches the upstream `DefaultResourceLoader.reload` to append these paths to the upstream loader's `additionalSkillPaths` / `additionalPromptTemplatePaths` / `additionalThemePaths`, so they merge with any project/user resources. See [Architecture → Bundled-resource injection](../architecture/overview.md#bundled-resource-injection).

## system/ — model-family system prompts

Base system prompts selected per model family by `src/extensions/model-family-system-prompt.ts`, which patches `AgentSession.prototype` (`bindExtensions`, `setModel`, `setActiveToolsByName`, `reload`) and the `before_agent_start` hook to reapply the right prompt whenever the model changes.

- Files: `default.md`, `codex.md`, `gpt.md`, `gemini.md`, `kimi.md`.
- `resolveModelFamilySystemPrompt(modelId)` maps by substring: `codex`→`codex`, `gpt-5`→`gpt`, `gemini`→`gemini`, `kimi`→`kimi`, else `default`. The chosen prompt **replaces** the base system prompt; the upstream dynamic tail is appended back.

## modes/ — mode system prompts

One markdown file per mode that uses a non-default system prompt (`ask.md`, `commiter.md`, `openwiki.md`, `painter.md`, `poke.md`, `review.md`, `search.md`, `worker.md`). `src/default-modes.ts` reads these at module load via `modeSystemPrompt(mode)` and attaches them with `systemPromptMode: "replace"` (or `"append"`). See [Architecture → Mode system](../architecture/overview.md#mode-system).

## prompts/ — prompt templates

Reusable templates injected into agent prompts: `concise.md`, `deslop.md`, `confidance.md`.

## themes/ — bundled themes

`catppuccin-mocha.json` (the default theme — `default-settings.ts#theme`) and `catppuccin-latte.json`. Loaded via `discoverThemePaths()`.

## skills/ — bundled SKILL.md skills

Each is a directory with a `SKILL.md` (and optional resources), discovered by `discoverSkillPaths()`:

| Skill                  | Extras                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| `creating-goals/`      | `references/PROMPT_GUIDE_GPT5_5.md`, `scripts/draft-goal.{sh,ps1}` |
| `dynamic-workflows/`   | `references/API.md`, `references/PATTERNS.md`                      |
| `executor/`            | —                                                                  |
| `herdr/`               | —                                                                  |
| `run-app/`             | `examples/{cli,electron,library,playwright,server,tui}.md`         |
| `run-skill-generator/` | `template.md`                                                      |
| `setup-pi-conductor/`  | —                                                                  |
| `using-coder-cli/`     | `references/COMMANDS.md`                                           |

## dynamic workflows

`src/resources/workflows/dynamic/*.workflow.js` are JavaScript workflow scripts loaded and orchestrated at runtime by the `dynamic-workflows` extension:

- `simplify`, `goal`, `codebase-audit`, `multi-perspective`, `deep-research`, `adversarial-review`, `auto-generated`.

Each script exports `meta = { name, description, phases }` and uses the `workflow` runtime API (`agent()`, `parallel()`, `pipeline()`, `phase()`, `log()`, `args`, `budget`). The extension (`workflow-manager.ts`, `builtin-registry.ts`, `workflow-tool.ts`, `workflow-commands.ts`) provides the subagent backend, run persistence, pause/resume, and TUI, and routes `/wf:<name>` to a workflow. See the [dynamic-workflows extension](../extensions/catalog.md#workflows--goals) and the `dynamic-workflows` skill.

## gsd/ — "Get Shit Done" system

A large project-lifecycle system (project → milestone → phase) driven by the `gsd` extension (`src/extensions/gsd/`). GSD is **disabled by default** and enabled via `/gsd on` or settings; it persists state under a project's `.planning/`.

The resource tree:

| Subdir              | Contents                                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/`           | 30+ subagent role prompts (`gsd-planner`, `gsd-executor`, `gsd-debugger`, `gsd-verifier`, `gsd-security-auditor`, `gsd-code-reviewer`, …).                                                                        |
| `bin/lib/*.cjs`     | A bundled CLI toolchain (40+ files): `init`, `milestone`, `phase`, `roadmap`, `state`, `verify`, `validate`, `drift`, `uat`, `intel`, `audit`, … plus `*-command-router.cjs` routers. Entry: `bin/gsd-tools.cjs`. |
| `commands/gsd/*.md` | Per-command help (`new-project`, `plan-phase`, `execute-phase`, `complete-milestone`, `debug`, `verify-work`, …).                                                                                                 |
| `docs/`             | `overview.md`, `architecture.md`, `user-guide.md`, `command-reference.md`, `role-reference.md`, `audit.md`, `checklist.md`, `compatibility.md`.                                                                   |
| `templates/`        | Project, milestone, research, UAT, validation, retrospective templates.                                                                                                                                           |
| `workflows/`        | Markdown workflow definitions for the phase lifecycle (`plan-phase`, `execute-phase`, `discuss-phase`, `verify-work`, `new-milestone`, `complete-milestone`, `progress`, `diagnose-issues`, …).                   |
| `references/`       | Deep guides: `questioning`, `tdd`, `context-budget`, `planner-revision`, `gates`, `checkpoints`, `thinking-models-*`, `common-bug-patterns`, …                                                                    |

> The `gsd/docs/` directory is itself a useful reference; GSD's own behavior is documented there in more depth than this wiki reproduces.

## glance/ and tmux-share/ — web UIs

Small static HTML assets served by their extensions:

- `glance/index.html` (+ `favicon.svg`) — local web dashboard served by the `glance` extension's daemon/HTTP server.
- `tmux-share/index.html` — browser view of a tmux pane served by the `tmux-share` extension.

## plannotator resources

`src/resources/plannotator/` (`plannotator.html`, `review-editor.html`) are **built** from `vendor/plannotator-ui/` by `scripts/build-plannotator-ui.mts` at build time (not hand-edited). They back the `plannotator` extension's browser review UI. See the [plannotator extension](../extensions/catalog.md#integrations--external-surfaces).

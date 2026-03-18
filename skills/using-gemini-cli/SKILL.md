---
name: using-gemini-cli
description: Run the `gemini` CLI in headless mode for one-off prompts, model-directed Gemini tasks, structured output capture, and follow-up messages against prior Gemini sessions. Use when the user asks to use Gemini CLI, mentions `gemini -p`, wants Gemini in non-interactive mode, wants a `flash` or `pro` Gemini run, needs project-scoped session discovery, or wants to continue an older Gemini session from the terminal instead of the interactive TUI.
---

# Using Gemini CLI

Use `gemini` through PTY. Prefer headless mode for automation and one-off tasks. Use the interactive TUI only when the user explicitly wants it or when you need the `/model` picker.

## Defaults

- Non-interactive Gemini means `gemini -p "..."`.
- Always run Gemini in PTY so you can read the full output buffer and wait through retries.
- Keep the same `workdir` for `-p`, `--list-sessions`, and `--resume`. Sessions are project-scoped.
- Prefer `-o json` when the output will be parsed or resumed later.
- Prefer `-o text` when the user wants the plain answer only.
- If stdin is piped, Gemini prepends stdin content and then appends the `-p` prompt after it.

## Quick Start

One-off text response:

```bash
gemini -p "Summarize this repo in 3 bullets" -o text
```

One-off structured response:

```bash
gemini -p "Return JSON with keys name and purpose" -o json
```

Continue the latest project session:

```bash
gemini --resume latest -p "Now make it shorter" -o text
```

## Model Selection

Pass model choice with `-m` or `--model`.

Preferred forms:

```bash
gemini -m flash -p "..." -o text
gemini -m pro -p "..." -o text
gemini -m flash-lite -p "..." -o text
gemini -m gemini-2.5-flash -p "..." -o text
gemini -m gemini-3.1-pro-preview -p "..." -o text
```

Use aliases when the user speaks in tiers:

- User says `use flash` or `use Gemini flash` -> use `-m flash`
- User says `use pro` or `ask Gemini pro` -> use `-m pro`
- User says `use flash-lite` -> use `-m flash-lite`
- User gives an exact model id -> pass it through unchanged with `-m <id>`

Observed on Gemini CLI `0.34.0`:

- `-m flash` resolved to `gemini-3-flash-preview`
- `-m pro` resolved to `gemini-3.1-pro-preview`
- `-m gemini-2.5-flash` stayed exact

Treat alias resolution as version- and account-dependent. If exact model identity matters, use an explicit model id and prefer `-o json` so you can confirm the concrete model in `stats.models`.

## How To List Models

There is no dedicated `gemini --list-models` flag in `gemini --help`.

Use one of these paths instead:

1. Interactive browsing: start `gemini`, then run `/model` to open the model picker.
2. Known manual choices: use `flash`, `pro`, `flash-lite`, `auto-gemini-3`, `auto-gemini-2.5`, or an explicit model id.
3. Verification after a headless run: use `-o json` and inspect `stats.models` to see which concrete model actually handled the request.

## Common Workflows

Fast one-off task:

```bash
gemini -p "Explain why this test is flaky" -o text
```

Frontend fast pass with Flash:

```bash
gemini -m flash -p "Review this React component for obvious UX, layout, and accessibility issues. Keep it concise." -o text
```

Frontend deeper design or architecture pass with Pro:

```bash
gemini -m pro -p "Design a responsive landing page architecture for this app. Include component breakdown, spacing system, and interaction notes." -o text
```

Frontend structured output for automation:

```bash
gemini -m pro -p "Return JSON with keys components, design_tokens, and implementation_steps for this dashboard redesign." -o json
```

Continue an older frontend session:

```bash
gemini --list-sessions
gemini --resume latest -m pro -p "Now turn that plan into a Tailwind component checklist." -o text
```

Resume by exact session id:

```bash
gemini --resume 21177875-7869-4ae6-862c-57a138f1cd6d -p "Add edge cases I missed" -o text
```

## Session Workflow

1. Start with `gemini -p`.
2. If follow-ups are likely, prefer `-o json` and capture `session_id`.
3. If the session handle is unknown, run `gemini --list-sessions` in the same project directory.
4. Resume with `--resume latest`, `--resume <index>`, or `--resume <session-uuid>`.
5. Read the full PTY output before concluding; Gemini may print setup noise before the actual answer.

Observed behavior worth relying on:

- Headless `-p` runs are persisted as resumable sessions.
- `--list-sessions` shows numeric indexes and UUIDs.
- `--resume latest`, `--resume <index>`, and `--resume <uuid>` all work for follow-up prompts.

## Output Handling

Expect startup noise in PTY output such as cached credential messages, extension loading, MCP warnings, or retry notices. Do not treat the first line as the answer.

When using `-o json`:

- Read the final JSON object from the PTY buffer.
- Use `response` as the model answer.
- Use `session_id` for exact future follow-ups.
- Use `stats.models` to confirm the concrete model that actually ran.

When using `-o text`:

- The final answer is usually the last meaningful line.
- If the output is ambiguous, confirm with `--list-sessions` or inspect the matching session file under `~/.gemini/tmp/<project>/chats/`.

## Known Pitfalls

- If Gemini complains about saving `~/.gemini/projects.json`, ensure `~/.gemini/` exists before retrying.
- Session discovery depends on the current project path. Changing directories can make `latest` point at a different session set.
- Local extensions or MCP servers can add noisy warnings without breaking the actual answer.
- Capacity or quota retries can delay completion; keep reading the PTY until the process exits.

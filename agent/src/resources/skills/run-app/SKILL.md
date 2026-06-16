---
name: run-app
description: Launch and drive the current project's real app surface to verify behavior, screenshots, or changes. Use when asked to run, start, smoke test, screenshot, or confirm app behavior through CLI, server/API, browser, TUI, desktop, or SDK entrypoints.
---

# Run App

Running means launching the actual app surface and interacting with it like a user or integration would. Tests and imports are useful, but they are not a real app run by themselves.

## First Check Existing Run Paths

- Look for repo docs, `package.json` scripts, Makefile targets, README run sections, `DESIGN.md`, storybook docs, or project skills that already define launch mechanics.
- If one clearly covers the app, follow it instead of rediscovering mechanics.
- If several units could be the target, ask which unit to run.
- If the documented path is stale for reasons unrelated to the task, report that and use the closest safe fallback.

## Pick The Real Surface

- CLI: invoke the command a user would run, include representative args/stdin, and inspect exit code/output.
- Server/API: start service if needed, wait for readiness by polling the port/health/page, then hit the route the change affects.
- Browser app: start dev server, wait for the real page, navigate to changed UI, exercise the interaction, inspect screenshot/rendered output, and check console errors when tooling exists.
- TUI: run in tmux, send keys, and capture the visible pane.
- Desktop/Electron: drive the real window when available and inspect screenshot/output.
- Library/SDK UI package: run a boundary example, story, preview, or consumer smoke path.

## Runtime Rules

- Drive it, don't just launch it. Launching without interaction only proves the entrypoint resolves.
- Do not rely on fixed sleeps for readiness; poll a port, health endpoint, page text, prompt, process output, or other observable condition.
- Use background execution for long-running servers/watchers and stop or leave them according to user/tool guidance.
- Check the golden path and the relevant edge path touched by the task.
- If verification is impossible, state exactly what was verified and what remains unverified.

## Capture Learning

If you had to discover non-obvious launch mechanics, env vars, setup steps, ports, patches, auth, seed data, or driver commands, mention them in the report and recommend capturing them in project docs or a project run skill. Do not create documentation unless asked.

## Report

Include:

- command or app path used
- interaction performed
- result observed
- screenshots/logs/console/errors checked when relevant
- unverified parts and why

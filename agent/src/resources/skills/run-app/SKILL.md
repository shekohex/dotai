---
name: run-app
description: Launch and drive this project's app to see a change working. Use when asked to run, start, smoke test, screenshot, or confirm behavior in the real app, not just tests. First looks for project docs or skills that already cover launching the app; otherwise falls back to patterns per project type.
---

**Running means launching the actual app and interacting with it** —
not the test suite, not an `import` of an internal function and a
`console.log`. The app as a user (human or programmatic) would meet
it: the CLI at its command, the server at its socket, the GUI at its
window.

## First: does a project skill or doc already cover this?

A project skill that launches this app is the repo's verified path —
its author already cold-started from a Linux container and committed
what worked: the exact `apt-get` line, the env vars, the patches, the
driver. Project docs and scripts are also useful. Use them instead of rediscovering.

```bash
d=$PWD; while :; do
  grep -Hm1 '^description:' "$d"/.pi/skills/*/SKILL.md "$d"/.agents/skills/*/SKILL.md 2>/dev/null
  grep -Hm1 -E 'run|start|dev|serve|screenshot|storybook' "$d"/README* "$d"/DESIGN.md "$d"/package.json "$d"/Makefile 2>/dev/null
  [ -e "$d/.git" ] || [ "$d" = / ] && break
  d=$(dirname "$d")
done
```

- **One describes launching/driving this app** → read that SKILL.md
  and follow it verbatim. Don't paraphrase; don't skip the patches.
- **Mega-repo, several plausible, no clear match** → ask the user
  which unit to run.
- **Stale** (fails on mechanics unrelated to your task) → tell the
  user; offer to capture the refreshed path in a project run skill or docs.
- **Nothing about running** → fall back to the patterns below.

## Otherwise: match the shape, use the pattern

Pick the row closest to your project. Launch the app, wait for readiness with an observable check, then perform one representative interaction.

| Project type               | Handle                                               |
| -------------------------- | ---------------------------------------------------- |
| CLI tool                   | direct invocation, exit code, stdin/stdout           |
| Web server / API           | background launch + `curl` smoke                     |
| TUI / interactive terminal | tmux `send-keys` / `capture-pane`                    |
| Electron / desktop GUI     | real window under xvfb/Playwright when available     |
| Browser-driven             | dev server + available browser automation/screenshot |
| Library / SDK              | import-and-call smoke script at the package boundary |

For long-running servers, watchers, REPLs, and interactive apps, use Pi bash background execution: end the command with `&` and add `# poll:5000` when periodic output helps. Do not use fixed sleeps for readiness; poll the real port, route, page text, prompt, or process output.

## Drive it, don't just launch it

Launching with no interaction proves the entrypoint resolves. That's
not running the app — it's typechecking with extra steps. Drive it to
a point where a user would see something:

- CLI → type a representative command, check the exit code and output.
- Server → hit the route the diff touches with `curl`, read the body.
- TUI → `send-keys` a navigation, `capture-pane` the result.
- GUI → click the button, screenshot the window. **Look at the
  screenshot.** A blank frame is a failure to launch.

If the fallback pattern didn't work out of the box — you had to
install packages, set env vars, patch config, or write a driver —
recommend capturing that path in a project run skill or docs. If it just worked, don't.

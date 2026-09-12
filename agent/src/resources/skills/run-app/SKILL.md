---
name: run-app
description: Launch and interact with the actual app when asked to run it, capture screenshots, or verify behavior in the running app.
---

**Running means launching the actual app and interacting with it** —
not the test suite, not an `import` of an internal function and a
`console.log`. The app as a user (human or programmatic) would meet
it: the CLI at its command, the server at its socket, the GUI at its
window.

## First: does a project skill already cover this?

Prefer a project skill that covers this app: it can contain setup and driver knowledge missing from generic patterns. Check its assumptions against the current environment.

```bash
d=$PWD; while :; do
  grep -Hm1 '^description:' "$d"/.pi/skills/*/SKILL.md 2>/dev/null
  [ -e "$d/.git" ] || [ "$d" = / ] && break
  d=$(dirname "$d")
done
```

- **One describes launching/driving this app** → read that SKILL.md
  and use its relevant launch path, preserving non-obvious prerequisites. Adapt stale mechanics to current tools.
- **Mega-repo, several plausible, no clear match** → ask the user
  which unit to run.
- **Stale** → diagnose setup failures and continue through reasonable in-scope fixes. Report stale instructions; authoring a new skill is a separate task.
- **Nothing about running** → fall back to the patterns below.

## Otherwise: match the shape, use the pattern

Pick the row closest to your project. Each example walks through
launch + first interaction; ignore any trailing "write the skill"
section — you're using the recipe, not authoring one.

| Project type               | Handle                                               | Example                                          |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------ |
| CLI tool                   | direct invocation, exit code, stdin/stdout           | [examples/cli.md](examples/cli.md)               |
| Web server / API           | background launch + `curl` smoke                     | [examples/server.md](examples/server.md)         |
| TUI / interactive terminal | tmux `send-keys` / `capture-pane`                    | [examples/tui.md](examples/tui.md)               |
| Electron / desktop GUI     | Playwright `_electron` REPL under xvfb               | [examples/electron.md](examples/electron.md)     |
| Browser-driven             | dev server + `chromium-cli` script                   | [examples/playwright.md](examples/playwright.md) |
| Library / SDK              | import-and-call smoke script at the package boundary | [examples/library.md](examples/library.md)       |

If nothing fits, start from the closest match and adapt. For a web
app, [examples/playwright.md](examples/playwright.md) — drive it with
`chromium-cli`, no custom driver needed. For a desktop app,
[examples/electron.md](examples/electron.md) — it has the `_electron`
REPL driver skeleton and the tmux wrapping.

## Drive it, don't just launch it

Launching with no interaction proves the entrypoint resolves. That's
not running the app — it's typechecking with extra steps. Drive it to
a point where a user would see something:

- CLI → type a representative command, check the exit code and output.
- Server → hit the route the diff touches with `curl`, read the body.
- TUI → `send-keys` a navigation, `capture-pane` the result.
- GUI → click the button, screenshot the window. **Look at the
  screenshot.** A blank frame is a failure to launch.

Finish when the requested interaction is observed and any requested screenshot is inspected. Report the result or concrete blocker. Clean up processes created for verification unless the user asked to keep the app running.

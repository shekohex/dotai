---
name: agent-device
description: Automates Apple-platform apps (iOS, tvOS, macOS) and Android devices. Use when navigating apps, taking snapshots/screenshots, tapping, typing, scrolling, extracting UI info, collecting logs/network/perf evidence, or planning agent-device CLI commands.
---

# agent-device

Router only. Private setup before using this skill:

```bash
agent-device --version
```

Before your first agent-device command or plan, read the version-matched CLI guide:

```bash
agent-device help workflow
```

Escalate only when relevant:

```bash
agent-device help debugging
agent-device help react-native
agent-device help react-devtools
agent-device help remote
agent-device help macos
agent-device help dogfood
```

Default loop: `open -> snapshot/-i -> get/is/find or press/fill/scroll/wait -> verify -> close`.

Use this skill only to route into version-matched CLI help. Let `help workflow` provide exact command shapes, platform limits, and current workflow guidance.

For precise location workflows, read the installed `settings` help before planning so coordinate support and platform limits come from the active CLI version.

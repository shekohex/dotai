# @shekohex/agent

A small wrapper around `@earendil-works/pi-coding-agent`.

It keeps the usual `pi` command, the usual `.pi` project folder, and the usual `~/.pi` user config, while bundling a few team defaults on top.

## What it includes

- the upstream `pi` experience and UI
- built-in LiteLLM support with automatic gateway selection
- bundled providers for `codex-openai` and `zai-coding-plan`
- bundled themes, including Catppuccin
- a bundled prompt set
- a small commentary mode helper for GPT-style models

## Default behavior

On install, this package seeds `~/.pi/agent/settings.json` if it does not already exist.

It does not overwrite an existing settings file.

## LiteLLM

This package tries the configured LiteLLM gateways in priority order and uses the first healthy one it finds.

## Usage

Run locally:

```bash
npm run pi
```

With a prompt:

```bash
npm run pi -- -p "hello"
```

## Remote mode (TCP control)

`pi --mode remote` exposes a pi agent session over a TCP socket using the same JSON line protocol as `pi --mode rpc`, letting other applications control pi over an SSH port-forward instead of stdio. No subprocess, no patch-package — the session runs in-process via the pi SDK. Supports multiple concurrent controllers with ping/pong heartbeat for dead-connection detection.

```bash
pi --mode remote --host 127.0.0.1 --port 0 --token <secret> [--remote-idle-timeout 300]
```

See [REMOTE.md](./REMOTE.md) for the full protocol, lifecycle, command surface, and client examples.

## Development

Build the package:

```bash
npm run build
```

This compiles the TypeScript sources, copies bundled resources, and generates the default settings JSON used by postinstall.

It also prepares `bin/pi.js` and `bin/pi.cmd`, and marks the Unix entrypoints executable.

## Upstream UI patches

This package carries a small UI patch on top of `@earendil-works/pi-coding-agent`.

Current patch:

- `patches/@earendil-works+pi-coding-agent+0.74.0.patch`

When upgrading pi again:

1. Inspect fresh installed files in `node_modules` and rerun targeted preview/harness tests before deleting a patch.
2. If patch still needed, regenerate `patches/` for current package scope and version.
3. Run:

```bash
npm run test:tool-preview
npm run test:harness
```

1. Rebuild and reload pi to verify the real runtime still matches the preview harness.

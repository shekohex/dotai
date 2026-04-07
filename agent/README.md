# @shekohex/agent

A small wrapper around `@mariozechner/pi-coding-agent`.

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

## Development

Build the package:

```bash
npm run build
```

This compiles the TypeScript sources, copies bundled resources, and generates the default settings JSON used by postinstall.

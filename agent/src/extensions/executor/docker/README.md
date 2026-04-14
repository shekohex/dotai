# Executor Extension

Built-in remote Executor integration.

## How It Works

- Pi ships a built-in Executor extension under `src/extensions/executor`
- it does not read project or global Executor config files
- it probes these MCP endpoints in order on every connect attempt:
  - `http://192.168.1.116:4788/mcp`
  - `http://100.100.1.116:4788/mcp`
- the first healthy endpoint wins
- session start auto-connects and emits Executor state events
- CoreUI listens to those events and renders a minimal `executor` footer badge only when connected
- tool calls use the resolved MCP endpoint directly

## Commands

```bash
/executor
/executor status
/executor web
```

## Docker Runtime

This directory contains a simple Dockerized Executor deployment fronted by Caddy.

### What It Does

- installs `executor` globally from npm
- starts `executor web` in the background
- runs Caddy as the main container process
- exposes Executor over HTTP on host port `4788` by default
- rewrites the `Host` header to `localhost` so Executor accepts proxied requests

### Files

- `Dockerfile` builds the image
- `Caddyfile` proxies HTTP traffic to the local Executor process
- `start.sh` launches Executor and then Caddy
- `compose.yaml` runs the container with persistent bind mounts

### Build

```bash
docker build \
  --build-arg EXECUTOR_VERSION=1.4.6 \
  -t dotai-executor-proxy \
  src/extensions/executor/docker
```

### Run With Docker

```bash
docker run --rm \
  -p 4788:80 \
  -v "$PWD/executor-data:/var/lib/executor" \
  -v "$PWD/executor-scope:/workspace" \
  dotai-executor-proxy
```

### Run With Compose

```bash
cd src/extensions/executor/docker
docker compose up -d --build
```

### Defaults

- `EXECUTOR_VERSION=latest`
- `EXECUTOR_HTTP_PORT=4788`
- `EXECUTOR_PORT=4788`
- state volume: `./executor-data`
- scope volume: `./executor-scope`

### Override Example

```bash
cd src/extensions/executor/docker
EXECUTOR_VERSION=1.4.6 EXECUTOR_HTTP_PORT=8090 docker compose up -d --build
```

### Endpoints

- `http://localhost:4788/`
- `http://localhost:4788/api/scope`
- `http://localhost:4788/mcp`

### Persistence

- `/var/lib/executor` stores Executor SQLite/state files
- `/workspace` is the Executor scope directory and can contain `executor.jsonc`

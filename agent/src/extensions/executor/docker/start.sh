#!/bin/sh
set -eu

mkdir -p "${EXECUTOR_DATA_DIR}" "${EXECUTOR_SCOPE_DIR}"

executor web --port "${EXECUTOR_PORT}" --scope "${EXECUTOR_SCOPE_DIR}" &

exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile

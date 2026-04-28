#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"


alice_private_key() {
  printf '%s\n' '-----BEGIN PRIVATE KEY-----' 'MC4CAQAwBQYDK2VwBCIEINB1KC9CGcvJ2KV9iSPqaE//4Bm2DIt+gBJrg2SZR92F' '-----END PRIVATE KEY-----'
}

alice_public_key() {
  printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'MCowBQYDK2VwAyEAwBaiRdMx2FzIJ7GWwV2WJ6hzSTdOgcM1+drtBJi5yFk=' '-----END PUBLIC KEY-----'
}

bob_private_key() {
  printf '%s\n' '-----BEGIN PRIVATE KEY-----' 'MC4CAQAwBQYDK2VwBCIEIEQj+94QqQCIhk9cZu3f1QZImRqS2pGnWaH46odpfusw' '-----END PRIVATE KEY-----'
}

bob_public_key() {
  printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'MCowBQYDK2VwAyEAq7FVQjj8SvIM6LrcTGetC3fkHWb1T+ihqhtnO/qsADY=' '-----END PUBLIC KEY-----'
}

charlie_private_key() {
  printf '%s\n' '-----BEGIN PRIVATE KEY-----' 'MC4CAQAwBQYDK2VwBCIEIB8D4huKrlgMcKFax253OcDJCY/LN0H2zauP/U3oWSPc' '-----END PRIVATE KEY-----'
}

charlie_public_key() {
  printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'MCowBQYDK2VwAyEAmen0ETg1yY2NTsqzBKFzXpIPALLKUovJuleOe7GGuv4=' '-----END PUBLIC KEY-----'
}

eve_private_key() {
  printf '%s\n' '-----BEGIN PRIVATE KEY-----' 'MC4CAQAwBQYDK2VwBCIEIObCzDlbjstE0ut3G9ELD4JEFVzu9MzauQ1DRvfh31fg' '-----END PRIVATE KEY-----'
}

eve_public_key() {
  printf '%s\n' '-----BEGIN PUBLIC KEY-----' 'MCowBQYDK2VwAyEAqAw3+HH+2YpF6HNq1rCw3RwRj7HgP7DYLH0vG3V/Z7k=' '-----END PUBLIC KEY-----'
}

usage() {
  cat <<EOF
Usage:
  npm run pi:server -- [--port 3141] [--host 0.0.0.0] [--origin http://IP:3141]
  npm run pi:remote -- --remote-url http://IP:3141 [--identity alice|bob|charlie|eve] [extra pi args]

Server defaults:
  --port    3141
  --host    0.0.0.0
  --origin  auto-picks first LAN IPv4, fallback http://127.0.0.1:PORT

Client defaults:
  --identity       alice

Client aliases:
  --remote-url     same as --remote-origin
  --remote         same as --remote-origin
  --key-id         same as --identity
EOF
}

build_allowed_keys_json() {
  local alice_public
  local bob_public
  local charlie_public
  alice_public="$(alice_public_key)"
  bob_public="$(bob_public_key)"
  charlie_public="$(charlie_public_key)"

  ALICE_PUBLIC="${alice_public}" \
  BOB_PUBLIC="${bob_public}" \
  CHARLIE_PUBLIC="${charlie_public}" \
  node --input-type=module <<'EOF'
const allowedKeys = {
  alice: process.env.ALICE_PUBLIC,
  bob: process.env.BOB_PUBLIC,
  charlie: process.env.CHARLIE_PUBLIC,
};
process.stdout.write(JSON.stringify(allowedKeys));
EOF
}

private_key_for_identity() {
  local identity="$1"
  case "$identity" in
    alice)
      alice_private_key
      ;;
    bob)
      bob_private_key
      ;;
    charlie)
      charlie_private_key
      ;;
    eve)
      eve_private_key
      ;;
    *)
      echo "identity must be alice, bob, charlie, or eve" >&2
      exit 1
      ;;
  esac
}

print_network_summary() {
  local port="$1"
  local origin="$2"

  node --input-type=module <<EOF
import os from 'node:os';

const port = ${port@Q};
const origin = ${origin@Q};
const interfaces = os.networkInterfaces();
const entries = [];

for (const [name, addresses] of Object.entries(interfaces)) {
  for (const address of addresses ?? []) {
    if (address.family !== 'IPv4' || address.internal) {
      continue;
    }
    entries.push({ name, address: address.address });
  }
}

console.log('origin: ' + origin);
console.log('listen: 0.0.0.0:' + port);
console.log('allowed identities: alice [default], bob, charlie');
console.log('rejected identity: eve');
if (entries.length === 0) {
  console.log('LAN IPv4: none found');
} else {
  console.log('LAN IPv4:');
  for (const entry of entries) {
    console.log('  ' + entry.name + ': http://' + entry.address + ':' + port);
  }
}
EOF
}

default_origin_for_port() {
  local port="$1"

  node --input-type=module <<EOF
import os from 'node:os';

const port = ${port@Q};
const interfaces = os.networkInterfaces();
for (const addresses of Object.values(interfaces)) {
  for (const address of addresses ?? []) {
    if (address.family === 'IPv4' && !address.internal) {
      process.stdout.write('http://' + address.address + ':' + port);
      process.exit(0);
    }
  }
}
process.stdout.write('http://127.0.0.1:' + port);
EOF
}

run_server() {
  local port="3141"
  local host="0.0.0.0"
  local origin=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --port)
        port="${2:-}"
        shift 2
        ;;
      --host)
        host="${2:-}"
        shift 2
        ;;
      --origin|--remote-url|--remote-origin)
        origin="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "unknown server arg: $1" >&2
        exit 1
        ;;
    esac
  done

  if [[ -z "${origin}" ]]; then
    origin="$(default_origin_for_port "${port}")"
  fi

  local allowed_keys_json
  allowed_keys_json="$(build_allowed_keys_json)"

  print_network_summary "${port}" "${origin}"
  echo ""
  echo "client examples:"
  echo "  npm run pi:remote -- --remote-url ${origin}"
  echo "  npm run pi:remote -- --remote-url ${origin} --identity bob"
  echo "  npm run pi:remote -- --remote-url ${origin} --identity charlie"
  echo "  npm run pi:remote -- --remote-url ${origin} --identity eve"
  echo ""

  cd "${ROOT_DIR}"
  PI_REMOTE_PORT="${port}" \
  PI_REMOTE_HOST="${host}" \
  PI_REMOTE_ORIGIN="${origin}" \
  PI_REMOTE_ALLOWED_KEYS="${allowed_keys_json}" \
  npm run remote
}

run_client() {
  local port="3141"
  local remote_origin=""
  local identity="alice"
  local -a passthrough_args=()

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --remote-url|--remote-origin|--remote)
        remote_origin="${2:-}"
        shift 2
        ;;
      --identity|--key-id|--remote-key-id)
        identity="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        passthrough_args+=("$1")
        shift
        ;;
    esac
  done

  if [[ -z "${remote_origin}" ]]; then
    remote_origin="$(default_origin_for_port "${port}")"
  fi

  case "${identity}" in
    alice|bob|charlie|eve)
      ;;
    *)
      echo "identity must be alice, bob, charlie, or eve" >&2
      exit 1
      ;;
  esac

  local private_key
  private_key="$(private_key_for_identity "${identity}")"

  cd "${ROOT_DIR}"
  PI_REMOTE_PRIVATE_KEY="${private_key}" \
  npm run pi -- \
    --mode-rush \
    --remote-origin "${remote_origin}" \
    --remote-key-id "${identity}" \
    "${passthrough_args[@]}"
}

main() {
  local mode="${1:-}"
  if [[ -z "${mode}" ]]; then
    usage
    exit 1
  fi
  shift

  case "${mode}" in
    server)
      run_server "$@"
      ;;
    client)
      run_client "$@"
      ;;
    -h|--help|help)
      usage
      ;;
    *)
      echo "unknown mode: ${mode}" >&2
      exit 1
      ;;
  esac
}

main "$@"

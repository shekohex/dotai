#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SCRIPT="$ROOT_DIR/install.sh"
PROFILE_SOURCE="$ROOT_DIR/.codex/paseo-codex-profile.py"

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

run_profile_install() {
  local home_directory="$1"
  HOME="$home_directory" bash -c 'source "$1"; install_codex_profile_wrapper' _ "$INSTALL_SCRIPT"
}

test_installs_executable_profile_and_idempotent_symlink() {
  local temporary_home launcher installed_profile backup_count
  temporary_home="$(mktemp -d)"
  launcher="$temporary_home/.local/bin/paseo-codex-profile"
  installed_profile="$temporary_home/.codex/paseo-codex-profile.py"

  mkdir -p "$temporary_home/.local/bin"
  printf 'unrelated\n' > "$temporary_home/.local/bin/unrelated"
  run_profile_install "$temporary_home"

  [[ -L "$launcher" ]] || fail "installer should create launcher symlink"
  [[ "$(readlink "$launcher")" == "$installed_profile" ]] || fail "launcher target mismatch"
  cmp -s "$PROFILE_SOURCE" "$installed_profile" || fail "installed profile differs from source"
  [[ -x "$installed_profile" ]] || fail "installed profile should be executable"
  [[ -f "$temporary_home/.local/bin/unrelated" ]] || fail "unrelated file was removed"

  backup_count="$(find "$temporary_home/.local/bin" -maxdepth 1 -type f -name 'paseo-codex-profile.backup.*' | wc -l)"
  run_profile_install "$temporary_home"
  [[ "$(find "$temporary_home/.local/bin" -maxdepth 1 -type f -name 'paseo-codex-profile.backup.*' | wc -l)" == "$backup_count" ]] || \
    fail "idempotent install should not create a backup"
}

test_updates_managed_copy_and_backs_up_existing_launcher() {
  local temporary_home launcher installed_profile backup_path
  temporary_home="$(mktemp -d)"
  launcher="$temporary_home/.local/bin/paseo-codex-profile"
  installed_profile="$temporary_home/.codex/paseo-codex-profile.py"

  mkdir -p "$temporary_home/.local/bin"
  printf '#!/bin/sh\nold wrapper\n' > "$launcher"
  chmod +x "$launcher"
  run_profile_install "$temporary_home"

  backup_path="$(find "$temporary_home/.local/bin" -maxdepth 1 -type f -name 'paseo-codex-profile.backup.*' -print -quit)"
  [[ -n "$backup_path" ]] || fail "installer should back up existing launcher"
  cmp -s "$backup_path" <(printf '#!/bin/sh\nold wrapper\n') || fail "launcher backup differs"

  printf 'stale installed copy\n' > "$installed_profile"
  run_profile_install "$temporary_home"
  cmp -s "$PROFILE_SOURCE" "$installed_profile" || fail "installer should update installed profile"
  [[ -L "$launcher" ]] || fail "updated launcher should remain symlink"
}

test_refuses_launcher_directory_without_touching_it() {
  local temporary_home launcher marker
  temporary_home="$(mktemp -d)"
  launcher="$temporary_home/.local/bin/paseo-codex-profile"
  marker="$launcher/keep"
  mkdir -p "$launcher"
  printf 'keep\n' > "$marker"

  if run_profile_install "$temporary_home" >/dev/null 2>&1; then
    fail "installer should refuse launcher directory"
  fi
  [[ -f "$marker" ]] || fail "launcher directory contents changed"
  [[ ! -e "$temporary_home/.codex/paseo-codex-profile.py" ]] || fail "failed install should not copy profile"
}

test_installs_executable_profile_and_idempotent_symlink
test_updates_managed_copy_and_backs_up_existing_launcher
test_refuses_launcher_directory_without_touching_it

printf 'PASS\n'

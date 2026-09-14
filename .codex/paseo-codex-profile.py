#!/usr/bin/env python3
"""Launch Codex app-server with one of the bundled profile layers."""

from __future__ import annotations

import json
import os
import re
import shutil
import sys
import tomllib
from collections.abc import Iterator
from pathlib import Path
from typing import NoReturn


PROFILE_FILES = {
    "litellm": "litellm.config.toml",
    "opencode-go": "opencode-go.config.toml",
}
SAFE_TOML_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
EXIT_USAGE = 64


def fail(message: str) -> NoReturn:
    print(f"paseo-codex-profile: {message}", file=sys.stderr)
    raise SystemExit(EXIT_USAGE)


def resolve_codex_home() -> Path:
    configured_home = os.environ.get("CODEX_HOME")
    home = Path(configured_home).expanduser() if configured_home else Path.home() / ".codex"
    return home.resolve()


def resolve_codex_binary() -> Path:
    codex_command = shutil.which("codex")
    if codex_command is None:
        fail("codex was not found on PATH; install Codex or fix PATH")

    codex_binary = Path(codex_command).resolve()
    if codex_binary == Path(__file__).resolve():
        fail("refusing recursive codex launch; remove wrapper from codex PATH entry")
    return codex_binary


def toml_key(key: str) -> str:
    return key if SAFE_TOML_KEY.fullmatch(key) else json.dumps(key)


def toml_value(value: object) -> str:
    if isinstance(value, (str, bool, int, float)):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, list) and all(
        isinstance(item, (str, bool, int, float)) for item in value
    ):
        return json.dumps(value, ensure_ascii=False)
    fail(f"unsupported TOML value type: {type(value).__name__}")


def iter_overrides(
    table: dict[str, object], prefix: tuple[str, ...] = ()
) -> Iterator[tuple[str, str]]:
    for key, value in table.items():
        path = (*prefix, key)
        if isinstance(value, dict):
            yield from iter_overrides(value, path)
        else:
            yield ".".join(toml_key(part) for part in path), toml_value(value)


def resolve_config_path(value: str, codex_home: Path, base_directory: Path) -> str:
    if value == "~/.codex":
        path = codex_home
    elif value.startswith("~/.codex/"):
        path = codex_home / value.removeprefix("~/.codex/")
    else:
        path = Path(value).expanduser()

    if not path.is_absolute():
        path = base_directory / path
    return str(path.resolve())


def resolve_profile_paths(
    table: dict[str, object], codex_home: Path, profile_file: Path
) -> None:
    for key, value in table.items():
        if isinstance(value, dict):
            resolve_profile_paths(value, codex_home, profile_file)
        elif key in {"cwd", "model_catalog_json"} and isinstance(value, str):
            table[key] = resolve_config_path(value, codex_home, profile_file.parent)


def read_profile(profile_name: str, codex_home: Path) -> tuple[Path, dict[str, object]]:
    profile_file = codex_home / PROFILE_FILES[profile_name]
    if not profile_file.is_file():
        fail(f"profile file is missing: {profile_file}")

    try:
        with profile_file.open("rb") as profile_stream:
            profile_config = tomllib.load(profile_stream)
    except (OSError, tomllib.TOMLDecodeError) as error:
        fail(f"cannot read profile {profile_file}: {error}")

    resolve_profile_paths(profile_config, codex_home, profile_file)
    return profile_file, profile_config


def build_command(arguments: list[str]) -> list[str]:
    if len(arguments) < 3:
        fail("usage: paseo-codex-profile <profile> app-server [args...]")

    profile_name = arguments[1]
    if profile_name not in PROFILE_FILES:
        fail(f"unsupported profile: {profile_name}")

    codex_binary = resolve_codex_binary()
    if arguments[2] == "--version":
        return [str(codex_binary), *arguments[2:]]
    if arguments[2] != "app-server":
        fail("Paseo must append app-server as first launch argument")

    codex_home = resolve_codex_home()
    _, profile_config = read_profile(profile_name, codex_home)
    command = [str(codex_binary), "app-server"]
    for key, value in iter_overrides(profile_config):
        command.extend(("--config", f"{key}={value}"))
    command.extend(arguments[3:])
    return command


def main() -> None:
    command = build_command(sys.argv)
    try:
        os.execv(command[0], command)
    except OSError as error:
        fail(f"could not launch Codex at {command[0]}: {error}")


if __name__ == "__main__":
    main()

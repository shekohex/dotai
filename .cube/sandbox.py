#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "boto3==1.43.96",
#   "botocore==1.43.96",
#   "cubesandbox==0.7.0",
# ]
# ///
"""Build, deploy, and operate this project's CubeSandbox template."""

# Adapted from shekohex/cubesandbox-pve at
# 774d85b8c4aa06d63085845ff064efe26aec00b6.

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import TypeVar

import boto3
from boto3.exceptions import S3UploadFailedError
from botocore.config import Config as S3ClientConfig
from botocore.exceptions import BotoCoreError, ClientError
from cubesandbox import Config, CubeSandboxError, Sandbox, Template, Volume, VolumeMount

# Keep the invocation path when this CLI is symlinked into another project.
PROJECT_ROOT = Path(__file__).absolute().parent.parent
SHA256_DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
TRUE_VALUES = {"1", "true", "yes", "on"}
FALSE_VALUES = {"0", "false", "no", "off"}
OptionValue = TypeVar("OptionValue")


@dataclass(frozen=True)
class ProjectSettings:
    project_id: str
    template_alias: str
    registry: str
    base_image: str
    image_repository: str
    cube_api_url: str
    sandbox_domain: str
    repository: str
    git_ref: str
    workspace: str
    pi_auth_file: str
    codex_auth_file: str
    paseo_config_file: str
    ssh_auth_key: str
    ssh_known_hosts_file: str
    dockerfile: str
    build_context: str
    cpu_millicores: int
    memory_mb: int
    writable_layer_size: str
    idle_timeout_seconds: int
    on_timeout: str
    preview_ports: list[int]


@dataclass(frozen=True)
class RuntimeFile:
    destination: str
    contents: str
    mode: int


@dataclass(frozen=True)
class RuntimeGitIdentity:
    user_name: str
    user_email: str
    auth_key_path: str
    signing_key_path: str
    known_hosts_path: str


@dataclass(frozen=True)
class RuntimeIdentityBundle:
    files: tuple[RuntimeFile, ...]
    git: RuntimeGitIdentity


@dataclass(frozen=True)
class DeploySettings:
    image_ref: str | None
    image_tag: str
    build_platform: str
    dockerfile: Path
    build_context: Path
    build_arguments: list[str]
    wait_timeout: int
    writable_layer_size: str
    exposed_ports: list[int]
    probe_port: int
    probe_path: str
    cpu_millicores: int
    memory_mb: int
    template_environment: dict[str, str]
    allow_internet_access: bool
    network_type: str


def environment_value(name: str) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else None


def resolve_string(cli_value: str | None, environment_name: str, default: str) -> str:
    return (
        cli_value
        if cli_value is not None
        else environment_value(environment_name) or default
    )


def resolve_integer(cli_value: int | None, environment_name: str, default: int) -> int:
    if cli_value is not None:
        return cli_value
    value = environment_value(environment_name)
    try:
        return int(value) if value is not None else default
    except ValueError as error:
        raise ValueError(f"{environment_name} must be an integer") from error


def positive_integer(value: str) -> int:
    integer = int(value)
    if integer <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return integer


def resolve_positive_integer(
    cli_value: int | None, environment_name: str, default: int
) -> int:
    value = resolve_integer(cli_value, environment_name, default)
    if value <= 0:
        raise ValueError(f"{environment_name} must be a positive integer")
    return value


def resolve_boolean(
    cli_value: bool | None, environment_name: str, default: bool
) -> bool:
    if cli_value is not None:
        return cli_value
    value = environment_value(environment_name)
    if value is None:
        return default
    normalized = value.lower()
    if normalized in TRUE_VALUES:
        return True
    if normalized in FALSE_VALUES:
        return False
    raise ValueError(
        f"{environment_name} must be one of: {', '.join(sorted(TRUE_VALUES | FALSE_VALUES))}"
    )


def resolve_list(
    cli_values: list[OptionValue] | None,
    environment_name: str,
    default: list[OptionValue],
    converter: type[OptionValue] = str,
) -> list[OptionValue]:
    if cli_values is not None:
        return cli_values
    value = environment_value(environment_name)
    if value is None:
        return default
    try:
        return [converter(item.strip()) for item in value.split(",") if item.strip()]
    except ValueError as error:
        raise ValueError(f"{environment_name} contains an invalid value") from error


def project_path(value: str) -> Path:
    path = Path(value)
    return path if path.is_absolute() else PROJECT_ROOT / path


def parse_key_value(specification: str, option_name: str) -> tuple[str, str]:
    key, separator, value = specification.partition("=")
    if not separator or not key or not value:
        raise ValueError(f"{option_name} must use KEY=VALUE syntax: {specification!r}")
    return key, value


def parse_key_value_list(specifications: list[str], option_name: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for specification in specifications:
        key, value = parse_key_value(specification, option_name)
        if key in values:
            raise ValueError(f"duplicate {option_name} key: {key}")
        values[key] = value
    return values


def add_volume_mounts(
    mounts: dict[str, str | VolumeMount],
    specifications: list[str],
    *,
    read_only: bool,
) -> None:
    option_name = "read-only mount" if read_only else "mount"
    for specification in specifications:
        sandbox_path, volume_id = parse_key_value(specification, option_name)
        if not sandbox_path.startswith("/") or sandbox_path == "/":
            raise ValueError(
                f"sandbox mount path must be absolute and not root: {sandbox_path!r}"
            )
        if sandbox_path in mounts:
            raise ValueError(f"duplicate sandbox mount path: {sandbox_path}")
        mounts[sandbox_path] = (
            VolumeMount(volume_id, read_only=True) if read_only else volume_id
        )


def parse_volume_mounts(
    writable_specifications: list[str],
    read_only_specifications: list[str],
) -> dict[str, str | VolumeMount]:
    mounts: dict[str, str | VolumeMount] = {}
    add_volume_mounts(mounts, writable_specifications, read_only=False)
    add_volume_mounts(mounts, read_only_specifications, read_only=True)
    return mounts


def volume_destination(value: str) -> PurePosixPath:
    destination = PurePosixPath(value)
    if not destination.is_absolute() or ".." in destination.parts:
        raise ValueError("volume destination must be an absolute path without '..'")
    return destination


def normalized_api_url(value: str, source: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError(f"{source} must use http or https with a hostname")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError(f"{source} must not contain credentials, query, or fragment")
    if parsed.path not in {"", "/"}:
        raise ValueError(f"{source} must not contain a path")
    return value.rstrip("/")


def normalized_sandbox_domain(value: str, source: str) -> str:
    if not value or value != value.strip() or value.endswith("."):
        raise ValueError(f"{source} must be a canonical hostname")
    parsed = urlsplit(f"https://{value}")
    if parsed.hostname != value.lower() or parsed.netloc != value.lower():
        raise ValueError(f"{source} must be a canonical hostname")
    return parsed.hostname


def load_project_config() -> dict[str, object]:
    config_path = PROJECT_ROOT / ".cube" / "config.json"
    try:
        config = json.loads(config_path.read_text())
    except (OSError, json.JSONDecodeError) as error:
        raise RuntimeError(f"cannot load CubeSandbox config: {config_path}") from error
    if not isinstance(config, dict) or config.get("version") != 1:
        raise ValueError(".cube/config.json must be a version 1 object")
    return config


def required_config_object(config: dict[str, object], name: str) -> dict[str, object]:
    value = config.get(name)
    if not isinstance(value, dict):
        raise ValueError(f".cube/config.json {name} must be an object")
    return value


def required_config_value(config: dict[str, object], name: str, expected: type):
    value = config.get(name)
    if not isinstance(value, expected):
        raise ValueError(f".cube/config.json {name} must be {expected.__name__}")
    return value


def load_project_settings(args: argparse.Namespace) -> ProjectSettings:
    config = load_project_config()
    project = required_config_object(config, "project")
    cube = required_config_object(config, "cube")
    template = required_config_object(config, "template")
    resources = required_config_object(template, "resources")
    sandbox = required_config_object(config, "sandbox")
    configured_api_url = normalized_api_url(
        required_config_value(cube, "apiUrl", str), "Project cube.apiUrl"
    )
    trusted_api_url = normalized_api_url(
        environment_value("CUBE_API_URL") or "https://sandbox.0iq.xyz",
        "Trusted CUBE_API_URL",
    )
    if configured_api_url != trusted_api_url:
        raise ValueError(
            f"Project cube.apiUrl {configured_api_url!r} does not match trusted CUBE_API_URL {trusted_api_url!r}"
        )
    configured_domain = normalized_sandbox_domain(
        required_config_value(cube, "sandboxDomain", str),
        "Project cube.sandboxDomain",
    )
    trusted_domain = normalized_sandbox_domain(
        environment_value("CUBE_SANDBOX_DOMAIN") or "sbx.0iq.xyz",
        "Trusted CUBE_SANDBOX_DOMAIN",
    )
    if configured_domain != trusted_domain:
        raise ValueError(
            f"Project cube.sandboxDomain {configured_domain!r} does not match trusted CUBE_SANDBOX_DOMAIN {trusted_domain!r}"
        )
    template_alias = resolve_string(
        args.template_alias,
        "CUBE_TEMPLATE_ALIAS",
        required_config_value(template, "alias", str),
    )
    registry = resolve_string(args.registry, "CUBE_REGISTRY", "bbcr.0iq.xyz")
    return ProjectSettings(
        project_id=required_config_value(project, "id", str),
        template_alias=template_alias,
        registry=registry,
        base_image=resolve_string(
            args.base_image,
            "CUBE_BASE_IMAGE",
            f"{registry}/hakim/cube-hakim-js:71a7eaf6d746-20260917122636",
        ),
        image_repository=resolve_string(
            args.image_repository,
            "CUBE_IMAGE_REPOSITORY",
            f"{registry}/projects/{template_alias}",
        ),
        cube_api_url=trusted_api_url,
        sandbox_domain=trusted_domain,
        repository=resolve_string(
            args.repository,
            "CUBE_GITHUB_REPOSITORY",
            required_config_value(project, "repository", str),
        ),
        git_ref=resolve_string(
            args.git_ref,
            "CUBE_GIT_REF",
            required_config_value(project, "defaultRef", str),
        ),
        workspace=resolve_string(
            args.workspace,
            "CUBE_WORKSPACE",
            required_config_value(project, "workspacePath", str),
        ),
        pi_auth_file=resolve_string(
            args.pi_auth_file,
            "CUBE_PI_AUTH_FILE",
            "~/.pi/agent/auth.json",
        ),
        codex_auth_file=resolve_string(
            args.codex_auth_file,
            "CUBE_CODEX_AUTH_FILE",
            "~/.codex/auth.json",
        ),
        paseo_config_file=resolve_string(
            args.paseo_config_file,
            "CUBE_PASEO_CONFIG_FILE",
            "~/.paseo/config.json",
        ),
        ssh_auth_key=resolve_string(
            args.ssh_auth_key,
            "CUBE_SSH_AUTH_KEY",
            "~/.ssh/id_ed25519",
        ),
        ssh_known_hosts_file=resolve_string(
            args.ssh_known_hosts_file,
            "CUBE_SSH_KNOWN_HOSTS_FILE",
            "~/.ssh/known_hosts",
        ),
        dockerfile=required_config_value(template, "dockerfile", str),
        build_context=required_config_value(template, "buildContext", str),
        cpu_millicores=required_config_value(resources, "cpuMillicores", int),
        memory_mb=required_config_value(resources, "memoryMb", int),
        writable_layer_size=required_config_value(resources, "writableLayerSize", str),
        idle_timeout_seconds=required_config_value(sandbox, "idleTimeoutSeconds", int),
        on_timeout=required_config_value(sandbox, "onTimeout", str),
        preview_ports=required_config_value(sandbox, "previewPorts", list),
    )


def load_deploy_settings(
    args: argparse.Namespace, project_settings: ProjectSettings
) -> DeploySettings:
    exposed_ports = resolve_list(args.exposed_ports, "CUBE_EXPOSED_PORTS", [49983], int)
    build_arguments = resolve_list(args.build_arguments, "CUBE_BUILD_ARGS", [])
    template_environment_specs = resolve_list(
        args.template_environment,
        "CUBE_TEMPLATE_ENV",
        [],
    )
    return DeploySettings(
        image_ref=args.image_ref or environment_value("CUBE_IMAGE_REF"),
        image_tag=resolve_string(
            args.image_tag,
            "CUBE_IMAGE_TAG",
            datetime.now(UTC).strftime("%Y%m%d%H%M%S"),
        ),
        build_platform=resolve_string(
            args.build_platform, "CUBE_BUILD_PLATFORM", "linux/amd64"
        ),
        dockerfile=project_path(
            resolve_string(
                args.dockerfile, "CUBE_DOCKERFILE", project_settings.dockerfile
            )
        ),
        build_context=project_path(
            resolve_string(
                args.build_context,
                "CUBE_BUILD_CONTEXT",
                project_settings.build_context,
            )
        ),
        build_arguments=build_arguments,
        wait_timeout=resolve_integer(
            args.wait_timeout, "CUBE_TEMPLATE_WAIT_TIMEOUT", 1800
        ),
        writable_layer_size=resolve_string(
            args.writable_layer_size,
            "CUBE_WRITABLE_LAYER_SIZE",
            project_settings.writable_layer_size,
        ),
        exposed_ports=exposed_ports,
        probe_port=resolve_integer(args.probe_port, "CUBE_PROBE_PORT", 49983),
        probe_path=resolve_string(args.probe_path, "CUBE_PROBE_PATH", "/health"),
        cpu_millicores=resolve_integer(
            args.cpu_millicores,
            "CUBE_CPU_MILLICORES",
            project_settings.cpu_millicores,
        ),
        memory_mb=resolve_integer(
            args.memory_mb, "CUBE_MEMORY_MB", project_settings.memory_mb
        ),
        template_environment=parse_key_value_list(
            template_environment_specs,
            "template environment",
        ),
        allow_internet_access=resolve_boolean(
            args.allow_internet_access,
            "CUBE_ALLOW_INTERNET_ACCESS",
            True,
        ),
        network_type=resolve_string(args.network_type, "CUBE_NETWORK_TYPE", "tap"),
    )


def cube_config(settings: ProjectSettings) -> Config:
    return Config(
        api_url=settings.cube_api_url,
        api_key=os.environ.get("CUBE_API_KEY"),
        sandbox_domain=settings.sandbox_domain,
    )


def run(command: list[str], *, environment: dict[str, str] | None = None) -> None:
    print("+", " ".join(command), flush=True)
    subprocess.run(
        command,
        cwd=PROJECT_ROOT,
        env=environment,
        check=True,
    )


def resolve_github_token() -> str:
    for environment_name in ("GITHUB_TOKEN", "GH_TOKEN"):
        token = environment_value(environment_name)
        if token:
            return token

    try:
        result = subprocess.run(
            ["gh", "auth", "token"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        raise RuntimeError(
            "GitHub token unavailable; set GITHUB_TOKEN or authenticate gh"
        ) from error

    token = result.stdout.strip()
    if not token:
        raise RuntimeError("gh auth token returned an empty token")
    return token


def optional_github_token() -> str | None:
    try:
        return resolve_github_token()
    except RuntimeError:
        return None


def required_git_config(key: str, *, boolean: bool = False) -> str:
    command = ["git", "-C", str(PROJECT_ROOT), "config"]
    if boolean:
        command.append("--type=bool")
    command.extend(["--get", key])
    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        raise RuntimeError(
            f"effective Git configuration is missing or invalid: {key}"
        ) from error
    value = result.stdout.strip()
    if not value:
        raise RuntimeError(f"effective Git configuration is empty: {key}")
    return value


def required_json_file(path_value: str, label: str) -> str:
    file_path = Path(path_value).expanduser()
    if not file_path.is_file():
        raise RuntimeError(f"{label} file does not exist: {file_path}")
    contents = file_path.read_text()
    try:
        parsed = json.loads(contents)
    except json.JSONDecodeError as error:
        raise RuntimeError(f"{label} file is not valid JSON: {file_path}") from error
    if not isinstance(parsed, dict):
        raise RuntimeError(f"{label} file must contain a JSON object: {file_path}")
    return contents


def expand_configured_path(path_value: str, label: str) -> Path:
    if ".." in PurePosixPath(path_value.replace("\\", "/")).parts:
        raise RuntimeError(f"{label} must not contain path traversal")
    if path_value == "~":
        return Path.home()
    if path_value.startswith("~/"):
        return Path.home() / path_value[2:]
    configured_path = Path(path_value)
    if not configured_path.is_absolute():
        raise RuntimeError(f"{label} must use an absolute path or ~/ prefix")
    return configured_path


def read_allowlisted_ssh_file(path_value: str, label: str) -> tuple[Path, str, str]:
    ssh_directory = Path.home() / ".ssh"
    source_path = expand_configured_path(path_value, label)
    try:
        ssh_directory_metadata = ssh_directory.lstat()
    except FileNotFoundError as error:
        raise RuntimeError(f"SSH directory does not exist: {ssh_directory}") from error
    if stat.S_ISLNK(ssh_directory_metadata.st_mode):
        raise RuntimeError(
            f"SSH directory must not be a symbolic link: {ssh_directory}"
        )
    if not stat.S_ISDIR(ssh_directory_metadata.st_mode):
        raise RuntimeError(f"SSH directory must be a directory: {ssh_directory}")
    try:
        relative_path = source_path.relative_to(ssh_directory)
    except ValueError as error:
        raise RuntimeError(f"{label} must be inside {ssh_directory}") from error
    if not relative_path.parts:
        raise RuntimeError(f"{label} must name a file inside {ssh_directory}")
    if relative_path.name in {"authorized_keys", "known_hosts.old"}:
        raise RuntimeError(
            f"{label} must not use disallowed SSH file {relative_path.name}"
        )
    current_path = ssh_directory
    for part in relative_path.parts:
        current_path /= part
        try:
            metadata = current_path.lstat()
        except FileNotFoundError as error:
            raise RuntimeError(f"{label} does not exist: {source_path}") from error
        if stat.S_ISLNK(metadata.st_mode):
            raise RuntimeError(f"{label} must not be a symbolic link: {current_path}")
    if not source_path.is_file():
        raise RuntimeError(f"{label} must be a regular file")
    return source_path, relative_path.as_posix(), source_path.read_text()


def load_ssh_key_pair(
    private_key_value: str, label: str
) -> tuple[RuntimeFile, RuntimeFile]:
    private_path, private_relative, private_contents = read_allowlisted_ssh_file(
        private_key_value, f"{label} private key"
    )
    _, public_relative, public_contents = read_allowlisted_ssh_file(
        f"{private_key_value}.pub", f"{label} public key"
    )
    if stat.S_IMODE(private_path.stat().st_mode) & 0o077:
        raise RuntimeError(
            f"{label} private key permissions must not grant group or other access"
        )
    if not private_contents.startswith("-----BEGIN OPENSSH PRIVATE KEY-----"):
        raise RuntimeError(f"{label} private key must use OpenSSH private-key format")
    public_fields = public_contents.strip().split()[:2]
    if len(public_fields) != 2 or not public_fields[0].startswith("ssh-"):
        raise RuntimeError(f"{label} public key is invalid")
    try:
        derived_fields = (
            subprocess.run(
                ["ssh-keygen", "-y", "-f", str(private_path)],
                check=True,
                capture_output=True,
                text=True,
            )
            .stdout.strip()
            .split()[:2]
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        raise RuntimeError(f"{label} private key could not be validated") from error
    if derived_fields != public_fields:
        raise RuntimeError(f"{label} private and public keys do not match")
    return (
        RuntimeFile(f"/home/coder/.ssh/{private_relative}", private_contents, 0o600),
        RuntimeFile(f"/home/coder/.ssh/{public_relative}", public_contents, 0o644),
    )


def load_github_known_hosts(path_value: str) -> RuntimeFile:
    source_path, _, _ = read_allowlisted_ssh_file(path_value, "GitHub known_hosts")
    try:
        output = subprocess.run(
            ["ssh-keygen", "-F", "github.com", "-f", str(source_path)],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
    except (FileNotFoundError, subprocess.CalledProcessError) as error:
        raise RuntimeError(
            f"GitHub known_hosts has no usable github.com entry: {source_path}"
        ) from error
    github_entries = [
        line for line in output.splitlines() if line and not line.startswith("#")
    ]
    if not github_entries:
        raise RuntimeError(
            f"GitHub known_hosts has no usable github.com entry: {source_path}"
        )
    return RuntimeFile(
        "/home/coder/.ssh/known_hosts", "\n".join(github_entries) + "\n", 0o600
    )


def runtime_identity_bundle(settings: ProjectSettings) -> RuntimeIdentityBundle:
    user_name = required_git_config("user.name")
    user_email = required_git_config("user.email")
    if required_git_config("gpg.format") != "ssh":
        raise RuntimeError("effective Git gpg.format must be ssh")
    if required_git_config("commit.gpgsign", boolean=True) != "true":
        raise RuntimeError("effective Git commit.gpgsign must be true")
    signing_key = required_git_config("user.signingkey")
    if signing_key.endswith(".pub"):
        raise RuntimeError(
            "effective Git user.signingkey must point to a private key because ssh-agent signing is unavailable"
        )
    auth_files = load_ssh_key_pair(settings.ssh_auth_key, "SSH auth")
    signing_files = load_ssh_key_pair(signing_key, "Git signing")
    known_hosts = load_github_known_hosts(settings.ssh_known_hosts_file)
    files = (
        RuntimeFile(
            "/home/coder/.pi/agent/auth.json",
            required_json_file(settings.pi_auth_file, "Pi auth"),
            0o600,
        ),
        RuntimeFile(
            "/home/coder/.codex/auth.json",
            required_json_file(settings.codex_auth_file, "Codex auth"),
            0o600,
        ),
        RuntimeFile(
            "/home/coder/.paseo/config.json",
            required_json_file(settings.paseo_config_file, "Paseo config"),
            0o600,
        ),
        *auth_files,
        *signing_files,
        known_hosts,
    )
    unique_files = {file.destination: file for file in files}
    if len(unique_files) != len(files):
        for file in files:
            existing = unique_files[file.destination]
            if existing.contents != file.contents or existing.mode != file.mode:
                raise RuntimeError(
                    f"runtime identity destinations conflict: {file.destination}"
                )
    return RuntimeIdentityBundle(
        tuple(unique_files.values()),
        RuntimeGitIdentity(
            user_name=user_name,
            user_email=user_email,
            auth_key_path=auth_files[0].destination,
            signing_key_path=signing_files[0].destination,
            known_hosts_path=known_hosts.destination,
        ),
    )


def publish_image(
    project_settings: ProjectSettings,
    deploy_settings: DeploySettings,
) -> str:
    dotai_refs = [
        value.partition("=")[2]
        for value in deploy_settings.build_arguments
        if value.startswith("DOTAI_REF=")
    ]
    if len(dotai_refs) != 1 or not re.fullmatch(r"[0-9a-f]{40}", dotai_refs[0]):
        raise ValueError(
            "deploy requires exactly one --build-arg DOTAI_REF=<40-character lowercase commit SHA>"
        )
    tagged_image = f"{project_settings.image_repository}:{deploy_settings.image_tag}"
    metadata_path: Path | None = None

    try:
        with tempfile.NamedTemporaryFile(
            prefix="cube-build-", suffix=".json", delete=False
        ) as file:
            metadata_path = Path(file.name)

        command = [
            "docker",
            "buildx",
            "build",
            "--platform",
            deploy_settings.build_platform,
            "--file",
            str(deploy_settings.dockerfile),
            "--build-arg",
            f"CUBE_BASE_IMAGE={project_settings.base_image}",
        ]
        for build_argument in deploy_settings.build_arguments:
            parse_key_value(build_argument, "build argument")
            command.extend(["--build-arg", build_argument])
        command.extend(
            [
                "--tag",
                tagged_image,
                "--push",
                "--metadata-file",
                str(metadata_path),
                str(deploy_settings.build_context),
            ]
        )
        run(command)

        metadata = json.loads(metadata_path.read_text())
        digest = str(metadata.get("containerimage.digest", ""))
        if not SHA256_DIGEST.fullmatch(digest):
            raise RuntimeError(f"Docker returned invalid image digest: {digest!r}")
        return f"{project_settings.image_repository}@{digest}"
    finally:
        if metadata_path:
            metadata_path.unlink(missing_ok=True)


def wait_for_template(
    config: Config,
    template_id: str,
    build_id: str,
    timeout_seconds: int,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        build = Template.get_build_status(template_id, build_id, config=config)
        status = build.status.upper()
        print(
            f"template={template_id} status={status} progress={build.progress}",
            flush=True,
        )
        if status == "READY":
            return
        if status in {"FAILED", "ERROR", "CANCELLED"}:
            message = build.error_message or build.message
            raise RuntimeError(f"template build {status}: {message}")
        time.sleep(2)
    raise RuntimeError(f"template build timed out after {timeout_seconds}s")


def deploy_template(
    project_settings: ProjectSettings,
    deploy_settings: DeploySettings,
    image_ref: str,
) -> None:
    if not re.search(r"@sha256:[0-9a-f]{64}$", image_ref):
        raise ValueError("template image must use an immutable @sha256 digest")

    config = cube_config(project_settings)
    previous_template = next(
        (
            template
            for template in Template.list(config=config)
            if template.name == project_settings.template_alias
        ),
        None,
    )
    build = Template.build(
        image=image_ref,
        writable_layer_size=deploy_settings.writable_layer_size,
        exposed_ports=deploy_settings.exposed_ports,
        probe_port=deploy_settings.probe_port,
        probe_path=deploy_settings.probe_path,
        cpu_count=deploy_settings.cpu_millicores,
        memory_mb=deploy_settings.memory_mb,
        envs=deploy_settings.template_environment,
        allow_internet_access=deploy_settings.allow_internet_access,
        network_type=deploy_settings.network_type,
        config=config,
    )
    wait_for_template(
        config,
        build.template_id,
        build.build_id,
        deploy_settings.wait_timeout,
    )
    Template.set_alias(
        build.template_id,
        project_settings.template_alias,
        config=config,
    )

    print(f"template={build.template_id}")
    print(f"alias={project_settings.template_alias}")
    print(f"image={image_ref}")
    if previous_template:
        print(f"rollback_template={previous_template.template_id}")


def forwarded_environment(variable_names: list[str]) -> dict[str, str]:
    missing = [name for name in variable_names if name not in os.environ]
    if missing:
        raise ValueError(f"missing environment variables: {', '.join(missing)}")
    return {name: os.environ[name] for name in variable_names}


def run_sandbox_command(
    sandbox: Sandbox,
    command: str,
    *,
    cwd: str | None = None,
    timeout: int = 300,
    environment: dict[str, str] | None = None,
    user: str = "coder",
) -> None:
    result = sandbox.commands.run(
        command,
        user=user,
        cwd=cwd,
        envs=environment or {},
        timeout=timeout,
    )
    if result.stdout:
        print(result.stdout, end="")
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    if result.exit_code != 0:
        raise RuntimeError(f"sandbox command failed with exit code {result.exit_code}")


def bootstrap_repository(
    sandbox: Sandbox,
    settings: ProjectSettings,
    runtime_environment: dict[str, str],
) -> None:
    runtime_identity = runtime_identity_bundle(settings)
    workspace = shlex.quote(settings.workspace)
    repository = shlex.quote(settings.repository)
    git_ref = shlex.quote(settings.git_ref)
    ssh_repository = shlex.quote(f"git@github.com:{settings.repository}.git")

    runtime_directories = sorted(
        {str(PurePosixPath(file.destination).parent) for file in runtime_identity.files}
    )
    prepare_commands = [
        "set -euo pipefail",
        "install -d -m 0700 "
        + " ".join(shlex.quote(directory) for directory in runtime_directories),
        *(
            f"install -m {file.mode:04o} /dev/null {shlex.quote(file.destination)}"
            for file in runtime_identity.files
        ),
    ]
    run_sandbox_command(sandbox, "\n".join(prepare_commands))
    for file in runtime_identity.files:
        sandbox.files.write(file.destination, file.contents, user="coder")

    ssh_command = (
        f"ssh -i {runtime_identity.git.auth_key_path} "
        "-o IdentitiesOnly=yes -o StrictHostKeyChecking=yes "
        f"-o UserKnownHostsFile={runtime_identity.git.known_hosts_path}"
    )
    configuration_commands = [
        "set -euo pipefail",
        *(
            f"chmod {file.mode:04o} {shlex.quote(file.destination)}"
            for file in runtime_identity.files
        ),
        f"git config --global user.name {shlex.quote(runtime_identity.git.user_name)}",
        f"git config --global user.email {shlex.quote(runtime_identity.git.user_email)}",
        "git config --global gpg.format ssh",
        "git config --global commit.gpgsign true",
        "git config --global user.signingkey "
        + shlex.quote(runtime_identity.git.signing_key_path),
        f"git config --global core.sshCommand {shlex.quote(ssh_command)}",
        *(
            f'test "$(stat -c %a {shlex.quote(file.destination)})" = {file.mode:o}'
            for file in runtime_identity.files
        ),
    ]
    run_sandbox_command(sandbox, "\n".join(configuration_commands))

    run_sandbox_command(
        sandbox,
        " && ".join(
            [
                "set -euo pipefail",
                f"test ! -e {workspace}",
                'if command -v gh >/dev/null 2>&1 && { test -n "${GH_TOKEN:-}" || test -n "${GITHUB_TOKEN:-}"; }; then',
                f"  gh repo clone {repository} {workspace} -- --branch {git_ref}",
                f"  cd {workspace}",
                "  gh auth setup-git",
                "else",
                f"  git clone --branch {git_ref} {ssh_repository} {workspace}",
                "fi",
                f"cd {workspace}",
                "./install.sh --yes",
                "sed -i 's#/home/coder/dotai#/workspace/dotai#g' /home/coder/.codex/config.toml",
                f"npm ci --prefix {workspace}/agent",
                "test ! -e /home/coder/.config/gh/hosts.yml",
            ]
        ),
        timeout=600,
        environment=runtime_environment,
    )
    run_sandbox_command(
        sandbox,
        "git status --short --branch",
        cwd=settings.workspace,
        environment=runtime_environment,
    )


def sandbox_response_domain(sandbox: Sandbox) -> str | None:
    data = getattr(sandbox, "_data", None)
    if not isinstance(data, dict):
        return None
    domain = data.get("domain")
    return domain if isinstance(domain, str) and domain else None


def validate_sandbox_response_domain(
    sandbox: Sandbox, settings: ProjectSettings
) -> None:
    response_domain = sandbox_response_domain(sandbox)
    if response_domain is None:
        raise RuntimeError("Cube response domain is missing")
    normalized = normalized_sandbox_domain(response_domain, "Cube response domain")
    if normalized != settings.sandbox_domain:
        raise RuntimeError(
            f"Cube response domain {response_domain!r} does not match trusted CUBE_SANDBOX_DOMAIN {settings.sandbox_domain!r}"
        )


def destroy_invalid_sandbox(sandbox: Sandbox, validation_error: Exception) -> None:
    try:
        sandbox.kill()
    except Exception as cleanup_error:
        raise ExceptionGroup(
            "Cube response validation and sandbox cleanup both failed",
            [validation_error, cleanup_error],
        ) from validation_error
    raise validation_error


def provision_sandbox(
    args: argparse.Namespace,
    settings: ProjectSettings,
) -> tuple[Sandbox, list[int], dict[str, str]]:
    forwarded_names = resolve_list(args.forwarded_environment, "CUBE_FORWARD_ENV", [])
    service_ports = resolve_list(args.service_ports, "CUBE_SERVICE_PORTS", [], int)
    writable_mount_specs = resolve_list(
        args.mounts,
        "CUBE_MOUNTS",
        [],
    )
    read_only_mount_specs = resolve_list(
        args.read_only_mounts,
        "CUBE_READ_ONLY_MOUNTS",
        [],
    )
    metadata_specs = resolve_list(args.metadata, "CUBE_SANDBOX_METADATA", [])
    metadata = parse_key_value_list(metadata_specs, "metadata")
    metadata.update({"project": settings.template_alias, "owner": "operator-cli"})
    timeout = resolve_integer(
        args.timeout, "CUBE_SANDBOX_TIMEOUT", settings.idle_timeout_seconds
    )
    on_timeout = resolve_string(
        args.on_timeout,
        "CUBE_SANDBOX_ON_TIMEOUT",
        settings.on_timeout,
    )
    if on_timeout not in {"kill", "pause"}:
        raise ValueError("CUBE_SANDBOX_ON_TIMEOUT must be kill or pause")
    auto_resume = resolve_boolean(args.auto_resume, "CUBE_SANDBOX_AUTO_RESUME", False)

    snapshot_id = args.snapshot or environment_value("CUBE_SNAPSHOT_ID")

    sandbox = Sandbox.create(
        template=snapshot_id or settings.template_alias,
        timeout=timeout,
        env_vars={},
        metadata=metadata,
        lifecycle={"on_timeout": on_timeout, "auto_resume": auto_resume},
        volume_mounts=parse_volume_mounts(
            writable_mount_specs,
            read_only_mount_specs,
        ),
        config=cube_config(settings),
    )
    try:
        validate_sandbox_response_domain(sandbox, settings)
    except Exception as error:
        destroy_invalid_sandbox(sandbox, error)
    runtime_environment = forwarded_environment(forwarded_names)
    github_token = optional_github_token()
    if github_token:
        runtime_environment["GH_TOKEN"] = github_token
    print(f"sandbox_id={sandbox.sandbox_id}")
    return sandbox, service_ports, runtime_environment


def bootstrap_and_report(
    sandbox: Sandbox,
    settings: ProjectSettings,
    service_ports: list[int],
    runtime_environment: dict[str, str],
) -> None:
    bootstrap_repository(sandbox, settings, runtime_environment)
    print(f"repository={settings.repository}")
    print(f"workspace={settings.workspace}")
    for port in service_ports:
        print(f"port_{port}=https://{sandbox.get_host(port)}")


def destroy_failed_bootstrap(sandbox: Sandbox, bootstrap_error: Exception) -> None:
    try:
        sandbox.kill()
    except Exception as cleanup_error:
        raise ExceptionGroup(
            "sandbox bootstrap and cleanup both failed",
            [bootstrap_error, cleanup_error],
        ) from bootstrap_error
    raise bootstrap_error


def create_sandbox(args: argparse.Namespace, settings: ProjectSettings) -> str:
    sandbox, service_ports, runtime_environment = provision_sandbox(args, settings)
    try:
        bootstrap_and_report(sandbox, settings, service_ports, runtime_environment)
    except Exception as error:
        destroy_failed_bootstrap(sandbox, error)
    return sandbox.sandbox_id


def resolve_pi_arguments(args: argparse.Namespace) -> list[str]:
    pi_arguments = args.pi_arguments
    if pi_arguments and pi_arguments[0] == "--":
        pi_arguments = pi_arguments[1:]
    if not pi_arguments:
        environment_arguments = environment_value("CUBE_PI_ARGS")
        pi_arguments = (
            shlex.split(environment_arguments) if environment_arguments else []
        )
    if not pi_arguments:
        raise ValueError("Pi arguments required after -- or through CUBE_PI_ARGS")
    return pi_arguments


def ensure_pi_print_mode(pi_arguments: list[str]) -> list[str]:
    if "--print" in pi_arguments or "-p" in pi_arguments:
        return pi_arguments
    return ["--print", *pi_arguments]


def run_pi_in_sandbox(
    sandbox: Sandbox,
    pi_arguments: list[str],
    timeout: int,
    settings: ProjectSettings,
    environment: dict[str, str] | None = None,
) -> None:
    run_sandbox_command(
        sandbox,
        shlex.join(["pi", *pi_arguments]),
        cwd=settings.workspace,
        timeout=timeout,
        environment=environment,
    )


def run_pi(args: argparse.Namespace, settings: ProjectSettings) -> None:
    pi_arguments = resolve_pi_arguments(args)
    timeout = resolve_integer(args.command_timeout, "CUBE_PI_TIMEOUT", 3600)
    sandbox = Sandbox.connect(
        required_sandbox_id(args.sandbox_id),
        config=cube_config(settings),
    )
    run_pi_in_sandbox(sandbox, pi_arguments, timeout, settings)


def try_pause_sandbox(
    sandbox_id: str,
    settings: ProjectSettings,
) -> Exception | None:
    try:
        pause_sandbox(sandbox_id, settings)
    except Exception as error:
        print(
            f"warning: failed to pause sandbox {sandbox_id}: {error}",
            file=sys.stderr,
        )
        return error
    return None


def run_task(args: argparse.Namespace, settings: ProjectSettings) -> None:
    sandbox, service_ports, runtime_environment = provision_sandbox(args, settings)
    sandbox_id = sandbox.sandbox_id
    try:
        bootstrap_and_report(sandbox, settings, service_ports, runtime_environment)
    except Exception as error:
        destroy_failed_bootstrap(sandbox, error)
    try:
        run_pi_in_sandbox(
            sandbox,
            ensure_pi_print_mode(resolve_pi_arguments(args)),
            resolve_integer(args.command_timeout, "CUBE_PI_TIMEOUT", 3600),
            settings,
            runtime_environment,
        )
    finally:
        pause_error = try_pause_sandbox(sandbox_id, settings)
    if pause_error is not None:
        raise RuntimeError(
            f"sandbox {sandbox_id} left unpaused after task"
        ) from pause_error


def required_sandbox_id(cli_value: str | None) -> str:
    sandbox_id = cli_value or environment_value("CUBE_SANDBOX_ID")
    if not sandbox_id:
        raise ValueError("sandbox ID required as argument or CUBE_SANDBOX_ID")
    return sandbox_id


def pause_sandbox(sandbox_id: str, settings: ProjectSettings) -> None:
    sandbox = Sandbox.connect(sandbox_id, config=cube_config(settings))
    sandbox.pause()
    print(f"sandbox={sandbox_id} state=paused")


def destroy_sandbox(sandbox_id: str, settings: ProjectSettings) -> None:
    sandbox = Sandbox.connect(sandbox_id, config=cube_config(settings))
    sandbox.kill()
    print(f"sandbox={sandbox_id} state=destroyed")


def list_sandboxes(settings: ProjectSettings) -> None:
    sandboxes = Sandbox.list(config=cube_config(settings))
    for sandbox in sandboxes:
        metadata = sandbox.get("metadata") or {}
        if (
            metadata.get("project") != settings.template_alias
            or metadata.get("owner") != "operator-cli"
        ):
            continue
        print(f"{sandbox['sandboxID']}\t{sandbox.get('state', 'unknown')}")


def print_snapshot(snapshot: object, *, include_empty_names: bool = False) -> None:
    print(f"snapshot_id={snapshot.snapshot_id}")
    if snapshot.names or include_empty_names:
        print(f"names={','.join(snapshot.names)}")


SNAPSHOT_FORBIDDEN_PATHS = (
    "/workspace/dotai",
    "/home/coder/.dotai",
    "/home/coder/.config/gh",
    "/home/coder/.config/paseo",
    "/home/coder/.gitconfig",
    "/home/coder/.git-credentials",
    "/home/coder/.pi/agent/auth.json",
    "/home/coder/.codex/auth.json",
    "/home/coder/.paseo",
    "/root/.paseo",
    "/root/.config/gh",
    "/root/.gitconfig",
)


def assert_clean_snapshot_source(sandbox: Sandbox) -> None:
    quoted_paths = " ".join(shlex.quote(path) for path in SNAPSHOT_FORBIDDEN_PATHS)
    secret_pattern = "^(ANTHROPIC_API_KEY|CODEX_API_KEY|GEMINI_API_KEY|GH_TOKEN|GITHUB_TOKEN|OPENAI_API_KEY)="
    command = "\n".join(
        [
            "set -euo pipefail",
            f'for path in {quoted_paths}; do test ! -e "$path" || {{ echo "forbidden snapshot path: $path" >&2; exit 1; }}; done',
            'test -z "$(find /home/coder/.ssh /root/.ssh -type f -print -quit 2>/dev/null || true)"',
            "test -z \"$(git config --global --get-regexp '^user\\.' || true)\"",
            "test -z \"$(git config --global --get-regexp '^(gpg\\.|commit\\.gpgsign|core\\.sshCommand)' || true)\"",
            "test -z \"$(git config --global --get-regexp '^credential\\.' || true)\"",
            f"! env | grep -Eq {shlex.quote(secret_pattern)}",
        ]
    )
    run_sandbox_command(sandbox, command, user="root")


def prepare_snapshot(args: argparse.Namespace, settings: ProjectSettings) -> None:
    sandbox = Sandbox.create(
        template=settings.template_alias,
        timeout=settings.idle_timeout_seconds,
        env_vars={},
        metadata={
            "project": settings.template_alias,
            "owner": "operator-cli",
            "purpose": "snapshot-source",
        },
        lifecycle={"on_timeout": "kill", "auto_resume": False},
        config=cube_config(settings),
    )
    try:
        validate_sandbox_response_domain(sandbox, settings)
    except Exception as error:
        destroy_invalid_sandbox(sandbox, error)

    operation_error: Exception | None = None
    snapshot = None
    try:
        assert_clean_snapshot_source(sandbox)
        snapshot = sandbox.create_snapshot(name=args.name or settings.template_alias)
    except Exception as error:
        operation_error = error

    try:
        sandbox.kill()
    except Exception as cleanup_error:
        if operation_error is not None:
            raise ExceptionGroup(
                "Snapshot preparation and source Sandbox cleanup both failed",
                [operation_error, cleanup_error],
            ) from operation_error
        raise

    if operation_error is not None:
        raise operation_error
    print(f"source_sandbox_id={sandbox.sandbox_id}")
    print_snapshot(snapshot)


def list_snapshots(args: argparse.Namespace, settings: ProjectSettings) -> None:
    sandbox_id = args.sandbox_id or environment_value("CUBE_SNAPSHOT_SANDBOX_ID")
    limit = resolve_positive_integer(
        args.limit,
        "CUBE_SNAPSHOT_LIST_LIMIT",
        100,
    )
    config = cube_config(settings)
    next_token: str | None = None
    seen_tokens: set[str] = set()
    while True:
        snapshots, returned_token = Sandbox.list_snapshots(
            sandbox_id=sandbox_id,
            limit=limit,
            next_token=next_token,
            config=config,
        )
        for snapshot in snapshots:
            print_snapshot(snapshot, include_empty_names=True)
        if not returned_token:
            return
        if returned_token in seen_tokens:
            raise RuntimeError(
                f"snapshot pagination repeated next token: {returned_token}"
            )
        seen_tokens.add(returned_token)
        next_token = returned_token


def required_snapshot_id(cli_value: str | None) -> str:
    snapshot_id = cli_value or environment_value("CUBE_SNAPSHOT_ID")
    if not snapshot_id:
        raise ValueError("snapshot ID required as argument or CUBE_SNAPSHOT_ID")
    return snapshot_id


def delete_snapshot(args: argparse.Namespace, settings: ProjectSettings) -> None:
    snapshot_id = required_snapshot_id(args.snapshot_id)
    Sandbox.delete_snapshot(snapshot_id, config=cube_config(settings))
    print(f"snapshot_id={snapshot_id}")
    print("state=deleted")


def clone_sandbox(args: argparse.Namespace, settings: ProjectSettings) -> None:
    sandbox_id = required_sandbox_id(args.sandbox_id)
    count = resolve_positive_integer(args.count, "CUBE_CLONE_COUNT", 1)
    concurrency = resolve_positive_integer(
        args.concurrency,
        "CUBE_CLONE_CONCURRENCY",
        1,
    )
    sandbox = Sandbox.connect(sandbox_id, config=cube_config(settings))
    clones = sandbox.clone(n=count, concurrency=concurrency)
    print(f"source_sandbox_id={sandbox_id}")
    for clone in clones:
        print(f"clone_id={clone.sandbox_id}")


def create_volume(args: argparse.Namespace, settings: ProjectSettings) -> None:
    name = args.name or environment_value("CUBE_VOLUME_NAME")
    driver = resolve_string(args.driver, "CUBE_VOLUME_DRIVER", "s3")
    volume = Volume.create(name, driver=driver, config=cube_config(settings))
    print(f"volume_id={volume.volume_id}")
    print(f"name={volume.name}")
    print(f"driver={driver}")


def list_volumes(settings: ProjectSettings) -> None:
    for volume in Volume.list(config=cube_config(settings)):
        print(f"{volume.volume_id}\t{volume.name}")


def required_volume_id(cli_value: str | None) -> str:
    volume_id = cli_value or environment_value("CUBE_VOLUME_ID")
    if not volume_id:
        raise ValueError("volume ID required through --volume-id or CUBE_VOLUME_ID")
    return volume_id


def delete_volume(args: argparse.Namespace, settings: ProjectSettings) -> None:
    volume_id = required_volume_id(args.volume_id)
    deleted = Volume.destroy(volume_id, config=cube_config(settings))
    state = "deleted" if deleted else "not-found"
    print(f"volume={volume_id} state={state}")


def s3_upload_credentials(
    endpoint: str,
    credentials_url: str | None,
) -> tuple[str, str]:
    access_key_id = environment_value("CUBE_S3_ACCESS_KEY_ID")
    secret_access_key = environment_value("CUBE_S3_SECRET_ACCESS_KEY")
    if access_key_id and secret_access_key:
        return access_key_id, secret_access_key
    if access_key_id or secret_access_key:
        raise ValueError(
            "CUBE_S3_ACCESS_KEY_ID and CUBE_S3_SECRET_ACCESS_KEY must be set together"
        )

    resolved_credentials_url = credentials_url or (
        f"{endpoint.rstrip('/')}/.well-known/cube-volume-upload-credentials"
    )
    try:
        with urllib.request.urlopen(resolved_credentials_url, timeout=10) as response:
            credentials = json.load(response)
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as error:
        raise RuntimeError(
            f"failed to fetch S3 upload credentials from {resolved_credentials_url}"
        ) from error

    fetched_access_key_id = credentials.get("accessKeyId")
    fetched_secret_access_key = credentials.get("secretAccessKey")
    if not fetched_access_key_id or not fetched_secret_access_key:
        raise RuntimeError("S3 upload credential response is incomplete")
    return str(fetched_access_key_id), str(fetched_secret_access_key)


def upload_sources(source: Path) -> list[tuple[Path, PurePosixPath]]:
    if source.is_file():
        return [(source, PurePosixPath(source.name))]
    return [
        (path, PurePosixPath(path.relative_to(source).as_posix()))
        for path in sorted(source.rglob("*"))
        if path.is_file()
    ]


def upload_volume(args: argparse.Namespace, settings: ProjectSettings) -> None:
    volume_id = required_volume_id(args.volume_id)
    source_value = args.source or environment_value("CUBE_VOLUME_UPLOAD_SOURCE")
    if not source_value:
        raise ValueError(
            "upload source required through --source or CUBE_VOLUME_UPLOAD_SOURCE"
        )
    source = Path(source_value).expanduser().resolve()
    if not source.exists():
        raise ValueError(f"upload source does not exist: {source}")

    destination = volume_destination(
        resolve_string(
            args.destination,
            "CUBE_VOLUME_UPLOAD_DESTINATION",
            "/",
        )
    )
    endpoint = resolve_string(
        args.endpoint,
        "CUBE_S3_ENDPOINT",
        "https://s3.sandbox.0iq.xyz",
    )
    bucket = resolve_string(args.bucket, "CUBE_S3_BUCKET", "cube-volumes")
    region = resolve_string(args.region, "CUBE_S3_REGION", "us-east-1")
    credentials_url = args.credentials_url or environment_value(
        "CUBE_S3_CREDENTIALS_URL"
    )

    Volume.get_info(volume_id, config=cube_config(settings))
    access_key_id, secret_access_key = s3_upload_credentials(
        endpoint,
        credentials_url,
    )
    s3_client = boto3.client(
        "s3",
        endpoint_url=endpoint,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        region_name=region,
        config=S3ClientConfig(
            signature_version="s3v4",
            s3={"addressing_style": "path"},
        ),
    )

    uploaded_files = upload_sources(source)
    uploaded_bytes = 0
    destination_prefix = destination.relative_to("/")
    for local_path, relative_path in uploaded_files:
        object_path = destination_prefix / relative_path
        object_key = f"volumes/{volume_id}/{object_path.as_posix()}"
        s3_client.upload_file(str(local_path), bucket, object_key)
        uploaded_bytes += local_path.stat().st_size

    print(f"volume={volume_id}")
    print(f"source={source}")
    print(f"destination={destination}")
    print(f"files={len(uploaded_files)}")
    print(f"bytes={uploaded_bytes}")


def show_configuration(settings: ProjectSettings) -> None:
    configuration = asdict(settings)
    configuration["cube_api_key"] = "set" if os.environ.get("CUBE_API_KEY") else "unset"
    print(json.dumps(configuration, indent=2, sort_keys=True))


def add_global_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--template-alias")
    parser.add_argument("--registry")
    parser.add_argument("--base-image")
    parser.add_argument("--image-repository")
    parser.add_argument("--repository")
    parser.add_argument("--git-ref")
    parser.add_argument("--workspace")
    parser.add_argument("--pi-auth-file")
    parser.add_argument("--codex-auth-file")
    parser.add_argument("--paseo-config-file")
    parser.add_argument("--ssh-auth-key")
    parser.add_argument("--ssh-known-hosts-file")


def add_create_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--snapshot")
    parser.add_argument(
        "--env", dest="forwarded_environment", action="append", metavar="NAME"
    )
    parser.add_argument("--port", dest="service_ports", action="append", type=int)
    parser.add_argument(
        "--mount",
        dest="mounts",
        action="append",
        metavar="PATH=VOLUME_ID",
    )
    parser.add_argument(
        "--read-only-mount",
        dest="read_only_mounts",
        action="append",
        metavar="PATH=VOLUME_ID",
    )
    parser.add_argument("--metadata", action="append", metavar="KEY=VALUE")
    parser.add_argument("--timeout", type=int)
    parser.add_argument("--on-timeout", choices=("kill", "pause"))
    parser.add_argument(
        "--auto-resume",
        action=argparse.BooleanOptionalAction,
        default=None,
    )


def add_pi_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--command-timeout", type=int)
    parser.add_argument("pi_arguments", nargs=argparse.REMAINDER)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    add_global_options(parser)
    subparsers = parser.add_subparsers(dest="command", required=True)

    deploy = subparsers.add_parser(
        "deploy",
        help="build, push, and deploy project template",
    )
    deploy.add_argument(
        "--image-ref", help="skip Docker build; deploy digest reference"
    )
    deploy.add_argument("--image-tag")
    deploy.add_argument("--build-platform")
    deploy.add_argument("--dockerfile")
    deploy.add_argument("--build-context")
    deploy.add_argument("--build-arg", dest="build_arguments", action="append")
    deploy.add_argument("--wait-timeout", type=int)
    deploy.add_argument("--writable-layer-size")
    deploy.add_argument(
        "--expose-port", dest="exposed_ports", action="append", type=int
    )
    deploy.add_argument("--probe-port", type=int)
    deploy.add_argument("--probe-path")
    deploy.add_argument("--cpu-millicores", type=int)
    deploy.add_argument("--memory-mb", type=int)
    deploy.add_argument("--template-env", dest="template_environment", action="append")
    deploy.add_argument(
        "--allow-internet-access",
        action=argparse.BooleanOptionalAction,
        default=None,
    )
    deploy.add_argument("--network-type")

    create = subparsers.add_parser("create", help="create project sandbox")
    add_create_arguments(create)

    task = subparsers.add_parser(
        "task",
        help="create sandbox, run Pi, then pause sandbox",
    )
    add_create_arguments(task)
    add_pi_arguments(task)

    pause = subparsers.add_parser("pause", help="pause project sandbox")
    pause.add_argument("sandbox_id", nargs="?")

    destroy = subparsers.add_parser("destroy", help="destroy project sandbox")
    destroy.add_argument("sandbox_id", nargs="?")

    pi = subparsers.add_parser("pi", help="run Pi headlessly in project workspace")
    pi.add_argument("sandbox_id", nargs="?")
    add_pi_arguments(pi)

    subparsers.add_parser("list", help="list this project's sandboxes")

    snapshot_prepare = subparsers.add_parser(
        "prepare-snapshot",
        help="create a clean durable snapshot from a dedicated source sandbox",
    )
    snapshot_prepare.add_argument("--name")

    snapshot_list = subparsers.add_parser(
        "snapshot-list",
        help="list durable snapshots",
    )
    snapshot_list.add_argument("--sandbox-id")
    snapshot_list.add_argument("--limit", type=positive_integer)

    snapshot_delete = subparsers.add_parser(
        "snapshot-delete",
        help="permanently delete durable snapshot",
    )
    snapshot_delete.add_argument("snapshot_id", nargs="?")

    clone = subparsers.add_parser(
        "clone",
        help="create temporary clones from sandbox",
    )
    clone.add_argument("sandbox_id", nargs="?")
    clone.add_argument("--count", type=positive_integer)
    clone.add_argument("--concurrency", type=positive_integer)

    volume_create = subparsers.add_parser(
        "volume-create",
        help="create persistent volume",
    )
    volume_create.add_argument("--name")
    volume_create.add_argument("--driver")

    subparsers.add_parser("volume-list", help="list persistent volumes")

    volume_delete = subparsers.add_parser(
        "volume-delete",
        help="permanently delete persistent volume",
    )
    volume_delete.add_argument("--volume-id")

    volume_upload = subparsers.add_parser(
        "volume-upload",
        help="upload local file or directory into persistent volume",
    )
    volume_upload.add_argument("--volume-id")
    volume_upload.add_argument("--source")
    volume_upload.add_argument("--destination")
    volume_upload.add_argument("--endpoint")
    volume_upload.add_argument("--credentials-url")
    volume_upload.add_argument("--bucket")
    volume_upload.add_argument("--region")

    subparsers.add_parser(
        "config", help="print effective non-secret global configuration"
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    project_settings = load_project_settings(args)

    if args.command == "deploy":
        deploy_settings = load_deploy_settings(args, project_settings)
        image_ref = deploy_settings.image_ref or publish_image(
            project_settings,
            deploy_settings,
        )
        deploy_template(project_settings, deploy_settings, image_ref)
    elif args.command == "create":
        create_sandbox(args, project_settings)
    elif args.command == "pause":
        pause_sandbox(required_sandbox_id(args.sandbox_id), project_settings)
    elif args.command == "destroy":
        destroy_sandbox(required_sandbox_id(args.sandbox_id), project_settings)
    elif args.command == "pi":
        run_pi(args, project_settings)
    elif args.command == "task":
        run_task(args, project_settings)
    elif args.command == "list":
        list_sandboxes(project_settings)
    elif args.command == "prepare-snapshot":
        prepare_snapshot(args, project_settings)
    elif args.command == "snapshot-list":
        list_snapshots(args, project_settings)
    elif args.command == "snapshot-delete":
        delete_snapshot(args, project_settings)
    elif args.command == "clone":
        clone_sandbox(args, project_settings)
    elif args.command == "volume-create":
        create_volume(args, project_settings)
    elif args.command == "volume-list":
        list_volumes(project_settings)
    elif args.command == "volume-delete":
        delete_volume(args, project_settings)
    elif args.command == "volume-upload":
        upload_volume(args, project_settings)
    elif args.command == "config":
        show_configuration(project_settings)
    else:
        parser.error(f"unknown command: {args.command}")


if __name__ == "__main__":
    try:
        main()
    except (
        CubeSandboxError,
        BotoCoreError,
        ClientError,
        S3UploadFailedError,
        RuntimeError,
        ValueError,
        subprocess.CalledProcessError,
        ExceptionGroup,
    ) as error:
        raise SystemExit(f"error: {error}") from error

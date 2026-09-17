from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest


REPOSITORY_ROOT = Path(__file__).parents[1]
SCRIPT_PATH = REPOSITORY_ROOT / ".cube" / "sandbox.py"
DOCKERFILE_PATH = REPOSITORY_ROOT / ".cube" / "Dockerfile"


def install_import_stubs(monkeypatch: pytest.MonkeyPatch) -> None:
    boto3 = ModuleType("boto3")
    boto3.client = lambda *args, **kwargs: None
    boto3_exceptions = ModuleType("boto3.exceptions")
    boto3_exceptions.S3UploadFailedError = type("S3UploadFailedError", (Exception,), {})
    botocore = ModuleType("botocore")
    botocore_config = ModuleType("botocore.config")
    botocore_config.Config = object
    botocore_exceptions = ModuleType("botocore.exceptions")
    botocore_exceptions.BotoCoreError = type("BotoCoreError", (Exception,), {})
    botocore_exceptions.ClientError = type("ClientError", (Exception,), {})
    cubesandbox = ModuleType("cubesandbox")
    cubesandbox.Config = type("Config", (), {"__init__": lambda self, **kwargs: None})
    cubesandbox.CubeSandboxError = type("CubeSandboxError", (Exception,), {})
    cubesandbox.Sandbox = type("Sandbox", (), {})
    cubesandbox.Template = type("Template", (), {})
    cubesandbox.Volume = type("Volume", (), {})
    cubesandbox.VolumeMount = type(
        "VolumeMount",
        (),
        {"__init__": lambda self, *args, **kwargs: None},
    )
    for name, module in {
        "boto3": boto3,
        "boto3.exceptions": boto3_exceptions,
        "botocore": botocore,
        "botocore.config": botocore_config,
        "botocore.exceptions": botocore_exceptions,
        "cubesandbox": cubesandbox,
    }.items():
        monkeypatch.setitem(sys.modules, name, module)


@pytest.fixture
def cli(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    install_import_stubs(monkeypatch)
    module_name = "dotai_cube_sandbox_cli"
    spec = importlib.util.spec_from_file_location(module_name, SCRIPT_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    monkeypatch.setitem(sys.modules, module_name, module)
    spec.loader.exec_module(module)
    return module


def parse(cli: ModuleType, *arguments: str):
    return cli.build_parser().parse_args(list(arguments))


def test_config_maps_project_defaults(cli: ModuleType) -> None:
    settings = cli.load_project_settings(parse(cli, "config"))

    assert settings.project_id == "dotai"
    assert settings.template_alias == "dotai"
    assert (
        settings.base_image
        == "bbcr.0iq.xyz/hakim/cube-hakim-js:71a7eaf6d746-20260917122636"
    )
    assert settings.repository == "shekohex/dotai"
    assert settings.git_ref == "main"
    assert settings.workspace == "/workspace/dotai"
    assert settings.cube_api_url == "https://sandbox.0iq.xyz"
    assert settings.sandbox_domain == "sbx.0iq.xyz"
    assert settings.cpu_millicores == 2000
    assert settings.memory_mb == 4096
    assert settings.writable_layer_size == "20G"
    assert settings.idle_timeout_seconds == 300
    assert settings.on_timeout == "pause"
    assert settings.preview_ports == []
    assert settings.pi_auth_file == "~/.pi/agent/auth.json"
    assert settings.codex_auth_file == "~/.codex/auth.json"
    assert settings.paseo_config_file == "~/.paseo/config.json"
    assert settings.ssh_auth_key == "~/.ssh/id_ed25519"
    assert settings.ssh_known_hosts_file == "~/.ssh/known_hosts"


@pytest.mark.parametrize(
    ("section", "field", "value", "message"),
    (
        (
            "cube",
            "apiUrl",
            "http://127.0.0.1:31337",
            "does not match trusted CUBE_API_URL",
        ),
        (
            "cube",
            "sandboxDomain",
            "attacker.example",
            "does not match trusted CUBE_SANDBOX_DOMAIN",
        ),
    ),
)
def test_repository_endpoint_assertions_fail_before_secrets_or_network(
    cli: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    section: str,
    field: str,
    value: str,
    message: str,
) -> None:
    config = json.loads((REPOSITORY_ROOT / ".cube" / "config.json").read_text())
    config[section][field] = value
    monkeypatch.setattr(cli, "load_project_config", lambda: config)
    secret_reads: list[str] = []

    class GuardedEnvironment(dict[str, str]):
        def get(self, key: str, default=None):
            if key in {"CUBE_API_KEY", "GH_TOKEN", "GITHUB_TOKEN", "OPENAI_API_KEY"}:
                secret_reads.append(key)
                raise AssertionError(f"secret read: {key}")
            return super().get(key, default)

    monkeypatch.setattr(cli.os, "environ", GuardedEnvironment())
    create = lambda **kwargs: pytest.fail("Cube network called")
    monkeypatch.setattr(cli.Sandbox, "create", create, raising=False)

    with pytest.raises(ValueError, match=message):
        cli.load_project_settings(parse(cli, "create"))
    assert secret_reads == []


def test_response_domain_rejected_before_runtime_secret_resolution(
    cli: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []

    class FakeSandbox:
        sandbox_id = "sandbox-1"
        _data = {"domain": "attacker.example"}

        def kill(self):
            calls.append("kill")

    monkeypatch.setattr(
        cli.Sandbox,
        "create",
        lambda **kwargs: calls.append(json.dumps(kwargs["env_vars"])) or FakeSandbox(),
        raising=False,
    )
    monkeypatch.setattr(
        cli,
        "forwarded_environment",
        lambda names: pytest.fail("runtime environment resolved"),
    )
    monkeypatch.setattr(
        cli,
        "resolve_github_token",
        lambda: pytest.fail("GitHub token resolved"),
    )
    settings = cli.load_project_settings(parse(cli, "create"))

    with pytest.raises(RuntimeError, match="does not match trusted"):
        cli.provision_sandbox(parse(cli, "create"), settings)
    assert calls == ["{}", "kill"]


def test_runtime_clone_configures_gh_after_clone_and_installs_dependencies(
    cli: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    commands: list[tuple[str, dict[str, str]]] = []
    writes: list[tuple[str, str, str]] = []

    class FakeCommands:
        def run(self, command, **kwargs):
            commands.append((command, kwargs["envs"]))
            return SimpleNamespace(stdout="", stderr="", exit_code=0)

    class FakeFiles:
        def write(self, path, contents, *, user):
            writes.append((path, contents, user))

    sandbox = SimpleNamespace(commands=FakeCommands(), files=FakeFiles())
    monkeypatch.setattr(
        cli,
        "runtime_identity_bundle",
        lambda settings: cli.RuntimeIdentityBundle(
            files=(
                cli.RuntimeFile(
                    "/home/coder/.pi/agent/auth.json", '{"pi":true}', 0o600
                ),
                cli.RuntimeFile(
                    "/home/coder/.codex/auth.json", '{"codex":true}', 0o600
                ),
                cli.RuntimeFile(
                    "/home/coder/.paseo/config.json", '{"paseo":true}', 0o600
                ),
                cli.RuntimeFile(
                    "/home/coder/.ssh/id_ed25519", "AUTH_PRIVATE_FIXTURE", 0o600
                ),
                cli.RuntimeFile(
                    "/home/coder/.ssh/id_ed25519.pub",
                    "ssh-ed25519 AUTH_PUBLIC_FIXTURE",
                    0o644,
                ),
                cli.RuntimeFile(
                    "/home/coder/.ssh/git-commit-signing/coder",
                    "SIGNING_PRIVATE_FIXTURE",
                    0o600,
                ),
                cli.RuntimeFile(
                    "/home/coder/.ssh/git-commit-signing/coder.pub",
                    "ssh-ed25519 SIGNING_PUBLIC_FIXTURE",
                    0o644,
                ),
                cli.RuntimeFile(
                    "/home/coder/.ssh/known_hosts",
                    "github.com ssh-ed25519 HOST_FIXTURE\n",
                    0o600,
                ),
            ),
            git=cli.RuntimeGitIdentity(
                user_name="Runtime User",
                user_email="runtime@example.test",
                auth_key_path="/home/coder/.ssh/id_ed25519",
                signing_key_path="/home/coder/.ssh/git-commit-signing/coder",
                known_hosts_path="/home/coder/.ssh/known_hosts",
            ),
        ),
    )
    settings = cli.load_project_settings(parse(cli, "create"))

    cli.bootstrap_repository(sandbox, settings, {"GH_TOKEN": "runtime-only"})

    prepare = commands[0][0]
    git_configuration = commands[1][0]
    bootstrap, environment = commands[2]
    assert "install -m 0600 /dev/null" in prepare
    assert "install -m 0644 /dev/null" in prepare
    assert "git config --global gpg.format ssh" in git_configuration
    assert "git config --global commit.gpgsign true" in git_configuration
    assert "StrictHostKeyChecking=yes" in git_configuration
    assert "StrictHostKeyChecking=no" not in git_configuration
    assert bootstrap.index("gh auth setup-git") > bootstrap.index("gh repo clone")
    assert "git clone --branch main git@github.com:shekohex/dotai.git" in bootstrap
    assert "./install.sh --yes" in bootstrap
    assert "npm ci --prefix /workspace/dotai/agent" in bootstrap
    assert "sed -i 's#/home/coder/dotai#/workspace/dotai#g'" in bootstrap
    assert "test ! -e /home/coder/.config/gh/hosts.yml" in bootstrap
    assert environment == {"GH_TOKEN": "runtime-only"}
    assert "runtime-only" not in bootstrap
    assert writes == [
        ("/home/coder/.pi/agent/auth.json", '{"pi":true}', "coder"),
        ("/home/coder/.codex/auth.json", '{"codex":true}', "coder"),
        ("/home/coder/.paseo/config.json", '{"paseo":true}', "coder"),
        ("/home/coder/.ssh/id_ed25519", "AUTH_PRIVATE_FIXTURE", "coder"),
        (
            "/home/coder/.ssh/id_ed25519.pub",
            "ssh-ed25519 AUTH_PUBLIC_FIXTURE",
            "coder",
        ),
        (
            "/home/coder/.ssh/git-commit-signing/coder",
            "SIGNING_PRIVATE_FIXTURE",
            "coder",
        ),
        (
            "/home/coder/.ssh/git-commit-signing/coder.pub",
            "ssh-ed25519 SIGNING_PUBLIC_FIXTURE",
            "coder",
        ),
        (
            "/home/coder/.ssh/known_hosts",
            "github.com ssh-ed25519 HOST_FIXTURE\n",
            "coder",
        ),
    ]
    assert '"pi":true' not in json.dumps(commands)
    assert '"codex":true' not in json.dumps(commands)
    assert '"paseo":true' not in json.dumps(commands)
    assert "AUTH_PRIVATE_FIXTURE" not in json.dumps(commands)
    assert "SIGNING_PRIVATE_FIXTURE" not in json.dumps(commands)


def test_runtime_identity_files_require_valid_json(
    cli: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pi_auth = tmp_path / "pi-auth.json"
    codex_auth = tmp_path / "codex-auth.json"
    paseo_config = tmp_path / "paseo-config.json"
    pi_auth.write_text('{"pi":true}\n')
    codex_auth.write_text("not-json")
    paseo_config.write_text('{"paseo":true}\n')
    monkeypatch.setenv("CUBE_PI_AUTH_FILE", str(pi_auth))
    monkeypatch.setenv("CUBE_CODEX_AUTH_FILE", str(codex_auth))
    monkeypatch.setenv("CUBE_PASEO_CONFIG_FILE", str(paseo_config))
    with pytest.raises(RuntimeError, match="Codex auth file is not valid JSON"):
        cli.required_json_file(str(codex_auth), "Codex auth")


def test_runtime_identity_bundle_uses_effective_git_and_allowlisted_ssh_files(
    cli: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    home = tmp_path / "home"
    ssh_directory = home / ".ssh"
    auth_key = ssh_directory / "auth" / "id_ed25519"
    signing_key = ssh_directory / "git-commit-signing" / "coder"
    for key in (auth_key, signing_key):
        key.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(key)],
            check=True,
        )
    auth_public = auth_key.with_suffix(".pub").read_text().split()[:2]
    (ssh_directory / "known_hosts").write_text(
        f"github.com {' '.join(auth_public)}\nexample.com {' '.join(auth_public)}\n"
    )
    identity_files = {
        "CUBE_PI_AUTH_FILE": tmp_path / "pi.json",
        "CUBE_CODEX_AUTH_FILE": tmp_path / "codex.json",
        "CUBE_PASEO_CONFIG_FILE": tmp_path / "paseo.json",
    }
    for environment_name, identity_path in identity_files.items():
        identity_path.write_text('{"fixture":true}\n')
        monkeypatch.setenv(environment_name, str(identity_path))
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("CUBE_SSH_AUTH_KEY", "~/.ssh/auth/id_ed25519")
    monkeypatch.setenv("CUBE_SSH_KNOWN_HOSTS_FILE", "~/.ssh/known_hosts")
    settings = cli.load_project_settings(parse(cli, "create"))

    repository = tmp_path / "repository"
    repository.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repository, check=True)
    for key, value in (
        ("user.name", "Runtime Fixture"),
        ("user.email", "runtime@example.test"),
        ("gpg.format", "ssh"),
        ("commit.gpgsign", "true"),
        ("user.signingkey", "~/.ssh/git-commit-signing/coder"),
    ):
        subprocess.run(["git", "config", key, value], cwd=repository, check=True)
    monkeypatch.setattr(cli, "PROJECT_ROOT", repository)

    bundle = cli.runtime_identity_bundle(settings)

    assert bundle.git == cli.RuntimeGitIdentity(
        user_name="Runtime Fixture",
        user_email="runtime@example.test",
        auth_key_path="/home/coder/.ssh/auth/id_ed25519",
        signing_key_path="/home/coder/.ssh/git-commit-signing/coder",
        known_hosts_path="/home/coder/.ssh/known_hosts",
    )
    assert [(file.destination, file.mode) for file in bundle.files][-5:] == [
        ("/home/coder/.ssh/auth/id_ed25519", 0o600),
        ("/home/coder/.ssh/auth/id_ed25519.pub", 0o644),
        ("/home/coder/.ssh/git-commit-signing/coder", 0o600),
        ("/home/coder/.ssh/git-commit-signing/coder.pub", 0o644),
        ("/home/coder/.ssh/known_hosts", 0o600),
    ]
    known_hosts = bundle.files[-1].contents
    assert "github.com " in known_hosts
    assert "example.com" not in known_hosts


def test_runtime_ssh_sources_reject_traversal_symlinks_and_missing_files(
    cli: ModuleType, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    home = tmp_path / "home"
    ssh_directory = home / ".ssh"
    ssh_directory.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.write_text("not-a-key")
    (ssh_directory / "linked").symlink_to(outside)
    monkeypatch.setenv("HOME", str(home))

    with pytest.raises(RuntimeError, match="path traversal"):
        cli.read_allowlisted_ssh_file("~/.ssh/../outside", "SSH auth private key")
    with pytest.raises(RuntimeError, match="must be inside"):
        cli.read_allowlisted_ssh_file(str(outside), "SSH auth private key")
    with pytest.raises(RuntimeError, match="must not be a symbolic link"):
        cli.read_allowlisted_ssh_file("~/.ssh/linked", "SSH auth private key")
    with pytest.raises(RuntimeError, match="does not exist"):
        cli.read_allowlisted_ssh_file("~/.ssh/missing", "SSH auth private key")
    for disallowed_name in ("authorized_keys", "known_hosts.old"):
        with pytest.raises(RuntimeError, match="must not use disallowed SSH file"):
            cli.read_allowlisted_ssh_file(
                f"~/.ssh/{disallowed_name}", "SSH auth private key"
            )
    real_ssh_directory = home / ".ssh-real"
    ssh_directory.rename(real_ssh_directory)
    ssh_directory.symlink_to(real_ssh_directory, target_is_directory=True)
    with pytest.raises(RuntimeError, match="SSH directory must not be a symbolic link"):
        cli.read_allowlisted_ssh_file("~/.ssh/linked", "SSH auth private key")


@pytest.mark.parametrize("cleanup_fails", (False, True))
def test_runtime_bootstrap_failure_destroys_key_bearing_sandbox(
    cli: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    cleanup_fails: bool,
) -> None:
    events: list[str] = []

    class FakeSandbox:
        sandbox_id = "sandbox-runtime"

        def kill(self):
            events.append("destroy")
            if cleanup_fails:
                raise RuntimeError("cleanup failed")

    sandbox = FakeSandbox()
    monkeypatch.setattr(
        cli,
        "provision_sandbox",
        lambda args, settings: (sandbox, [], {}),
    )
    monkeypatch.setattr(
        cli,
        "bootstrap_and_report",
        lambda *args: (_ for _ in ()).throw(RuntimeError("transfer failed")),
    )
    settings = cli.load_project_settings(parse(cli, "create"))

    if cleanup_fails:
        with pytest.raises(ExceptionGroup, match="bootstrap and cleanup both failed"):
            cli.create_sandbox(parse(cli, "create"), settings)
    else:
        with pytest.raises(RuntimeError, match="transfer failed"):
            cli.create_sandbox(parse(cli, "create"), settings)
    assert events == ["destroy"]


@pytest.mark.parametrize("snapshot_fails", (False, True))
def test_prepare_snapshot_uses_clean_source_and_always_destroys(
    cli: ModuleType,
    monkeypatch: pytest.MonkeyPatch,
    snapshot_fails: bool,
) -> None:
    events: list[object] = []

    class FakeCommands:
        def run(self, command, **kwargs):
            events.append(("hygiene", command, kwargs.get("envs")))
            return SimpleNamespace(stdout="", stderr="", exit_code=0)

    class FakeSandbox:
        sandbox_id = "snapshot-source"
        _data = {"domain": "sbx.0iq.xyz"}
        commands = FakeCommands()

        def create_snapshot(self, name=None):
            events.append(("snapshot", name))
            if snapshot_fails:
                raise RuntimeError("snapshot failed")
            return SimpleNamespace(snapshot_id="snapshot-1", names=[name])

        def kill(self):
            events.append("kill")

    create_calls: list[dict[str, object]] = []
    monkeypatch.setattr(
        cli.Sandbox,
        "create",
        lambda **kwargs: create_calls.append(kwargs) or FakeSandbox(),
        raising=False,
    )
    settings = cli.load_project_settings(parse(cli, "prepare-snapshot"))

    if snapshot_fails:
        with pytest.raises(RuntimeError, match="snapshot failed"):
            cli.prepare_snapshot(parse(cli, "prepare-snapshot"), settings)
    else:
        cli.prepare_snapshot(parse(cli, "prepare-snapshot"), settings)

    assert create_calls[0]["env_vars"] == {}
    assert create_calls[0]["metadata"] == {
        "project": "dotai",
        "owner": "operator-cli",
        "purpose": "snapshot-source",
    }
    assert ("snapshot", "dotai") in events
    assert events[-1] == "kill"
    hygiene_command = next(
        event[1]
        for event in events
        if isinstance(event, tuple) and event[0] == "hygiene"
    )
    for forbidden_path in cli.SNAPSHOT_FORBIDDEN_PATHS:
        assert forbidden_path in hygiene_command
    assert "GITHUB_TOKEN" in hygiene_command
    assert "^credential\\." in hygiene_command
    assert "/home/coder/.ssh" in hygiene_command
    assert "/root/.ssh" in hygiene_command
    assert "commit\\.gpgsign" in hygiene_command
    assert "core\\.sshCommand" in hygiene_command


def test_prepare_snapshot_reports_cleanup_failure(
    cli: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    class FakeCommands:
        def run(self, command, **kwargs):
            return SimpleNamespace(stdout="", stderr="", exit_code=0)

    class FakeSandbox:
        sandbox_id = "snapshot-source"
        _data = {"domain": "sbx.0iq.xyz"}
        commands = FakeCommands()

        def create_snapshot(self, name=None):
            raise RuntimeError("snapshot failed")

        def kill(self):
            raise RuntimeError("destroy failed")

    monkeypatch.setattr(
        cli.Sandbox, "create", lambda **kwargs: FakeSandbox(), raising=False
    )
    settings = cli.load_project_settings(parse(cli, "prepare-snapshot"))

    with pytest.raises(ExceptionGroup) as captured:
        cli.prepare_snapshot(parse(cli, "prepare-snapshot"), settings)

    assert [str(error) for error in captured.value.exceptions] == [
        "snapshot failed",
        "destroy failed",
    ]


def test_prepare_snapshot_refuses_forbidden_path_and_destroys_source(
    cli: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    events: list[str] = []

    class FakeCommands:
        def run(self, command, **kwargs):
            return SimpleNamespace(
                stdout="",
                stderr="forbidden snapshot path: /workspace/dotai",
                exit_code=1,
            )

    class FakeSandbox:
        sandbox_id = "snapshot-source"
        _data = {"domain": "sbx.0iq.xyz"}
        commands = FakeCommands()

        def create_snapshot(self, name=None):
            pytest.fail("snapshot created from dirty source")

        def kill(self):
            events.append("kill")

    monkeypatch.setattr(
        cli.Sandbox, "create", lambda **kwargs: FakeSandbox(), raising=False
    )
    settings = cli.load_project_settings(parse(cli, "prepare-snapshot"))

    with pytest.raises(RuntimeError, match="sandbox command failed"):
        cli.prepare_snapshot(parse(cli, "prepare-snapshot"), settings)
    assert events == ["kill"]


def test_manual_sandbox_metadata_is_not_plugin_owned(
    cli: ModuleType, monkeypatch: pytest.MonkeyPatch
) -> None:
    create_calls: list[dict[str, object]] = []

    class FakeSandbox:
        sandbox_id = "manual-1"
        _data = {"domain": "sbx.0iq.xyz"}

    monkeypatch.setattr(
        cli.Sandbox,
        "create",
        lambda **kwargs: create_calls.append(kwargs) or FakeSandbox(),
        raising=False,
    )
    monkeypatch.setattr(cli, "resolve_github_token", lambda: "runtime-token")
    settings = cli.load_project_settings(parse(cli, "create"))

    cli.provision_sandbox(parse(cli, "create"), settings)

    assert create_calls[0]["metadata"]["owner"] == "operator-cli"
    assert not any(key.startswith("paseo.") for key in create_calls[0]["metadata"])


def test_dockerfile_pins_tools_and_excludes_identity() -> None:
    dockerfile = DOCKERFILE_PATH.read_text()

    assert (
        "ARG CUBE_BASE_IMAGE="
        "bbcr.0iq.xyz/hakim/cube-hakim-js:71a7eaf6d746-20260917122636"
    ) in dockerfile
    assert "@sha256:" not in dockerfile
    assert '"@getpaseo/cli@${PASEO_VERSION}"' in dockerfile
    assert "https://chatgpt.com/codex/install.sh" in dockerfile
    assert '--release "${CODEX_VERSION}"' in dockerfile
    assert "CODEX_NON_INTERACTIVE=true" in dockerfile
    assert "GH_VERSION=2.95.0" in dockerfile
    assert "GH_SHA256=25d1e4729e8808c9ed3d613e96ebd3f3e44446f2d368c89d878a71a36ddb3d8c" in dockerfile
    assert "github.com/cli/cli/releases/download/v${GH_VERSION}" in dockerfile
    assert "sha256sum --check --strict" in dockerfile
    assert "test ! -e /home/coder/.config/gh/hosts.yml" in dockerfile
    assert "test ! -e /home/coder/.paseo" in dockerfile
    assert "find /home/coder/.ssh /root/.ssh -type f" in dockerfile
    assert "git config --global --get commit.gpgsign" in dockerfile
    assert "git config --global --get user.signingkey" in dockerfile
    assert "git config --global --get core.sshCommand" in dockerfile
    assert "test ! -e /workspace/dotai" in dockerfile
    assert "gh auth setup-git" not in dockerfile
    assert "git init /home/coder/.dotai" not in dockerfile
    assert "github_token" not in dockerfile
    assert 'LABEL io.dotai.runtime-ref="${DOTAI_REF}"' in dockerfile
    assert "releases/download/preview" not in dockerfile


def test_pi_shim_exact_body_and_argument_forwarding(tmp_path: Path) -> None:
    dockerfile = DOCKERFILE_PATH.read_text()
    assert (
        "printf '%s\\n' '#!/usr/bin/env bash' 'set -euo pipefail' "
        "'cd /workspace/dotai/agent' 'exec npm run pi -- \"$@\"'"
    ) in dockerfile

    workspace = tmp_path / "workspace" / "dotai" / "agent"
    workspace.mkdir(parents=True)
    bin_directory = tmp_path / "bin"
    bin_directory.mkdir()
    output = tmp_path / "observed.json"
    fake_npm = bin_directory / "npm"
    fake_npm.write_text(
        "#!/usr/bin/env python3\n"
        "import json, os, sys\n"
        "from pathlib import Path\n"
        "Path(os.environ['PI_SHIM_OUTPUT']).write_text(json.dumps({'cwd': os.getcwd(), 'args': sys.argv[1:]}))\n"
    )
    fake_npm.chmod(0o755)
    shim = tmp_path / "pi"
    shim.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"cd {workspace}\n"
        'exec npm run pi -- "$@"\n'
    )
    shim.chmod(0o755)
    arguments = ["two words", "semi;colon", "$literal", "*.ts", "quote'and\"double"]
    environment = os.environ.copy()
    environment.update(
        {
            "PATH": f"{bin_directory}:{environment['PATH']}",
            "PI_SHIM_OUTPUT": str(output),
        }
    )

    subprocess.run([str(shim), *arguments], check=True, env=environment)

    observed = json.loads(output.read_text())
    assert observed == {
        "cwd": str(workspace),
        "args": ["run", "pi", "--", *arguments],
    }

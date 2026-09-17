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

    class FakeCommands:
        def run(self, command, **kwargs):
            commands.append((command, kwargs["envs"]))
            return SimpleNamespace(stdout="", stderr="", exit_code=0)

    class FakeFiles:
        def write(self, *args, **kwargs):
            return None

    sandbox = SimpleNamespace(commands=FakeCommands(), files=FakeFiles())
    monkeypatch.setattr(cli, "required_git_identity", lambda key: f"test-{key}")
    monkeypatch.setattr(cli, "pi_auth_json", lambda settings: "{}")
    settings = cli.load_project_settings(parse(cli, "create"))

    cli.bootstrap_repository(sandbox, settings, {"GH_TOKEN": "runtime-only"})

    bootstrap, environment = commands[0]
    assert bootstrap.index("gh auth setup-git") > bootstrap.index("gh repo clone")
    assert "npm ci --prefix /workspace/dotai/agent" in bootstrap
    assert "test ! -e /home/coder/.config/gh/hosts.yml" in bootstrap
    assert environment == {"GH_TOKEN": "runtime-only"}
    assert "runtime-only" not in bootstrap


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

    assert "@sha256:9b06483a09d0bdf" in dockerfile
    assert '"@getpaseo/cli@${PASEO_VERSION}"' in dockerfile
    assert '"@openai/codex@${CODEX_VERSION}"' in dockerfile
    assert "GH_VERSION=2.101.0" in dockerfile
    assert "GH_LINUX_AMD64_SHA256=9bca2d1c" in dockerfile
    assert "test ! -e /home/coder/.config/gh/hosts.yml" in dockerfile
    assert "test ! -e /home/coder/.paseo" in dockerfile
    assert "test ! -e /workspace/dotai" in dockerfile
    assert "gh auth setup-git" not in dockerfile
    assert (
        "set -eux"
        not in dockerfile.split("github_token", 1)[1].split("USER root", 1)[0]
    )
    assert "git clone --depth 1" not in dockerfile
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

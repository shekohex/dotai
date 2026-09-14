from __future__ import annotations

import contextlib
import importlib.util
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT_DIR = Path(__file__).resolve().parents[1]
PROFILE_SCRIPT = ROOT_DIR / ".codex" / "paseo-codex-profile.py"


def load_profile_module():
    spec = importlib.util.spec_from_file_location("paseo_codex_profile", PROFILE_SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load {PROFILE_SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class PaseoCodexProfileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.profile = load_profile_module()

    def write_profile(self, codex_home: Path, contents: str) -> None:
        codex_home.mkdir(parents=True, exist_ok=True)
        (codex_home / "litellm.config.toml").write_text(contents)
        (codex_home / "models.json").write_text('{"models": []}\n')

    def test_translates_profile_into_app_server_config_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            codex_home = Path(temporary_directory) / "codex-home"
            self.write_profile(
                codex_home,
                '\n'.join(
                    [
                        'model_provider = "test-provider"',
                        'model_catalog_json = "models.json"',
                        "",
                        "[model_providers.test-provider]",
                        'name = "Test Provider"',
                        "",
                        "[model_providers.test-provider.auth]",
                        'cwd = "~/.codex"',
                    ]
                )
                + "\n",
            )

            with patch.dict(os.environ, {"CODEX_HOME": str(codex_home)}, clear=False):
                with patch.object(self.profile.shutil, "which", return_value="/opt/bin/codex"):
                    command = self.profile.build_command(
                        [
                            "paseo-codex-profile",
                            "litellm",
                            "app-server",
                            "--listen",
                            "stdio://",
                        ]
                    )

            self.assertEqual(command[:2], ["/opt/bin/codex", "app-server"])
            self.assertIn('model_provider="test-provider"', command)
            self.assertIn(
                f'model_catalog_json="{(codex_home / "models.json").resolve()}"',
                command,
            )
            self.assertIn(
                'model_providers.test-provider.name="Test Provider"',
                command,
            )
            self.assertIn(
                f'model_providers.test-provider.auth.cwd="{codex_home.resolve()}"',
                command,
            )
            self.assertEqual(command[-2:], ["--listen", "stdio://"])

    def test_execv_preserves_parent_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            codex_home = Path(temporary_directory) / "codex-home"
            self.write_profile(codex_home, 'model_provider = "test-provider"\n')
            arguments = [
                "paseo-codex-profile",
                "litellm",
                "app-server",
                "--stdio",
            ]

            with patch.dict(
                os.environ,
                {"CODEX_HOME": str(codex_home), "PASEO_WRAPPER_SENTINEL": "kept"},
                clear=False,
            ):
                before_environment = dict(os.environ)
                with patch.object(self.profile.shutil, "which", return_value="/opt/bin/codex"):
                    with patch.object(self.profile.os, "execv") as execv:
                        with patch.object(self.profile.sys, "argv", arguments):
                            self.profile.main()

                self.assertEqual(dict(os.environ), before_environment)
                execv.assert_called_once_with(
                    "/opt/bin/codex",
                    [
                        "/opt/bin/codex",
                        "app-server",
                        "--config",
                        'model_provider="test-provider"',
                        "--stdio",
                    ],
                )

    def test_version_passthrough_uses_resolved_codex(self) -> None:
        with patch.object(self.profile.shutil, "which", return_value="/opt/bin/codex"):
            command = self.profile.build_command(
                ["paseo-codex-profile", "litellm", "--version"]
            )

        self.assertEqual(command, ["/opt/bin/codex", "--version"])

    def test_rejects_unknown_profile_without_shell_execution(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with self.assertRaises(SystemExit) as raised:
                self.profile.build_command(
                    [
                        "paseo-codex-profile",
                        "litellm; touch /tmp/should-not-exist",
                        "app-server",
                    ]
                )

        self.assertEqual(raised.exception.code, 64)
        self.assertIn("unsupported profile", stderr.getvalue())

    def test_reports_missing_codex_and_recursion_actionably(self) -> None:
        missing_stderr = io.StringIO()
        with patch.object(self.profile.shutil, "which", return_value=None):
            with contextlib.redirect_stderr(missing_stderr):
                with self.assertRaises(SystemExit) as missing:
                    self.profile.build_command(
                        ["paseo-codex-profile", "litellm", "app-server"]
                    )

        self.assertEqual(missing.exception.code, 64)
        self.assertIn("codex was not found on PATH", missing_stderr.getvalue())

        recursion_stderr = io.StringIO()
        with patch.object(
            self.profile.shutil,
            "which",
            return_value=str(PROFILE_SCRIPT),
        ):
            with contextlib.redirect_stderr(recursion_stderr):
                with self.assertRaises(SystemExit) as recursion:
                    self.profile.build_command(
                        ["paseo-codex-profile", "litellm", "app-server"]
                    )

        self.assertEqual(recursion.exception.code, 64)
        self.assertIn("refusing recursive codex launch", recursion_stderr.getvalue())

    def test_requires_app_server_after_valid_profile(self) -> None:
        stderr = io.StringIO()
        with patch.object(self.profile.shutil, "which", return_value="/opt/bin/codex"):
            with contextlib.redirect_stderr(stderr):
                with self.assertRaises(SystemExit) as raised:
                    self.profile.build_command(
                        ["paseo-codex-profile", "litellm", "exec"]
                    )

        self.assertEqual(raised.exception.code, 64)
        self.assertIn("Paseo must append app-server", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()

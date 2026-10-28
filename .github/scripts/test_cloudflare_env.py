import json
import os
from pathlib import Path
import stat
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

from cloudflare_env import deployment_summary, main, validate_config, validate_health, write_private_json


class CloudConfigurationTests(unittest.TestCase):
    template = Path(".env.example").read_text()

    def valid(self, **changes):
        values = {
            "DEPLOY_ENABLED": "true",
            "CLOUDFLARE_ACCOUNT_ID": "account",
            "CLOUDFLARE_API_TOKEN": "sample-token",
            "APP_URL": "https://app.example.test",
            "DEPLOYMENT_CHECK_URL": "https://check.example.test",
        }
        values.update(changes)
        return json.dumps(values)

    def test_disabled_configuration_needs_no_keys(self):
        self.assertEqual(
            validate_config('{"DEPLOY_ENABLED":"false"}', self.template, "staging", "deployment-check"),
            {"DEPLOY_ENABLED": "false"},
        )

    def test_active_test_configuration_is_accepted(self):
        result = validate_config(self.valid(), self.template, "staging", "deployment-check")
        self.assertEqual(result["CLOUDFLARE_API_TOKEN"], "sample-token")

    def test_unknown_environment_injection_is_rejected(self):
        with self.assertRaises(ValueError):
            validate_config(self.valid(GITHUB_ENV="/tmp/other"), self.template, "staging", "deployment-check")

    def test_bad_types_and_multiline_values_are_rejected(self):
        for raw in ("[]", "null", self.valid(CLOUDFLARE_API_TOKEN=123),
                    self.valid(CLOUDFLARE_API_TOKEN="first\nsecond")):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                validate_config(raw, self.template, "staging", "deployment-check")

    def test_missing_token_and_non_https_origins_are_rejected(self):
        for changes in (
            {"CLOUDFLARE_API_TOKEN": ""},
            {"DEPLOYMENT_CHECK_URL": ""},
            {"DEPLOYMENT_CHECK_URL": "http://example.test"},
            {"DEPLOYMENT_CHECK_URL": "https://user:password@example.test"},
            {"DEPLOYMENT_CHECK_URL": "https://example.test/path"},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_config(self.valid(**changes), self.template, "staging", "deployment-check")

        for changes in (
            {"APP_URL": ""},
            {"APP_URL": "http://example.test"},
            {"APP_URL": "https://user:password@example.test"},
            {"APP_URL": "https://example.test/path"},
        ):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_config(self.valid(**changes), self.template, "staging", "application")

    def test_application_requires_its_own_runtime_configuration(self):
        with self.assertRaises(ValueError):
            validate_config(self.valid(), self.template, "production", "application")

    def test_staging_auth_can_deploy_before_media_ai_and_map_are_connected(self):
        values = json.loads(self.valid()) | {
            "APP_ENV": "staging", "FIREBASE_PROJECT_ID": "sample-project",
            "VITE_FIREBASE_PROJECT_ID": "sample-project", "VITE_FIREBASE_API_KEY": "browser-key",
            "VITE_FIREBASE_AUTH_DOMAIN": "sample-project.firebaseapp.com", "VITE_FIREBASE_APP_ID": "sample-app",
        }
        self.assertEqual(validate_config(json.dumps(values), self.template, "staging", "application"), values)
        values["VITE_FIREBASE_PROJECT_ID"] = "another-project"
        with self.assertRaisesRegex(ValueError, "projects must match"):
            validate_config(json.dumps(values), self.template, "staging", "application")

    def test_deployment_url_is_only_published_after_release_health_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "iskra-environment.json"
            config.write_text(self.valid())
            output = Path(directory) / "outputs"
            env = {"RUNNER_TEMP": directory, "GITHUB_OUTPUT": str(output), "GITHUB_SHA": "abc123"}
            with patch.dict(os.environ, env), patch.object(sys, "argv", ["cloudflare_env.py", "smoke", "staging", "application"]):
                with patch("cloudflare_env.subprocess.check_output", return_value='{"ok":true,"release":"old"}'):
                    with self.assertRaises(ValueError): main()
                self.assertFalse(output.exists())
                with patch("cloudflare_env.subprocess.check_output", return_value='{"ok":true,"release":"abc123"}'):
                    main()
                self.assertEqual(output.read_text(), "verified_url=https://app.example.test\n")

    def test_preparation_excludes_deployment_and_migration_keys_from_worker(self):
        values = json.loads(self.valid()) | {
            "APP_ENV": "staging", "GEMINI_API_KEY": "sample-gemini-key",
            "MEDIA_SIGNING_SECRET": "sample-signing-key", "GEMINI_MODEL_ID": "sample-model",
            "FIREBASE_PROJECT_ID": "sample-project", "VITE_FIREBASE_API_KEY": "sample-browser-key",
            "VITE_FIREBASE_PROJECT_ID": "sample-project", "VITE_FIREBASE_AUTH_DOMAIN": "sample-project.firebaseapp.com",
            "VITE_FIREBASE_APP_ID": "sample-app",
            "VITE_MAPTILER_KEY": "sample-map-key", "MIGRATION_DATABASE_URL": "postgres://operator",
        }
        with tempfile.TemporaryDirectory() as directory:
            env = os.environ | {
                "CLOUD_ENV_JSON": json.dumps(values), "RUNNER_TEMP": directory,
                "GITHUB_OUTPUT": str(Path(directory) / "outputs"),
            }
            subprocess.run([sys.executable, ".github/scripts/cloudflare_env.py", "prepare",
                            "staging", "application"], env=env, check=True, capture_output=True)
            runtime = json.loads((Path(directory) / "iskra-worker-secrets.json").read_text())
            outputs = (Path(directory) / "outputs").read_text()
            self.assertEqual(runtime["GEMINI_API_KEY"], "sample-gemini-key")
            self.assertIn("target_url=https://app.example.test\n", outputs)
            self.assertNotIn("sample-token", outputs)
            for name in ("CLOUDFLARE_API_TOKEN", "MIGRATION_DATABASE_URL", "VITE_MAPTILER_KEY"):
                self.assertNotIn(name, runtime)

    def test_preparation_selects_the_infrastructure_check_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "outputs"
            env = os.environ | {
                "CLOUD_ENV_JSON": self.valid(), "RUNNER_TEMP": directory,
                "GITHUB_OUTPUT": str(output),
            }
            subprocess.run([sys.executable, ".github/scripts/cloudflare_env.py", "prepare",
                            "staging", "deployment-check"], env=env, check=True, capture_output=True)
            self.assertIn("target_url=https://check.example.test\n", output.read_text())

    def test_disabled_deployment_does_not_publish_a_target_url(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "outputs"
            env = os.environ | {
                "CLOUD_ENV_JSON": '{"DEPLOY_ENABLED":"false"}', "RUNNER_TEMP": directory,
                "GITHUB_OUTPUT": str(output),
            }
            subprocess.run([sys.executable, ".github/scripts/cloudflare_env.py", "prepare",
                            "staging", "application"], env=env, check=True, capture_output=True)
            self.assertNotIn("target_url=", output.read_text())
            self.assertFalse((Path(directory) / "iskra-environment.json").exists())

    def test_deployment_summary_links_only_after_exact_release_health_passes(self):
        summary = deployment_summary(
            "true", "application", 'https://iskra.test/?x=" onclick="bad', "abc123", "success",
        )
        self.assertIn('href="https://iskra.test/?x=&quot; onclick=&quot;bad"', summary)
        self.assertIn("`abc123`", summary)
        self.assertIn("Exact-release health check: PASS", summary)
        self.assertIn("no Cloudflare write occurred", deployment_summary("false", "application", "", "", ""))
        self.assertIn("no deployment link", deployment_summary("true", "application", "https://iskra.test", "abc", "failure"))
        self.assertIn("no target URL", deployment_summary("true", "application", "", "abc", "success"))

    def test_summary_survives_missing_target_when_config_validation_failed(self):
        result = subprocess.run(
            [sys.executable, ".github/scripts/cloudflare_env.py", "summary", "staging", ""],
            env=os.environ | {"DEPLOY_ENABLED": "", "TARGET_URL": "", "SMOKE_OUTCOME": ""},
            check=True, capture_output=True, text=True,
        )
        self.assertIn("Deployment configuration did not validate", result.stdout)
        self.assertNotIn("Open deployed", result.stdout)

    def test_application_smoke_rejects_infrastructure_worker_at_same_release(self):
        health = {
            "ok": True, "service": "iskra-deployment-check",
            "applicationReady": False, "release": "abc123",
        }
        with self.assertRaisesRegex(ValueError, "infrastructure-check Worker"):
            validate_health(health, "application", "abc123")

    def test_application_smoke_accepts_product_health_identity(self):
        validate_health(
            {"ok": True, "applicationReady": False, "release": "abc123"},
            "application", "abc123",
        )

    def test_infrastructure_smoke_rejects_product_worker_with_same_release(self):
        with self.assertRaisesRegex(ValueError, "infrastructure-check Worker"):
            validate_health(
                {"ok": True, "service": "iskra", "applicationReady": False, "release": "abc123"},
                "deployment-check", "abc123",
            )

    def test_infrastructure_smoke_accepts_only_check_worker_identity(self):
        validate_health(
            {"ok": True, "service": "iskra-deployment-check", "applicationReady": False, "release": "abc123"},
            "deployment-check", "abc123",
        )

    def test_secret_file_is_private_and_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "keys.json"
            write_private_json(path, {"key": "value"})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                write_private_json(path, {})


if __name__ == "__main__":
    unittest.main()

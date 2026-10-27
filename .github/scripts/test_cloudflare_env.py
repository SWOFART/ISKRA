import json
import os
from pathlib import Path
import stat
import tempfile
import subprocess
import sys
import unittest

from cloudflare_env import validate_config, write_private_json


class CloudConfigurationTests(unittest.TestCase):
    template = Path(".env.example").read_text()

    def valid(self, **changes):
        values = {
            "DEPLOY_ENABLED": "true",
            "CLOUDFLARE_ACCOUNT_ID": "account",
            "CLOUDFLARE_API_TOKEN": "sample-token",
            "APP_URL": "https://example.test",
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
        for values in ({"CLOUDFLARE_API_TOKEN": ""}, {"APP_URL": "http://example.test"},
                       {"APP_URL": "https://user:password@example.test"},
                       {"APP_URL": "https://example.test/path"}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                validate_config(self.valid(**values), self.template, "staging", "deployment-check")

    def test_application_requires_its_own_runtime_configuration(self):
        with self.assertRaises(ValueError):
            validate_config(self.valid(), self.template, "production", "application")

    def test_preparation_excludes_deployment_and_migration_keys_from_worker(self):
        values = json.loads(self.valid()) | {
            "APP_ENV": "staging", "GEMINI_API_KEY": "sample-gemini-key",
            "MEDIA_SIGNING_SECRET": "sample-signing-key", "GEMINI_MODEL_ID": "sample-model",
            "FIREBASE_PROJECT_ID": "sample-project", "VITE_FIREBASE_API_KEY": "sample-browser-key",
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
            self.assertEqual(runtime["GEMINI_API_KEY"], "sample-gemini-key")
            for name in ("CLOUDFLARE_API_TOKEN", "MIGRATION_DATABASE_URL", "VITE_MAPTILER_KEY"):
                self.assertNotIn(name, runtime)

    def test_secret_file_is_private_and_cannot_be_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "keys.json"
            write_private_json(path, {"key": "value"})
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                write_private_json(path, {})


if __name__ == "__main__":
    unittest.main()

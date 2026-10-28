import json
import os
from pathlib import Path
import stat
import tempfile
import subprocess
import sys
import unittest
from unittest.mock import patch

from cloudflare_env import (
    SMOKE_MAX_ATTEMPTS, deployment_summary, main, validate_config,
    validate_health, write_private_json, write_hyperdrive_config, assert_public_assets,
)


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

    def test_staging_requires_a_public_map_key_but_media_ai_can_remain_off(self):
        values = json.loads(self.valid()) | {
            "APP_ENV": "staging", "FIREBASE_PROJECT_ID": "sample-project",
            "VITE_FIREBASE_PROJECT_ID": "sample-project", "VITE_FIREBASE_API_KEY": "browser-key",
            "VITE_FIREBASE_AUTH_DOMAIN": "sample-project.firebaseapp.com", "VITE_FIREBASE_APP_ID": "sample-app",
        }
        with self.assertRaisesRegex(ValueError, "VITE_MAPTILER_KEY"):
            validate_config(json.dumps(values), self.template, "staging", "application")
        values["VITE_MAPTILER_KEY"] = "sample-map-key"
        self.assertEqual(validate_config(json.dumps(values), self.template, "staging", "application"), values)
        values["VITE_FIREBASE_PROJECT_ID"] = "another-project"
        with self.assertRaisesRegex(ValueError, "projects must match"):
            validate_config(json.dumps(values), self.template, "staging", "application")

    def test_hyperdrive_binding_is_generated_only_for_selected_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wrangler.json"
            write_hyperdrive_config(path, "staging", "a" * 32)
            config = json.loads(path.read_text())
            self.assertEqual(config["env"]["staging"]["hyperdrive"], [{"binding": "HYPERDRIVE", "id": "a" * 32}])
            self.assertNotIn("hyperdrive", config["env"]["production"])
            self.assertTrue(Path(config["main"]).is_absolute())
            self.assertEqual(Path(config["env"]["staging"]["assets"]["directory"]), Path.cwd() / "dist/client")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertNotIn("CLOUDFLARE_API_TOKEN", path.read_text())

    def test_vertex_identity_cannot_cross_environment_or_origin(self):
        values = json.loads(self.valid()) | {
            "APP_ENV": "staging", "FIREBASE_PROJECT_ID": "sample-project",
            "VITE_FIREBASE_PROJECT_ID": "sample-project", "VITE_FIREBASE_API_KEY": "browser-key",
            "VITE_FIREBASE_AUTH_DOMAIN": "sample-project.firebaseapp.com", "VITE_FIREBASE_APP_ID": "sample-app",
            "VITE_MAPTILER_KEY": "map-key",
        }
        identity = {"environment": "staging", "issuer": "https://app.example.test",
                    "projectId": "sample-project", "audience": "test-audience", "subject": "worker",
                    "serviceAccountEmail": "test-account", "privateKey": "test-only-key", "keyId": "test-only-id"}
        for change in ({"environment": "production"}, {"issuer": "https://foreign.test"}, {"privateKey": ""}):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "Vertex identity"):
                validate_config(json.dumps(values | {"VERTEX_AUTH_JSON": json.dumps(identity | change)}),
                                self.template, "staging", "application")
        with self.assertRaisesRegex(ValueError, "Vertex identity"):
            validate_config(json.dumps(values | {"VERTEX_AUTH_JSON": "{invalid"}),
                            self.template, "staging", "application")

    def test_malformed_hyperdrive_identifier_is_rejected_before_deploy(self):
        with self.assertRaisesRegex(ValueError, "HYPERDRIVE_ID"):
            validate_config(self.valid(HYPERDRIVE_ID="../wrong"), self.template, "staging", "application")

    def test_smoke_retries_stale_200_until_exact_release_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "iskra-environment.json"
            config.write_text(self.valid())
            output = Path(directory) / "outputs"
            output.touch()
            env = {"RUNNER_TEMP": directory, "GITHUB_OUTPUT": str(output), "GITHUB_SHA": "abc123"}
            with patch.dict(os.environ, env), patch.object(sys, "argv", ["cloudflare_env.py", "smoke", "staging", "application"]):
                with patch("cloudflare_env.time.sleep") as sleep, patch(
                    "cloudflare_env.subprocess.check_output",
                    side_effect=[
                        '{"ok":true,"release":"old"}',
                        '{"ok":true,"release":"abc123"}',
                    ],
                ) as fetch:
                    main()
                self.assertEqual(fetch.call_count, 2)
                sleep.assert_called_once_with(3)
                self.assertNotIn("--retry", fetch.call_args_list[0].args[0])
                self.assertEqual(output.read_text(), "verified_url=https://app.example.test\n")

    def test_permanently_stale_health_never_publishes_verified_url(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "iskra-environment.json"
            config.write_text(self.valid())
            output = Path(directory) / "outputs"
            output.touch()
            env = {"RUNNER_TEMP": directory, "GITHUB_OUTPUT": str(output), "GITHUB_SHA": "abc123"}
            with patch.dict(os.environ, env), patch.object(sys, "argv", ["cloudflare_env.py", "smoke", "staging", "application"]):
                with patch("cloudflare_env.time.sleep") as sleep, patch(
                    "cloudflare_env.subprocess.check_output",
                    return_value='{"ok":true,"release":"old"}',
                ) as fetch:
                    with self.assertRaisesRegex(ValueError, "bounded retry window"):
                        main()
            self.assertEqual(fetch.call_count, SMOKE_MAX_ATTEMPTS)
            self.assertEqual(sleep.call_count, SMOKE_MAX_ATTEMPTS - 1)
            self.assertEqual(output.read_text(), "")

    def test_network_and_invalid_responses_are_retried_without_sleeping_in_unit_test(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "iskra-environment.json"
            config.write_text(self.valid())
            output = Path(directory) / "outputs"
            output.touch()
            env = {"RUNNER_TEMP": directory, "GITHUB_OUTPUT": str(output), "GITHUB_SHA": "abc123"}
            responses = [
                subprocess.CalledProcessError(7, ["curl"]),
                "not-json",
                '{"ok":true,"release":"abc123"}',
            ]
            with patch.dict(os.environ, env), patch.object(sys, "argv", ["cloudflare_env.py", "smoke", "staging", "application"]):
                with patch("cloudflare_env.time.sleep") as sleep, patch(
                    "cloudflare_env.subprocess.check_output", side_effect=responses,
                ) as fetch:
                    main()
            self.assertEqual(fetch.call_count, 3)
            self.assertEqual(sleep.call_count, 2)
            self.assertEqual(output.read_text(), "verified_url=https://app.example.test\n")

    def test_preparation_excludes_deployment_and_migration_keys_from_worker(self):
        values = json.loads(self.valid()) | {
            "APP_ENV": "staging", "VERTEX_AUTH_JSON": json.dumps({"environment": "staging", "issuer": "https://app.example.test", "projectId": "sample-project", "audience": "test-audience", "subject": "worker", "serviceAccountEmail": "test-account", "privateKey": "test-only-key", "keyId": "test-only-id"}),
            "MEDIA_SIGNING_SECRET": "sample-signing-key", "GEMINI_MODEL_ID": "sample-model",
            "FIREBASE_PROJECT_ID": "sample-project", "VITE_FIREBASE_API_KEY": "sample-browser-key",
            "VITE_FIREBASE_PROJECT_ID": "sample-project", "VITE_FIREBASE_AUTH_DOMAIN": "sample-project.firebaseapp.com",
            "VITE_FIREBASE_APP_ID": "sample-app",
            "VITE_MAPTILER_KEY": "sample-map-key", "MIGRATION_DATABASE_URL": "postgres://operator",
            "HYPERDRIVE_ID": "a" * 32,
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
            self.assertEqual(runtime["VERTEX_AUTH_JSON"], values["VERTEX_AUTH_JSON"])
            self.assertIn("target_url=https://app.example.test\n", outputs)
            self.assertNotIn("sample-token", outputs)
            generated = json.loads((Path(directory) / "iskra-wrangler.json").read_text())
            self.assertEqual(generated["env"]["staging"]["hyperdrive"][0]["id"], "a" * 32)
            for name in ("CLOUDFLARE_API_TOKEN", "MIGRATION_DATABASE_URL", "VITE_MAPTILER_KEY", "HYPERDRIVE_ID"):
                self.assertNotIn(name, runtime)

    def test_deployment_passes_generated_hyperdrive_config_to_wrangler(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "iskra-environment.json").write_text(self.valid(HYPERDRIVE_ID="a" * 32))
            env = {"RUNNER_TEMP": directory, "GITHUB_SHA": "release-sha"}
            with patch.dict(os.environ, env), patch.object(sys, "argv", ["cloudflare_env.py", "deploy", "staging", "application"]):
                with patch("cloudflare_env.assert_public_assets") as scan, patch("cloudflare_env.subprocess.run") as deploy:
                    main()
            scan.assert_called_once_with(Path("dist/client"), json.loads(self.valid(HYPERDRIVE_ID="a" * 32)))
            command = deploy.call_args.args[0]
            self.assertIn("--config", command)
            self.assertEqual(command[command.index("--config") + 1], str(Path(directory) / "iskra-wrangler.json"))
            self.assertNotIn("HYPERDRIVE_ID", deploy.call_args.kwargs["env"])

    def test_known_server_credentials_and_signing_keys_cannot_enter_public_assets(self):
        values = {"CLOUDFLARE_API_TOKEN": "private-deploy-token-for-test",
                  "MEDIA_SIGNING_SECRET": "private-media-key-for-test",
                  "MIGRATION_DATABASE_URL": "postgres://private:password@private-db/iskra",
                  "VERTEX_AUTH_JSON": json.dumps({"privateKey": "private-worker-signing-key\nsecond-line"})}
        leaked = [*values.values(), "private-worker-signing-key\nsecond-line",
                  json.dumps("private-worker-signing-key\nsecond-line")[1:-1],
                  "-----BEGIN PRIVATE KEY-----", "-----BEGIN RSA PRIVATE KEY-----"]
        for secret in leaked:
            with self.subTest(case=len(secret)), tempfile.TemporaryDirectory() as folder:
                directory = Path(folder)
                (directory / "index.html").write_text("<main>ISKRA</main>")
                # Covers binary/static assets and source maps, not only JavaScript.
                (directory / "app.js.map").write_bytes(b"prefix:" + secret.encode() + b":suffix")
                with self.assertRaisesRegex(ValueError, "server credential") as error:
                    assert_public_assets(directory, values)
                self.assertNotIn(secret, str(error.exception))

    def test_browser_keys_are_public_but_missing_assets_and_symlinks_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            with self.assertRaisesRegex(ValueError, "Build the application"):
                assert_public_assets(directory, {})
            (directory / "index.html").write_text("public-firebase-key public-map-key")
            assert_public_assets(directory, {"VITE_FIREBASE_API_KEY": "public-firebase-key",
                                             "VITE_MAPTILER_KEY": "public-map-key"})
            (directory / "linked.js").symlink_to(directory / "index.html")
            with self.assertRaisesRegex(ValueError, "symbolic links"):
                assert_public_assets(directory, {})

    def test_credential_scan_failure_prevents_wrangler_from_running(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory) / "iskra-environment.json").write_text(self.valid())
            with patch.dict(os.environ, {"RUNNER_TEMP": directory}), patch.object(
                sys, "argv", ["cloudflare_env.py", "deploy", "staging", "application"],
            ), patch("cloudflare_env.assert_public_assets", side_effect=ValueError("unsafe assets")), patch(
                "cloudflare_env.subprocess.run",
            ) as deploy:
                with self.assertRaisesRegex(ValueError, "unsafe assets"):
                    main()
                deploy.assert_not_called()

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

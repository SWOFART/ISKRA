"""Read Google-sourced configuration without storing values in GitHub settings."""

import html
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import time
from urllib.parse import urlsplit


RUNTIME_KEYS = {
    "APP_ENV", "FIREBASE_PROJECT_ID", "VERTEX_AUTH_JSON", "GEMINI_MODEL_ID",
    "MEDIA_SIGNING_SECRET", "GCS_PHOTOS_BUCKET", "VOTE_RADIUS_M", "MAX_GPS_ACCURACY_M",
    "LOCATION_MAX_AGE_SECONDS", "REPORTER_REWARD_RP", "GREEN_CLEANER_REWARD_RP",
    "PHOTO_MAX_BYTES", "AI_RATE_PER_MINUTE", "DEMO_DATA",
}
PRIVATE_KEYS = {
    "CLOUDFLARE_API_TOKEN", "VERTEX_AUTH_JSON", "MEDIA_SIGNING_SECRET",
    "VITE_FIREBASE_API_KEY", "VITE_MAPTILER_KEY", "MIGRATION_DATABASE_URL",
}
SMOKE_MAX_ATTEMPTS = 7
SMOKE_REQUEST_TIMEOUT_SECONDS = 10
SMOKE_PROCESS_TIMEOUT_SECONDS = 12
SMOKE_RETRY_DELAY_SECONDS = 3


def validate_config(raw, template, environment, target):
    values = json.loads(raw)
    allowed = {
        line.split("=", 1)[0]
        for line in template.splitlines()
        if line and not line.startswith("#")
    }
    if not isinstance(values, dict) or values.keys() - allowed:
        raise ValueError("Cloud configuration contains undocumented keys")
    if any(not isinstance(value, str) or any(c in value for c in "\r\n\0")
           for value in values.values()):
        raise ValueError("Cloud configuration values must be single-line strings")
    if values.get("DEPLOY_ENABLED") not in ("true", "false"):
        raise ValueError("DEPLOY_ENABLED must be explicitly true or false in Google Cloud")
    if values["DEPLOY_ENABLED"] == "false":
        return values
    url_name = "APP_URL" if target == "application" else "DEPLOYMENT_CHECK_URL"
    for name in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", url_name):
        if not values.get(name):
            raise ValueError(f"Required cloud configuration is missing: {name}")
    url = urlsplit(values[url_name])
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ("", "/")):
        raise ValueError(f"{url_name} must be an HTTPS origin")
    if target == "application":
        if values.get("HYPERDRIVE_ID") and not re.fullmatch(r"[0-9a-f]{32}", values["HYPERDRIVE_ID"]):
            raise ValueError("HYPERDRIVE_ID must be a Cloudflare configuration identifier")
        required = ["FIREBASE_PROJECT_ID", "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN",
                    "VITE_FIREBASE_PROJECT_ID", "VITE_FIREBASE_APP_ID", "VITE_MAPTILER_KEY"]
        if environment == "production":
            required += ["VERTEX_AUTH_JSON", "MEDIA_SIGNING_SECRET", "GEMINI_MODEL_ID", "GCS_PHOTOS_BUCKET"]
        for name in required:
            if not values.get(name):
                raise ValueError(f"Required cloud configuration is missing: {name}")
        if values["VITE_FIREBASE_PROJECT_ID"] != values["FIREBASE_PROJECT_ID"]:
            raise ValueError("Browser and Worker Firebase projects must match")
        if values["VITE_FIREBASE_AUTH_DOMAIN"] != values["FIREBASE_PROJECT_ID"] + ".firebaseapp.com":
            raise ValueError("Firebase auth domain must match the configured project")
        if values.get("APP_ENV") != environment:
            raise ValueError("APP_ENV must match the deployment environment")
        if values.get("VERTEX_AUTH_JSON"):
            try:
                identity = json.loads(values["VERTEX_AUTH_JSON"])
                valid = (isinstance(identity, dict)
                         and identity.get("environment") == environment
                         and identity.get("issuer") == values["APP_URL"].rstrip("/")
                         and all(isinstance(identity.get(key), str) and identity[key]
                                 for key in ("projectId", "audience", "subject", "serviceAccountEmail", "privateKey", "keyId")))
            except (ValueError, TypeError):
                valid = False
            if not valid:
                raise ValueError("Vertex identity must match the deployment environment and application origin")
        if values.get("GCS_PHOTOS_BUCKET"):
            if (not values.get("HYPERDRIVE_ID") or not values.get("VERTEX_AUTH_JSON")
                    or len(values.get("MEDIA_SIGNING_SECRET", "").encode()) < 32):
                raise ValueError("Cloud Storage requires Hyperdrive, Google identity and a media signing secret of at least 32 bytes")
            if values["GCS_PHOTOS_BUCKET"] != f"{identity['projectId']}-{environment}-photos":
                raise ValueError("GCS_PHOTOS_BUCKET must match the Google project and deployment environment")
        if environment == "production" and values.get("DEMO_DATA") != "false":
            raise ValueError("Production requires DEMO_DATA=false")
    return values


def write_private_json(path, values):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(values, output)


def assert_public_assets(directory, values):
    """Reject known server credentials in the public build without printing them."""
    if not directory.is_dir() or not (directory / "index.html").is_file():
        raise ValueError("Build the application assets before deployment")
    secrets = {values[name] for name in PRIVATE_KEYS
               if not name.startswith("VITE_") and values.get(name)}
    if values.get("VERTEX_AUTH_JSON"):
        identity = json.loads(values["VERTEX_AUTH_JSON"])
        if identity.get("privateKey"):
            secrets.add(identity["privateKey"])
    patterns = {value.encode() for secret in secrets
                for value in (secret, json.dumps(secret)[1:-1])}
    for path in directory.rglob("*"):
        if path.is_symlink():
            raise ValueError("Public build must not contain symbolic links")
        if path.is_file():
            content = path.read_bytes()
            if (any(pattern in content for pattern in patterns)
                    or re.search(rb"-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----", content)):
                raise ValueError("Public build contains a server credential; deployment refused")


def write_hyperdrive_config(path, environment, configuration_id):
    root = Path.cwd().resolve()
    config = json.loads((root / "wrangler.jsonc").read_text())
    config["env"][environment]["hyperdrive"] = [{"binding": "HYPERDRIVE", "id": configuration_id}]
    # Wrangler resolves paths relative to this temporary config, not the repository.
    for settings in [config, *config.get("env", {}).values()]:
        if "main" in settings:
            settings["main"] = str((root / settings["main"]).resolve())
        if "assets" in settings:
            settings["assets"]["directory"] = str((root / settings["assets"]["directory"]).resolve())
    config.pop("$schema", None)
    write_private_json(path, config)


def deployment_summary(enabled, target, target_url, release, smoke_outcome):
    if enabled == "false":
        return "Google configuration was retrieved. Deployment is disabled; no Cloudflare write occurred.\n"
    if enabled != "true":
        return "Deployment configuration did not validate; no deployment link is available.\n"
    if smoke_outcome != "success":
        return "Deployment did not pass its release health check; no deployment link is being reported as live.\n"
    if not target_url:
        return "Deployment passed its release health check, but no target URL was provided.\n"
    url = html.escape(target_url, quote=True)
    return ("## Cloudflare deployment\n\n"
            f"- Target: `{target}`\n"
            f"- Release: `{release}`\n"
            f'- <a href="{url}">Open deployed {html.escape(target)}</a>\n'
            "- Exact-release health check: PASS\n"
            "- Product acceptance is tracked separately.\n")


def validate_health(health, target, release):
    if health.get("ok") is not True or health.get("release") != release:
        raise ValueError("The expected release is not healthy")
    if target == "application" and health.get("service") == "iskra-deployment-check":
        raise ValueError("APP_URL points to the infrastructure-check Worker, not the application")
    if target == "deployment-check" and (
        health.get("service") != "iskra-deployment-check"
        or health.get("applicationReady") is not False
    ):
        raise ValueError("Expected the infrastructure-check Worker")


def main():
    mode, environment, target = sys.argv[1:]
    if mode == "summary":
        print(deployment_summary(
            os.environ.get("DEPLOY_ENABLED", ""), target,
            os.environ.get("TARGET_URL", ""), os.environ.get("GITHUB_SHA", ""),
            os.environ.get("SMOKE_OUTCOME", ""),
        ), end="")
        return
    if environment not in ("staging", "production"):
        raise ValueError("Unknown deployment environment")
    if target == "auto":
        target = "application" if Path("package.json").is_file() else "deployment-check"
    if target not in ("application", "deployment-check"):
        raise ValueError("Unknown deployment target")
    if environment == "production" and target != "application":
        raise ValueError("The test Worker cannot deploy as production")
    folder = Path(os.environ["RUNNER_TEMP"])
    config_path = folder / "iskra-environment.json"
    runtime_path = folder / "iskra-worker-secrets.json"
    wrangler_path = folder / "iskra-wrangler.json"

    if mode == "prepare":
        values = validate_config(os.environ["CLOUD_ENV_JSON"],
                                 Path(".env.example").read_text(), environment, target)
        for name in PRIVATE_KEYS:
            if values.get(name):
                value = values[name].replace("%", "%25")
                print(f"::add-mask::{value}")
        enabled = values["DEPLOY_ENABLED"]
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"enabled={enabled}\ntarget={target}\n")
            if enabled == "true":
                url_name = "APP_URL" if target == "application" else "DEPLOYMENT_CHECK_URL"
                output.write(f"target_url={values[url_name]}\n")
        if enabled == "false":
            print("::notice::Deployment is disabled in Google Cloud; no Cloudflare write occurred.")
            return
        write_private_json(config_path, values)
        if target == "application":
            runtime = {name: value for name, value in values.items() if name in RUNTIME_KEYS and value}
            write_private_json(runtime_path, runtime)
            if values.get("HYPERDRIVE_ID"):
                write_hyperdrive_config(wrangler_path, environment, values["HYPERDRIVE_ID"])
        return

    values = json.loads(config_path.read_text())
    if mode in ("build", "deploy"):
        process_env = os.environ.copy()
        process_env["CLOUDFLARE_ENV"] = environment
        project = "." if target == "application" else "infra/deployment-check"
        if mode == "build":
            process_env.update({key: value for key, value in values.items() if key.startswith("VITE_")})
            command = ["npm", "run", "build"]
        else:
            if target == "application":
                assert_public_assets(Path("dist/client"), values)
            process_env.update({key: values[key] for key in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")})
            command = ["npm", "exec", "--no", "--", "wrangler", "deploy", "--env", environment,
                       "--var", "RELEASE_SHA:" + os.environ["GITHUB_SHA"]]
            if target == "application":
                command += ["--secrets-file", str(runtime_path)]
                if values.get("HYPERDRIVE_ID"):
                    command += ["--config", str(wrangler_path)]
        subprocess.run(command, cwd=project, env=process_env, check=True)
    elif mode == "smoke":
        url_name = "APP_URL" if target == "application" else "DEPLOYMENT_CHECK_URL"
        release = os.environ["GITHUB_SHA"]
        url = values[url_name].rstrip("/") + "/api/health?release=" + release
        for attempt in range(SMOKE_MAX_ATTEMPTS):
            health = None
            try:
                result = subprocess.check_output([
                    "curl", "--fail", "--silent", "--show-error",
                    "--max-time", str(SMOKE_REQUEST_TIMEOUT_SECONDS), url,
                ], text=True, timeout=SMOKE_PROCESS_TIMEOUT_SECONDS)
                health = json.loads(result)
                if not isinstance(health, dict):
                    raise ValueError("Health endpoint returned a non-object response")
                validate_health(health, target, release)
            except (subprocess.SubprocessError, json.JSONDecodeError) as error:
                failure = error
            except ValueError as error:
                if isinstance(health, dict) and health.get("ok") is True and health.get("release") == release:
                    raise
                failure = error
            else:
                break
            if attempt + 1 < SMOKE_MAX_ATTEMPTS:
                time.sleep(SMOKE_RETRY_DELAY_SECONDS)
        else:
            raise ValueError("Release health check did not pass within the bounded retry window") from failure
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write(f"verified_url={values[url_name]}\n")
        print("Deployment release health check passed")
    else:
        raise ValueError("Unknown configuration operation")


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))

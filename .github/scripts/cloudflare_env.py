"""Read Google-sourced configuration without storing values in GitHub settings."""

import html
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit


RUNTIME_KEYS = {
    "APP_ENV", "FIREBASE_PROJECT_ID", "GEMINI_API_KEY", "GEMINI_MODEL_ID",
    "MEDIA_SIGNING_SECRET", "VOTE_RADIUS_M", "MAX_GPS_ACCURACY_M",
    "LOCATION_MAX_AGE_SECONDS", "REPORTER_REWARD_RP", "GREEN_CLEANER_REWARD_RP",
    "PHOTO_MAX_BYTES", "AI_RATE_PER_MINUTE", "DEMO_DATA",
}
PRIVATE_KEYS = {
    "CLOUDFLARE_API_TOKEN", "GEMINI_API_KEY", "MEDIA_SIGNING_SECRET",
    "VITE_FIREBASE_API_KEY", "VITE_MAPTILER_KEY", "MIGRATION_DATABASE_URL",
}


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
    for name in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "APP_URL"):
        if not values.get(name):
            raise ValueError(f"Required cloud configuration is missing: {name}")
    url = urlsplit(values["APP_URL"])
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ("", "/")):
        raise ValueError("APP_URL must be an HTTPS origin")
    if target == "application":
        for name in ("GEMINI_API_KEY", "MEDIA_SIGNING_SECRET", "GEMINI_MODEL_ID",
                     "FIREBASE_PROJECT_ID", "VITE_FIREBASE_API_KEY", "VITE_MAPTILER_KEY"):
            if not values.get(name):
                raise ValueError(f"Required cloud configuration is missing: {name}")
        if values.get("APP_ENV") != environment:
            raise ValueError("APP_ENV must match the deployment environment")
        if environment == "production" and values.get("DEMO_DATA") != "false":
            raise ValueError("Production requires DEMO_DATA=false")
    return values


def write_private_json(path, values):
    with open(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "w") as output:
        json.dump(values, output)


def deployment_summary(enabled, target, app_url, release, smoke_outcome):
    if enabled == "false":
        return "Google configuration was retrieved. Deployment is disabled; no Cloudflare write occurred.\n"
    if enabled != "true":
        return "Deployment configuration did not validate; no deployment link is available.\n"
    if smoke_outcome != "success":
        return "Deployment did not pass its release health check; no app link is being reported as live.\n"
    if not app_url:
        return "Deployment passed its release health check, but no APP_URL was provided.\n"
    url = html.escape(app_url, quote=True)
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
    if target == "deployment-check" and health.get("applicationReady") is not False:
        raise ValueError("Expected the infrastructure-check Worker")


def main():
    mode, environment, target = sys.argv[1:]
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
                output.write(f"app_url={values['APP_URL']}\n")
        if enabled == "false":
            print("::notice::Deployment is disabled in Google Cloud; no Cloudflare write occurred.")
            return
        write_private_json(config_path, values)
        if target == "application":
            runtime = {name: value for name, value in values.items() if name in RUNTIME_KEYS and value}
            write_private_json(runtime_path, runtime)
        return

    if mode == "summary":
        print(deployment_summary(
            os.environ.get("DEPLOY_ENABLED", ""), target,
            os.environ.get("APP_URL", ""), os.environ.get("GITHUB_SHA", ""),
            os.environ.get("SMOKE_OUTCOME", ""),
        ), end="")
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
            process_env.update({key: values[key] for key in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")})
            command = ["npm", "exec", "--no", "--", "wrangler", "deploy", "--env", environment,
                       "--var", "RELEASE_SHA:" + os.environ["GITHUB_SHA"]]
            if target == "application":
                command += ["--secrets-file", str(runtime_path)]
        subprocess.run(command, cwd=project, env=process_env, check=True)
    elif mode == "smoke":
        url = values["APP_URL"].rstrip("/") + "/api/health?release=" + os.environ["GITHUB_SHA"]
        result = subprocess.check_output([
            "curl", "--fail", "--silent", "--show-error", "--retry", "5",
            "--retry-all-errors", "--retry-delay", "3", "--max-time", "15", url,
        ], text=True)
        health = json.loads(result)
        validate_health(health, target, os.environ["GITHUB_SHA"])
        print("Deployment release health check passed")
    else:
        raise ValueError("Unknown configuration operation")


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))

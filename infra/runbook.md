# ISKRA infrastructure and delivery

## Confirmed setup

| Item | Value / state |
|---|---|
| Canonical repository | [SWOFART/ISKRA](https://github.com/SWOFART/ISKRA) |
| Default branch | `main` (production); `develop` for testing/staging |
| Product specification | Root [plan.md](../plan.md) |
| Production hosting | Cloudflare Workers: React/Vite static assets + Hono API |
| Development tunnel | `c0c32852-fe5d-4a65-af4c-058cdf786627`, supplied by the user |
| Tunnel verification | Hostname, connector status and account ownership not independently verified |
| CI/CD | GitHub Actions, with separate `staging` and `production` environments; initial CI passed on both branches |
| Live infrastructure test | [iskra-develop-check](https://iskra-develop-check.matvey-nesterenko.workers.dev/api/health), deployed with locally authenticated Wrangler; not the product |
| Application status | Not implemented; an isolated deployment-check Worker exists under `infra/deployment-check`, with no product features |
| Docker | Not needed for Workers; no image build or registry is configured |

The final hosting decision is Cloudflare-hosted production that continues working when the developer's computer is off. The earlier suggestion to use a tunnel for production was clarified and superseded by this decision. The tunnel remains useful for development previews; do not attach a production hostname to an unreviewed local development server.

## Local tools

Use `gcloud` to manage the approved Google Cloud services, `wrangler` to manage Workers/R2/Hyperdrive, and `cloudflared` to connect the development tunnel. Installation is separate from authentication, account selection and provisioning.

Verified on 2026-10-27: Google Cloud SDK **590.0.1**, Wrangler **4.153.0**, cloudflared **2026.10.3**. Existing Docker CLI **29.9.1** was detected and left unchanged. Wrangler OAuth login was completed by the user and the single available Cloudflare account was verified. gcloud has no active account/project selected. A separate noninteractive Workers API token is still required for GitHub Actions; the local OAuth credential is not copied into GitHub. GitHub CLI is already authenticated and was used for repository setup.

GitHub environments `staging` and `production` were created. Staging is restricted to `develop`, production to `main`. Repository variables record deployment as disabled and the provided development tunnel ID. The verified Cloudflare account ID is configured in each environment. The staging `APP_URL` points to the verified infrastructure test Worker. The CI token and the final product hostname are still outstanding.

```bash
gcloud version
wrangler --version
cloudflared --version
```

The globally installed Wrangler is for local administration. Once the app is scaffolded, pin Wrangler in `devDependencies` and commit `package-lock.json`; CI executes that locked version, not a global installation.

Updates, when needed:

```bash
brew upgrade --cask gcloud-cli
brew upgrade cloudflared
npm install --global wrangler@4
```

Do not run `gcloud components update` to maintain the Homebrew-managed installation. Docker is already present on the workstation, but no Docker daemon or image update is required for this architecture.

## Credentials and account selection

- A Cloudflare login inside Codex does not automatically authorize Wrangler or GitHub Actions.
- A tunnel ID is an identifier, not a tunnel connector token, Workers account ID or deployment API token.
- Local login, when account setup starts: `gcloud auth login`, choose the agreed Google project, then `wrangler login` and `wrangler whoami`. `wrangler login` was run and completed for the requested test deployment; `gcloud auth login` has not been run.
- Do not create a new billable Google project, enable paid services, create Cloud SQL instances or alter tunnel routing until the team chooses the account/project/domain and budget in the plan.
- Keep tunnel credentials and cloud keys out of chat, Git history and build-time `VITE_*` variables. Do not copy Codex's internal authentication storage into CI.

## How the workflows behave

`checks.yml` runs on pull requests and pushes to `main`/`develop`, and is reused by `cloudflare.yml`. It always installs the deployment-check Worker's locked dependencies, runs its Node tests and performs a Wrangler dry-run build. Before application code exists, it validates required documentation and whitespace, and reports that application checks were not run. When `package.json` appears, a lockfile, `typecheck`, `test:unit`, `build`, and local Wrangler become required; CI runs all three scripts without `--if-present` or a no-tests-success option.

`cloudflare.yml` deploys changes on `develop` to staging only when repository variable `CLOUDFLARE_DEPLOY_ENABLED=true`. Before the root app exists, automatic staging selects the deployment-check Worker; afterward it selects the application. Manual runs explicitly select `deployment-check` or `application`. Production uses a manual **Deploy to Cloudflare → Run workflow → production → application** action from `main`. Staging only allows `develop`, production only allows `main`; the test Worker cannot deploy as production; no production credentials are exposed to pull-request jobs. Actions are pinned by commit, permissions are read-only, and checkout does not retain Git credentials.

Deployment verifies configuration first, installs locked dependencies, builds for `CLOUDFLARE_ENV`, deploys using the local Wrangler version, and requests `/api/health`. The health response must include `{ "ok": true, "release": "<deployed Git SHA>" }`, with `release` read from server-side `RELEASE_SHA`. A stale but healthy previous version does not pass. The infrastructure check implements this contract and adds `service: "iskra-deployment-check"` and `applicationReady: false`. The product must implement its own health route when the app scaffold is authorized.

Deployments to the same environment are serialized. The build is repeated in the credentialed deployment job for the same checked-out SHA; dependency versions stay locked. No database migration runs automatically in either workflow. Add the reviewed migration gate and real-PostgreSQL integration tests before database-changing application releases, following plan section 11.

## Activate deployment

Product deployment remains unavailable until all of these are completed. The smaller infrastructure test described below can run earlier, without product code or any database/AI resources. Neither test is a claim that Green is implemented.

- [ ] Polish and confirm the implementation plan; then authorize and build the app scaffold.
- [ ] Commit `package.json`, `package-lock.json`, required scripts and project-local Wrangler.
- [ ] Configure named Wrangler environments `staging` and `production`, with separate Worker names, R2/Hyperdrive bindings, runtime settings and route/domain configuration. Set a supported compatibility date and `nodejs_compat`.
- [ ] Implement `/api/health` with the release contract above. Ensure `/api/*` errors remain JSON and SPA fallback only serves frontend routes.
- [ ] Choose the Cloudflare account and production custom hostname; create the corresponding Workers/resources. The development tunnel UUID does not fill these values.
- [ ] In each GitHub environment, add secret `CLOUDFLARE_API_TOKEN` and variables `CLOUDFLARE_ACCOUNT_ID` and `APP_URL`. `APP_URL` is the deployed HTTPS origin, not the tunnel URL.
- [ ] Use a dedicated account-scoped deployment token with the minimum Workers permissions required by the verified configuration. Custom-domain route changes may additionally need narrowly scoped zone permissions. Do not use a Global API Key or grant Tunnel management just to deploy Workers. Check [Cloudflare's current GitHub Actions guidance](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
- [ ] Add public build variables listed below to the appropriate GitHub environment. Restrict MapTiler keys by exact environment origin; configure Firebase authorized domains.
- [ ] Provision runtime secrets directly in each Worker environment: Gemini, media signing, etc. Origin SQL credentials belong in Hyperdrive, not the browser or workflow output.
- [ ] Disable Hyperdrive query caching and verify read-after-write behavior.
- [ ] Set repository variable `CLOUDFLARE_DEPLOY_ENABLED=true` only when the preceding prerequisites are real.
- [ ] Run manual staging deployment from `develop` with target `application`, verify logs/release health and the full relevant application smoke tests.
- [ ] Run manual production deployment from `main` and verify the final custom domain. Do not create a second automatic Workers Builds pipeline for this repository.

### Test Wrangler deployment on develop

The isolated Worker is named `iskra-develop-check`. It has no database/storage/AI bindings, accepts only GET, serves `/api/health`, returns JSON 404 for other paths, and never claims product readiness. Production hosting remains a separate application milestone.

Local checks:

```bash
npm ci --prefix infra/deployment-check
npm test --prefix infra/deployment-check
npm run build --prefix infra/deployment-check
```

To test locally authenticated deployment, check out `develop`, then run the following with the verified Cloudflare account selected (the root project does not need a package manifest):

```bash
cd infra/deployment-check
wrangler deploy --env staging --var "RELEASE_SHA:$(git rev-parse HEAD)"
```

For automatic GitHub deployment of this Worker, add `CLOUDFLARE_API_TOKEN` to the **staging environment**, set its `APP_URL` to the check Worker's verified HTTPS origin, and enable `CLOUDFLARE_DEPLOY_ENABLED=true`. The account ID is already configured. Then run **Deploy to Cloudflare** from `develop`, environment `staging`, target `deployment-check`. Check the run and its matching release at `/api/health`. A missing credential is an activation blocker, not an excuse to copy the local OAuth token into CI.

Verified on the first setup release: three Node tests passed, Wrangler dry-run built successfully, GitHub CI passed on `main` and `develop`, and the deployed endpoint returned the expected Git SHA. Live GET `/api/reports` returned JSON 404 and POST `/api/health` returned 405. This was a **local OAuth-authenticated deployment**, not yet a successful GitHub deployment. Automatic deployment remains disabled until the environment token is provided and a GitHub deployment is verified.

Keep the test Worker separate from the eventual application Worker names. When the root app is added, staging's `APP_URL` must be changed to the actual app origin before its automatic deployment is enabled; any attempt to smoke-test the wrong origin fails its release comparison.

### GitHub configuration inventory

| Scope | Name | Purpose |
|---|---|---|
| Repository variable | `CLOUDFLARE_DEPLOY_ENABLED` | `false` until activation checklist passes |
| Repository variable | `CLOUDFLARE_TUNNEL_ID` | Development tunnel UUID; documentation/coordination only, not used as a deployment credential |
| Each environment secret | `CLOUDFLARE_API_TOKEN` | Noninteractive Workers deployment |
| Each environment variable | `CLOUDFLARE_ACCOUNT_ID` | Target Cloudflare account |
| Each environment variable | `APP_URL` | HTTPS origin for deployment health check |
| Each environment variable | `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` | Public Firebase client configuration |
| Each environment variable | `VITE_MAPTILER_KEY`, `VITE_MAP_STYLE_URL` | Origin-restricted public map configuration |
| Workflow-generated | `VITE_API_BASE=/api`, `CLOUDFLARE_ENV`, `RELEASE_SHA` | Same-origin API, selected build environment, release identity |

No real secrets are included in this repository. Do not paste tokens into an issue/PR/chat to complete the inventory.

## Development tunnel

Use the existing tunnel rather than creating a duplicate. Obtain its actual public development hostname and confirm where the connector runs before changing configuration. Codex-managed and standalone `cloudflared` connectors are separate operational choices; do not start a second connector automatically just because the CLI is installed.

Do not put the tunnel token in YAML. The repository records only the user-provided UUID. The tunnel is not a production dependency, so shutting it down must not affect the deployed Workers app.

## Rollback and handoff

If deployment health fails, the workflow fails and reports the error; it does not silently claim success or automatically revert database data. Use Cloudflare's deployment history or a reviewed `wrangler rollback --env <environment>` to select a compatible prior Worker version. Preserve the ledger and existing data. Database restore/migrations are separate controlled operations described in plan section 11.

Stop after repository, CI/CD wiring and local-tool installation. The next working session should polish the final plan and divide work between **three people**; product implementation, cloud provisioning and detailed team assignment are not part of this setup change.

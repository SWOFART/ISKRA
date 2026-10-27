# ISKRA infrastructure and delivery

## Confirmed setup

| Item | Value / state |
|---|---|
| Canonical repository | [SWOFART/ISKRA](https://github.com/SWOFART/ISKRA) |
| Branches | `develop` for staging/testing; `main` for production |
| Product specification | Root [plan.md](../plan.md) plus later confirmed policies in the [active OpenSpec change](../openspec/changes/build-iskra-hackathon-mvp/) |
| Production hosting | Cloudflare Workers: React/Vite assets + Hono API |
| Google Cloud project | `iskra-512914` (project number `976498049675`) |
| Environment/key source | Google Cloud Secret Manager; no GitHub settings variables or secrets |
| Google authentication for CI | Workload Identity Federation, no service-account JSON key |
| Development tunnel | `c0c32852-fe5d-4a65-af4c-058cdf786627`, user-provided; hostname/connector not verified |
| Live infrastructure test | [iskra-develop-check health](https://iskra-develop-check.matvey-nesterenko.workers.dev/api/health), deployed initially using local Wrangler OAuth |
| Product application | Root platform/auth foundation only; client/domain/media/AI/SQL integration pending, health reports `applicationReady: false` |
| Docker | Not required for Workers; no image build/registry/update pipeline |

The final production hosting decision is Cloudflare Workers, independent of a developer computer. The existing tunnel is for development previews, not the production origin. Cloudflare hosts the application; GitHub stores code and runs CI, not the application API.

## Local tools and Git identity

Verified on 2026-10-27: Google Cloud SDK **590.0.1**, Wrangler **4.153.0**, cloudflared **2026.10.3**. Existing Docker CLI **29.9.1** was left unchanged. Google and Wrangler interactive logins were completed; gcloud selected `iskra-512914`. No new billable application server/database was provisioned.

This repository uses GitHub account **kapustazh**, author/committer email `51422901+kapustazh@users.noreply.github.com`, and the GitHub CLI credential helper. At the user's request, the two earlier setup commits were rewritten as kapustazh on all affected branches. Other authors' commits were preserved. Existing clones must refresh/reset their local branches before adding work to the rewritten history.

```bash
gcloud version
wrangler --version
cloudflared --version
```

Global Wrangler is a local administration tool. Both root and infrastructure-check packages pin their own Wrangler **4.153.0** and lockfiles.

## One source for environment values

The user requires all environment values and keys to be stored in Google Cloud and fetched from there. GitHub repository/environment settings contain **no variables or secrets**. Previously created settings variables were removed. Never copy local OAuth credentials, Cloudflare tokens, Google service-account keys or application keys into GitHub settings.

The root [`.env.example`](../.env.example) contains **names with blank values only**, covering deployment, browser and Worker runtime settings. Local `.env`/`.dev.vars` files are ignored and, when needed, must be generated from Google rather than maintained as a separate source of truth. They are not required for the existing infrastructure test.

Each environment has a single Secret Manager JSON configuration:

| Environment | Secret | CI service account | Allowed branch |
|---|---|---|---|
| staging | `iskra-staging-env` | `iskra-ci-staging@iskra-512914.iam.gserviceaccount.com` | `develop` |
| production | `iskra-production-env` | `iskra-ci-production@iskra-512914.iam.gserviceaccount.com` | `main` |

The secret payload is a flat JSON object whose keys are listed in `.env.example` and whose values are strings. There is no shell execution or `source .env` of fetched configuration. Unknown keys, non-string/multiline values and invalid deployment origins are rejected. The initial configurations contain only `DEPLOY_ENABLED=false`: no application/deployment keys have been entered, and automated Cloudflare writes remain disabled.

Secret replicas are in Frankfurt (`europe-west3`), a technical setup choice for these configuration records. This is not a claim that all identity, logging or future application processing is EU-only. Change the storage policy before inserting real values if the team requires another location.

Only non-secret authentication **bootstrap identifiers** are committed in [cloudflare-bootstrap.json](cloudflare-bootstrap.json): project/provider IDs, environment secret names, service-account names, repository ID and branch mapping. The workflow needs them to authenticate before it can fetch configuration; they are not application environment values or private credentials. No Cloudflare account ID, URL, token or browser key is stored there.

### Keyless Google access

The `iskra-github` identity pool and `github` OIDC provider trust only:

- GitHub repository ID `1435816128` and owner ID `325757094`;
- the `.github/workflows/cloudflare.yml` workflow;
- staging on `develop` or production on `main`, with the matching GitHub environment claim.

Each CI service account can read only its own configuration secret. It can neither edit keys nor read the other environment. There are no service-account private keys. GitHub jobs request a short-lived identity token; Google exchanges it for narrowly authorized access. GitHub environments retain deployment branch policies, which are access controls rather than stored environment values.

## How CI/CD works

`checks.yml` runs on pull requests and pushes to `main`/`develop`, and is reused by the deployment workflow. It validates repository files/whitespace, tests the infrastructure Worker and cloud-configuration loader, and runs Wrangler dry-run. When root `package.json` appears, a lockfile plus `typecheck`, `test:unit`, `build` and project-local Wrangler are mandatory; the app checks run without optional-script flags.

`cloudflare.yml` runs on relevant changes to `develop`, or manually. It reads bootstrap identifiers, authenticates to Google, fetches the selected configuration and validates it. If Google says deployment is disabled, the run explicitly reports **configuration retrieval succeeded / no deployment occurred**. A green run in that state is not proof of automated Cloudflare deployment.

When enabled, the job installs locked dependencies, builds, deploys, then verifies the exact Git release through `/api/health`. Staging uses `develop`; production requires a manual run from `main` with target `application`. The infrastructure test can never be the production target. Deployment jobs have only `contents: read` and `id-token: write`; actions are pinned and no secret values are passed between jobs or uploaded as artifacts.

### Google → Cloudflare flow

- **Deployment credential:** read `CLOUDFLARE_API_TOKEN` and account ID from the Google configuration, provide them only to the Wrangler deployment process. The token never becomes a Worker runtime secret or browser value.
- **Browser values:** read `VITE_*` values from Google and provide them only to the frontend build. They necessarily appear in the resulting browser bundle; restrict MapTiler by origin and Firebase by its approved project/domain settings.
- **Server values:** read non-deployment, non-`VITE_*` runtime configuration from Google; deploy it as Cloudflare Worker Secrets using Wrangler's `--secrets-file` JSON option. Google remains the source, Cloudflare holds operational copies. Rotating a Google version requires a deployment/sync; this is not an automatic per-request Secret Manager lookup.
- **Temporary runner files:** private mode `0600`, not committed/artifacted, removed on success or failure. The auth action also cleans up its short-lived credential file. Local human login sessions remain local authentication, not application-key storage.

## Test Wrangler deployment on develop

The isolated Worker is `iskra-develop-check`, with no storage/database/AI bindings. It accepts GET `/api/health`, includes `ok`, `release`, `service: iskra-deployment-check`, and `applicationReady: false`; other paths return JSON 404 and mutation methods 405.

```bash
npm ci --prefix infra/deployment-check
npm test --prefix infra/deployment-check
npm run build --prefix infra/deployment-check
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
```

The initial local deployment, three Worker tests, live health/release checks, JSON 404/405 checks and initial GitHub CI passed. The original live health release predates the user-requested Git history rewrite. The [keyless develop workflow](https://github.com/SWOFART/ISKRA/actions/runs/40524377245) passed: Google OIDC authentication, Secret Manager retrieval, configuration validation and temporary-file cleanup all succeeded. The Cloudflare deployment step was correctly skipped because Google config disables deployment. CI also passed on both branches. Actual automated Cloudflare deployment remains pending until key values are supplied later in Google Cloud.

## Later activation — values stay in Google

Do not add a GitHub secret or settings variable to complete this checklist.

- [ ] Add a new version of `iskra-staging-env` in **Google Cloud project `iskra-512914`**. For the infrastructure test, populate `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `APP_URL`, then set string `DEPLOY_ENABLED` to `true`. Keep it `false` while values are missing.
- [ ] The test `APP_URL` is the verified Workers origin above, not the tunnel URL. Use an account-scoped Workers deployment token with minimum verified permissions; never a Global API Key. Create/rotate that token at Cloudflare and save its value directly in Google Secret Manager, not chat or GitHub.
- [ ] Run **Deploy to Cloudflare** from `develop`, environment `staging`, target `deployment-check`; verify a matching Git SHA in live health.
- [ ] For the product later: commit its code/lockfile/configuration and add all relevant `.env.example` values to Google's environment JSON. Configure separate named Workers, Hyperdrive/R2 bindings, Firebase domains, MapTiler origins and release health. Its URL replaces the test URL in Google's staging config.
- [ ] Google is also the source for any origin DB/R2 credentials; provision their operational copies in Hyperdrive or storage integrations as appropriate. Do not expose origin credentials to the browser.
- [ ] Add real-PostgreSQL integration checks and a reviewed migration/backup gate before data-changing releases; current CI has no database to migrate.
- [ ] Populate the production Google configuration and final custom hostname only after product readiness. Production must have `APP_ENV=production`, `DEMO_DATA=false`, target `application` and the `main` branch.
- [ ] Run manual production deployment and full application smoke tests. Do not add a second automatic Workers Builds pipeline.

Firebase exists in the selected Google project; application wiring and the other product resources remain pending (see reconnaissance below). No Docker image or tunnel daemon is started automatically.

## Rollback and stop point

A failed release health check fails the deployment run. Recover through Cloudflare deployment history or a reviewed Wrangler rollback to a compatible version; preserve database/ledger data. Environment rollback means explicitly selecting/restoring a known Google Secret Manager version and redeploying, never copying stale GitHub settings.

The later user request authorizes **Person C implementation under OpenSpec**. Preserve A/B ownership and deployment gates; the earlier deployment-only setup stop point no longer prevents C's platform/auth work. No billable resource provisioning or product deployment was performed by the foundation change.

## Person C foundation handoff — 2026-10-27

Branch: `codex/person-c-delivery`, based on `develop` at `f2287d1`. B remains the sole editor of the canonical OpenSpec checklist; the following is completion evidence for review, not checked-off tasks.

| Task | Evidence / remaining requirement |
|---|---|
| 1.4, partial | Read-only Firebase and Google configuration probes below; current Firebase/Workers documentation reviewed. Spending owner/cap/teardown, model/quota, map origins, isolated product resources and deployment credentials remain unverified/unconfigured. |
| 2.3, partial | Root pinned package/lockfile, strict TypeScript, Vitest, Hono Worker, health/release and API JSON 404. Worker-only bundle; Vite/SPA/direct client navigation and B/C router integration require A's entry and B's frozen contracts/facade. Client paths return safe JSON 503 rather than fabricated UI. |
| 2.7, local evidence | RS256 signature verification using `jose`/Web Crypto, issuer/audience/subject/time checks, UID-only context and bounded key refresh tests. Real Firebase token on deployed Workers and real sign-in remain unverified. |
| 2.9, partial | Safe JSON error envelope, server-generated request IDs, actual-byte body cap, mutation-origin guard, no-store/no-referrer and API security headers. B's shared validators/error mapping and live public/private route tests are pending. |
| 2.4 and 2.10, pending | Vitest exists, but no Playwright/real-PG harness or product deployment is claimed. Requires schema/router/client handoff and D10 resource/access decisions. |

### Interfaces supplied to A/B

- `WorkerEnv` in `src/worker/middleware/context.ts` owns optional `FIREBASE_PROJECT_ID`/`RELEASE_SHA` bindings and request variables `requestId` and `identity: {uid} | undefined`. Missing project configuration fails closed with 503. No provider email/name enters the context.
- Use `requireAuth()` on protected routes and `optionalAuth()` on guest-capable routes. Both accept only bearer tokens; supplied invalid credentials never silently become guest access. Domain request schemas must reject actor/status/RP fields; ignoring such fields in auth does not replace B's input validation.
- `ApiError(status, code, safeMessage, retryable)` produces `{error:{code,message,requestId,retryable}}`. Only sanitized messages belong here; unexpected exceptions return fixed 500 text without token/SQL/key logging. `INTERNAL_ERROR` (500) and `UNAVAILABLE` (503) are **provisional platform codes to reconcile with B's frozen mapping**, not approved shared-schema additions.
- Root middleware counts streamed bytes up to 1MiB, including when Content-Length understates the payload. This first slice buffers the bounded body; C's later authenticated JPEG upload path must add purpose/ownership/type/dimension checks and immutable R2 finalization. The API-only CSP must be scoped/adapted before serving A's actual HTML.
- Only health is mounted. C will mount B's `createDomainRoutes` and the real evidence facade when their interfaces exist; no fake domain/AI success endpoints were added.

### Firebase verification limits

The implementation follows the [Firebase third-party ID-token checks](https://firebase.google.com/docs/auth/admin/verify-id-tokens) and uses algorithms supported by [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/). Google public signing keys are fetched from the fixed Secure Token service-account JWKS endpoint; no account private key or Firebase Admin SDK is required. A live public-key probe returned two keys with the same key IDs as Firebase's documented X.509 endpoint on 2026-10-27; this proves endpoint reachability, not deployed token acceptance. Fetches have a 5-second deadline, 64KiB response cap, at most 20 keys, one concurrent refresh per isolate, 30-second refresh cooldown and at most 5-minute cache lifetime (shorter provider Cache-Control/Age wins). Unknown keys can cause one refresh after cooldown; provider failure/expired keys fail closed. This can temporarily reject valid newly rotated keys during cooldown or provider outages.

There is **no per-request online revocation/disabled-user check**: an already issued token can remain usable until expiration. No emulator mode, unsigned token path, test-key binding or public auth-test route exists. Test signing keys are generated in memory for synthetic unit tests and are never deployed.

### Read-only account reconnaissance

Checked on 2026-10-27 without printing tokens, provider client secrets, password/hash settings or Secret Manager values:

| Item | Observed state |
|---|---|
| Selected project | `iskra-512914` (existing setup); no new project created |
| Firebase email/password | Enabled; password required |
| Firebase Google provider | `google.com` enabled |
| Firebase authorized domains | `localhost`, `iskra-512914.firebaseapp.com`, `iskra-512914.web.app`; final staging/product host still needs authorization |
| Google staging/production environment JSON | Both fetched successfully; deployment disabled, no populated app/deployment key names |
| Real user login / deployed JWT verification | Not tested; enabled providers alone do not prove application auth works |
| Cloudflare token, final app domain, Cloud SQL/Hyperdrive/R2 readiness | Not configured/verified for the product; no infrastructure test counted as M1 |
| Gemini model/key/quota, MapTiler origin restriction | Unverified; no configured key in the environment JSON and no model call made |
| Spending owner/cap and teardown | Unconfirmed; no billable resource provisioned |

### Local checks

Use Node 24+ (CI uses 24):

```bash
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run dev -- --local
```

Root build is a Wrangler dry-run Worker bundle, not a product deployment or a Vite/client build. The existing CI automatically runs the new root checks and preserves the separate check-Worker/configuration tests. Unit coverage includes bad signatures/claims/algorithms, rotation/cooldown/concurrency/cache expiry, unavailable/oversized key responses, safe failures, origin rejection, body limits and verified identity propagation. Real-PG races, real devices, private media and the genuine Green flow remain later acceptance gates.

Foundation verification on 2026-10-27: clean `npm ci`, typecheck, 42 root unit tests and root bundle passed; three separate check-Worker tests/build and eight cloud-configuration tests passed. A local Wrangler/workerd server returned health 200, unknown API 404 and `/impact` 503 with JSON/no-store/request IDs; it was then stopped. These local runtime checks did not exercise a real Firebase user or a cloud deployment.

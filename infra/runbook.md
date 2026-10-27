# ISKRA infrastructure and delivery

## Confirmed setup

| Item | Value / state |
|---|---|
| Canonical repository | [SWOFART/ISKRA](https://github.com/SWOFART/ISKRA) |
| Branches | `develop` for staging/testing; `main` for production |
| Product specification | Root [plan.md](../plan.md) plus later confirmed policies in the [active OpenSpec change](../openspec/changes/build-iskra-hackathon-mvp/) |
| Production hosting | Cloudflare Workers: Vite browser assets + Hono API; current shell is A's DOM implementation |
| Google Cloud project | `iskra-512914` (project number `976498049675`) |
| Environment/key source | Google Cloud Secret Manager; no GitHub settings variables or secrets |
| Google authentication for CI | Workload Identity Federation, no service-account JSON key |
| Development tunnel | `c0c32852-fe5d-4a65-af4c-058cdf786627`, user-provided; hostname/connector not verified |
| Live infrastructure test | [iskra-develop-check health](https://iskra-develop-check.matvey-nesterenko.workers.dev/api/health), deployed initially using local Wrangler OAuth |
| Product application | Client shell/Worker routing and P0 SQL schema are integrated; real auth/domain/media/AI/SQL runtime remains pending, health reports `applicationReady: false` |
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
| 2.3, local integration prepared | Root pinned package/lockfile, Vite client build, strict TS/TSX, Hono Worker with B's router facade, health/release, ASSETS/SPA fallback and API JSON 404. Browser checks cover direct client links; review/merge and live staging remain separate. |
| 2.7, local evidence | RS256 signature verification using `jose`/Web Crypto, issuer/audience/subject/time checks, UID-only context and bounded key refresh tests. Real Firebase token on deployed Workers and real sign-in remain unverified. |
| 2.9, middleware implemented | Safe JSON error envelope using B's shared validators/error mapping, server-generated request IDs, actual-byte body cap, mutation-origin guard, no-store/no-referrer and API security headers. Live domain/media privacy acceptance remains separate. |
| 2.4 and 2.10 | The later independent harness section below supplies Playwright/real-PG infrastructure for 2.4. Product deployment (2.10), domain tests and client integration remain pending. |

### Interfaces supplied to A/B

- `WorkerEnv` in `src/worker/middleware/context.ts` owns optional `FIREBASE_PROJECT_ID`/`RELEASE_SHA` bindings and request variables `requestId` and `identity: {uid} | undefined`. Missing project configuration fails closed with 503. No provider email/name enters the context.
- Use `requireAuth()` on protected routes and `optionalAuth()` on guest-capable routes. Both accept only bearer tokens; supplied invalid credentials never silently become guest access. Domain request schemas must reject actor/status/RP fields; ignoring such fields in auth does not replace B's input validation.
- `ApiError(status, code, safeMessage, retryable)` produces `{error:{code,message,requestId,retryable}}`. Only sanitized messages belong here; unexpected exceptions return fixed 500 text without token/SQL/key logging. The later v1 integration uses B's `API_ERROR_POLICY`, including `INTERNAL_ERROR` (500) and `UNAVAILABLE` (503). Invalid status/retry combinations are programming errors and return a safe 500.
- Root middleware counts streamed bytes up to 1MiB, including when Content-Length understates the payload. This first slice buffers the bounded body; C's later authenticated JPEG upload path must add purpose/ownership/type/dimension checks and immutable R2 finalization. The API-only CSP must be scoped/adapted before serving A's actual HTML.
- Health and B's `createDomainRoutes` facade are mounted. Unfinished domain endpoints return the canonical JSON 503; the real evidence facade is still pending. No fake domain/AI success endpoints were added.

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

## Contract integration and milestone review — issue #18, 2026-10-27

Develop `b08055e` includes B's merged schemas (PR70), v1 handoff (PR71) and domain/transaction/report-context facades (PR72), plus the confirmed roster/access owner. This clears the missing schema/router dependency for C's API-boundary integration. G0 is not automatically complete: the handoff still requests A/C acknowledgment and independent review. C acknowledges `v1-candidate.2` for endpoint/error, upload/location, assessment and internal interface shapes through this integration PR; B records consumer acknowledgments and canonical checklist completion. A's acknowledgment is not inferred from a merged PR.

C's root now mounts B's facade and uses the shared error HTTP/retry mapping. JSON/body errors are `400 INVALID_INPUT`; an oversized declared JPEG is `413 PHOTO_TOO_LARGE`. Both count actual bytes under the existing 1MiB cap. B/C route authors can use `parseJsonBody(c, schema)` for strict JSON content-type, syntax and shared request-schema validation with safe 400 responses; unknown authority fields are rejected by the supplied schema. A schema error outside that request helper remains a generic 500 so server projection bugs are not blamed on the client. Domain placeholders still report 503 and do not claim authentication, mutation or publication success.

The root typecheck now includes shared code and all unit tests (including B's fixtures with JSON-module support), closing the earlier typecheck handoff. Local clean install, typecheck, 158 unit tests and Worker dry-run passed before PR creation. No shared schema/domain facade file was edited.

G1 remains blocked: no A client entry, real database implementation/migrations or SQL transaction probe is present. A fresh Google read confirms both environments still disable deployment with no populated app/deploy keys; Cloud SQL discovery still returns 403. PR68 (PG/browser harness) is merged after independent review; PR69 (JPEG validation) remains pending. Neither is a product runtime milestone. Live hosting, verified real-user token, storage/network/TLS and AI quota acceptance are still unproven; no cloud write or billable resource was created by this integration.

## Disposable PostgreSQL and browser harness — task 2.4

Issue [#13](https://github.com/SWOFART/ISKRA/issues/13), Person C. This independent slice builds on the merged Worker foundation. Complete scaffold task 2.3, B's migrations/domain races and A's UI are still separate dependencies for integrated acceptance; this harness does not close those tasks or G0/G1. B maintains canonical OpenSpec task checkboxes after reviewing integrated evidence.

`pg` is a pinned **development dependency** for real database tests, with no ORM and no change to B's runtime database client/schema. PostgreSQL 17 is the selected **test target**, not confirmation of a provisioned Cloud SQL version. CI pins the tested multi-architecture PostgreSQL image digest; update that pin deliberately. Test-only tables are named `harness_ledger`, not a proposed product schema.

Start an isolated local database (Docker must be running):

```bash
docker run --detach --rm --name iskra-test-postgres --publish 127.0.0.1:55432:5432 --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_USER=iskra_test --env POSTGRES_DB=iskra_test postgres:17@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe
docker exec iskra-test-postgres pg_isready -U iskra_test -d iskra_test
```

After readiness succeeds:

```bash
npm ci
npm run typecheck
npm run test:unit
TEST_DATABASE_URL=postgres://iskra_test@127.0.0.1:55432/iskra_test npm run test:integration
npx --no-install playwright install chromium
npm run test:e2e
npm run build
docker stop iskra-test-postgres
```

The trust-auth database is disposable, loopback-bound and has no mounted data volume. Never reuse these instructions for a shared/cloud database. `TEST_DATABASE_URL` is an ephemeral test fixture, not a product secret: its name is blank in `.env.example`; the loopback URL is supplied only to the test process/CI service. No GitHub settings variables or secrets are created, no Google/cloud credentials are fetched by test jobs, and the fixture must not be added to product environment JSON or Worker bindings.

`tests/integration/auth/postgres.ts` exports `testDatabaseConfig()` and `withTestDatabase(async pool => ...)`. Before connecting, the guard requires a PostgreSQL URL with an explicit port, loopback host, exact `iskra_test` user/database and no query/fragment overrides. Explicit connection settings prevent falling back to a production PGHOST/database/options. Each invocation generates its own schema, uses a scoped pool (maximum four connections) and drops only that generated schema in `finally`, including after callback failure. B can import this helper for future domain tests and use a checked-out client for transactions; all clients must be released in `finally`. The harness does not run migrations, reset databases or delete public/product schemas. Real-PG tests prove rollback, concurrent uniqueness and schema cleanup, not product vote/RP invariants.

`vitest.integration.config.ts` runs all `tests/integration/**/*.test.ts` without silently skipping a missing database. Ordinary runs intentionally skip only the named negative probe. CI first runs the normal command without an error wrapper, so a genuine invariant failure fails the job. It then sets the **test-only** `ISKRA_TEST_INJECT_FAILURE=1` to prove an intentionally false SQL assertion returns exit 1. The structured JSON report must identify exactly the expected file/assertion; a small test reporter also records suite/hook and unhandled-error counts omitted by Vitest's JSON reporter. The validator rejects unrelated collection, hook, assertion, connection and unhandled failures; Python regressions and local real-PostgreSQL fault probes cover these cases. The flags/report files are test-only and never read by Worker code or deployed configuration.

Playwright uses a newly spawned local Wrangler/workerd at fixed loopback port 8789 with server reuse disabled. It runs a real Chromium health/navigation check plus request-boundary checks; there is no configurable external/staging URL. The server stops after the run. Trace recording is off and reports/results are ignored; no artifacts are uploaded. Client navigation/camera/login tests and real phones remain pending. Playwright's documented [webServer lifecycle](https://playwright.dev/docs/test-webserver) and node-postgres's [single-client transaction rule](https://node-postgres.com/features/transactions) informed this setup.

Local evidence on 2026-10-27: four real PostgreSQL tests passed, the negative assertion failed as expected, and both Playwright checks passed. This is local acceptance of the harness; PR CI and independent Gate A are recorded separately in its PR.

## Additional read-only prerequisites — task 1.4 / issue #8

Rechecked on 2026-10-27 without provisioning resources, enabling billing/APIs, changing secrets or making a model call:

| Probe | Actual result / remaining requirement |
|---|---|
| Google selected project | `iskra-512914` |
| Firebase providers/domains | Email/password and Google enabled; authorized domains remain localhost and the project's Firebase hosting domains. Final product origin is absent. |
| Google environment JSON | Both environment records readable; deployment disabled and no populated app/deployment key names. Local OAuth is not a configured CI deployment token. |
| Cloudflare local login | Wrangler OAuth has Workers deployment scopes; this does not prove the Google-sourced CI token is configured. |
| Private R2 readiness | Bucket listing denied, Cloudflare error 10042; resource/account readiness remains unverified. No bucket created or billing setting changed. |
| Hyperdrive listing | Read succeeded; no ISKRA-named configuration observed. No connection/TLS/query-cache acceptance claimed. |
| Cloud SQL instance listing | Google API returned 403. This does not prove zero instances; API enablement/permissions must be resolved before discovery/provisioning. |
| Google billing information | API returned 403; billing state, spending owner/cap and teardown date remain unconfirmed. |
| Gemini / MapTiler | No populated model/key/map values in the environment records; model availability, quota and map-origin restrictions are unverified. |

Current [Gemini rate-limit documentation](https://ai.google.dev/gemini-api/docs/rate-limits) requires checking the actual project's active limits rather than inferring capacity from a key or a generic advertised tier. No model/version/quota is approved by these probes. Issue #8 remains open because the account/budget/domain/model requirements are incomplete. These blockers affect live provisioning and G1, not disposable local tests.

### Recheck on 2026-10-28 — issue #8

Read-only checks in the current workstation session reconfirmed the project and narrowed the setup blockers. No API was enabled, secret changed, resource created, or deployment run. For environment secrets, the CLI parsed only key names, the `DEPLOY_ENABLED` state, and presence booleans; it did not print or save secret values.

| Probe | Verified result | Consequence |
|---|---|---|
| Google project metadata | `iskra-512914` is ACTIVE; project number `976498049675` | Project identity is confirmed. |
| Secret Manager | API enabled; `iskra-staging-env` and `iskra-production-env` each have enabled version 1 | The environment records exist. |
| Environment JSON shape | Both records contain only `DEPLOY_ENABLED="false"`; Cloudflare token/account ID, `APP_URL`, Gemini, media-signing, Firebase browser and MapTiler values are absent | This agrees with disabled deployment; app/staging and production are not configured. The existing deploy workflow skips build/deploy/smoke when disabled. Latest observed develop workflow run [40600990343](https://github.com/SWOFART/ISKRA/actions/runs/40600990343) completed its validation and skipped those deployment steps. |
| Project billing state | `billingEnabled: true` | Billing is attached; the spending owner, cap/alert limits and teardown date remain unknown. This status does not approve new resource spend. |
| Cloud SQL | Cloud SQL Admin API is disabled; listing reported `SERVICE_DISABLED` and offered activation | No instance inventory can be inferred. Do not enable the API or provision an instance until ownership, budget and network plan are confirmed. |
| Cloudflare R2 | `wrangler r2 bucket list` returned error 10042 and asked to enable R2 | R2 is not available to this account session yet; no bucket is confirmed or created. Account-side activation remains required. |
| Cloudflare Hyperdrive | `wrangler hyperdrive list` returned no configurations | There is no observed ISKRA Hyperdrive binding/configuration. No SQL connectivity or TLS check has run. |
| Local CLI identities | Google Cloud CLI and Wrangler OAuth resolve to an existing collaborator account, separate from the GitHub commit identity configured in this checkout | This proves only the current collaborator session's read access. It is not the Google keyless CI identity or the product's Cloudflare deployment credential. No Cloudflare account ID or OAuth token is recorded here. |

The app hostname, Firebase authorized product domain/provider state, restricted MapTiler origins, Gemini model/quota, spending cap and teardown remain unverified in this recheck. Firebase provider state in the preceding section is historical evidence from 2026-10-27, not a new check. Issue #8 remains open. The Cloudflare workflow's successful run must not be described as a deploy: the recorded deploy/build/smoke steps were skipped because Google configuration disabled deployment.

## Client/Worker integration — task 2.3 / issue #12

Person C's integration branch includes A's exact client commit `399bbab4ea1a67ef1a2ed4a6b739d9b41c748225` from PR #75, preserving its author and client files. Review the combined client/integration candidate: it includes both sides of the task 2.1/2.3 handoff without requiring either incomplete foundation to merge first. If #75 merges separately, this PR's diff naturally narrows; any changed review base needs a fresh Gate A. C explicitly accepts and owns A's `jsx: preserve` configuration line, expands TS coverage to all client TSX files and adds Vite's CSS/import types. This resolves configuration coordination; it does not replace independent review or change #75's recorded FAIL verdict.

The current shell uses DOM APIs rather than React. This integration reuses A's supplied entry unchanged, adds no UI framework and makes no new framework decision for future client work. It serves Map/My Impact/Rewards placeholders, not connected map, sign-in or report detail. Direct `/reports/:id` currently loads the shell with its existing Map fallback and retains the URL; report details remain A/B's later tasks.

Commands:

```bash
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run test:e2e
npm run dev -- --local
```

`npm run build:client` uses pinned Vite to produce `dist/client`. `npm run build` then dry-runs Wrangler to `dist/worker`, outside the public asset directory. `npm run dev` rebuilds the client before starting the existing local Wrangler runtime; restart after client edits. There is no second dev server or HMR in this slice. Standalone Vite plus Wrangler Static Assets reuses the existing deploy command without adding the Cloudflare Vite plugin. Vite disables automatic `.env` loading (`envDir: false`); supply only approved Google-sourced `VITE_*` process values for the browser build. Server secrets are never explicitly substituted into browser code.

Wrangler explicitly configures the `ASSETS` binding and Worker-first routing for local/staging/production. Native asset misses return 404 (`not_found_handling: none`). The Worker retries a missing extensionless client route against the root shell; `/assets` and `/assets/*`, plus last path segments containing a dot, retain their native file response. This keeps missing JS/CSS and icons as real 404s while `/impact`, `/rewards` and `/reports/:id` still load the SPA. Dotted client paths require a deliberate routing-policy update. Every request passes through the Worker so `/api` and `/api/*` can never fall into HTML, even for document navigation. API CSP remains `default-src 'none'`. Public assets use same-origin script/style CSP without inline/eval permissions; future map tile/provider connections must update that policy deliberately. Asset responses retain their status/content type and the Worker security headers. Client POST requests are JSON 404, not a successful SPA mutation. Missing ASSETS fails closed with JSON 503. Health continues to report `applicationReady: false`.

Issue #79 regression: before this change, GET/HEAD `/assets/missing.js` returned 200 HTML in real local workerd. The new real-asset Playwright check covers missing JS/CSS, an extensionless asset, and an icon with `Accept: text/html`, empty HEAD bodies, and successful generated JS/CSS with correct content types/security headers. All eight Chromium checks and 199 unit tests pass locally; this is not a cloud deployment or real Green acceptance.

Local acceptance: 199 unit tests and seven Chromium checks pass, including rendered CSS/JS, direct `/`, `/impact`, `/rewards`, `/reports/123`, sign-in placeholders, mobile/keyboard/history navigation without camera/GPS requests, health and API errors. These supersede the earlier Worker-only status descriptions for this branch. Named-environment dry-runs verify asset bindings/configuration without a cloud write. No product deployment, physical-device acceptance, real sign-in, SQL, R2 or Gemini acceptance is implied. Staging activation remains #19/D10/D11 and production remains manual from main through the existing Google-sourced pipeline. Revert the integration commit and deploy a reviewed compatible release to roll back; no migration or data change is included.

## Reviewed P0 PostgreSQL schema — issue 2.5

`migrations/0001_p0_core.sql` is the additive P0 baseline. Its reviewed SHA-256 and the role separation are recorded in [`migrations/README.md`](../migrations/README.md). Verify the file checksum and a database backup before any persistent migration. Apply with the dedicated migration role in a controlled operator/release step; do not run DDL from Worker startup, PR CI credentials or the runtime role. A migration failure must stop the release before deploying code that requires the new schema.

The schema enforces unique vote-stage participation, semantic reward references, report/cleanup analysis use and photo parent ordinals. It permits continued existence support beyond three, caps resolution confirmations at three, stores the first and latest existence confirmation separately, and uses a mutable unique analysis lease slot over non-unique attempt history. The v1 API uses one-based photo ordinals while the database stores zero-based ordinals; convert only in the adapter. Cleanup GPS is stored for private audit and must not enter public projections.

The migration defines no Cloud SQL users, grants, network rules or credentials. The planned `iskra_runtime` and `iskra_migrator` names are role boundaries, not evidence that cloud identities exist; D10 verification and the real migration/backup rehearsal remain pending. PR integration tests apply the SQL only in generated disposable schemas. This work does not claim a live database migration, deployed transaction, or G1 acceptance.

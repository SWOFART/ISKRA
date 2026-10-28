# ISKRA infrastructure and delivery

## Report upload finalization candidate — issues #27 / #28

This draft continues OpenSpec tasks 4.1/4.2, contract `v1-candidate.2`, on top of the existing #84 admission commits (preserved by a normal merge). It does not complete either task. Review this successor together with #84; merging this candidate includes #84's code, so maintainers should avoid treating them as independent changes. Canonical tasks.md stays with B.

Report sequence: verified Firebase token → `POST /api/uploads` with `{purpose:"REPORT",mimeType:"image/jpeg",byteSize,ordinal}` → authenticated `PUT uploadUrl` with exactly the reserved input bytes and `Content-Type: image/jpeg` → validated `{photoId,state:"UPLOADED"}`. The URL accepts exactly one ticket parameter. Authentication and ticket/account admission precede reading the body; the shared streaming reader counts actual bytes, regardless of Content-Length, and stops above 1 MiB. Exact input size must match the signed ticket. The existing strict JPEG framing/decoder rejects invalid content and dimensions above 1600px per side. Server storage re-encodes pixels without EXIF, source comments or thumbnails and hashes those stored bytes. **Implementation assumption for review:** use the installed jpeg-js encoder at quality 80; if re-encoding exceeds 1 MiB, reject rather than silently resize or exceed the cap. Input ticket size and stored SQL size may therefore differ.

Storage uses private PHOTOS and `onlyIf: {etagDoesNotMatch:"*"}` for the server-derived `photos/<photoId>` key. A failed precondition conflicts instead of overwriting. The final SQL transaction inserts UPLOADED only after a successful object write, with the stored hash/size, ticket expiry and the contract's 1–5 ordinal converted to the schema's 0–4 ordinal. SQL also requires the ticket not to have expired. Object I/O is outside SQL transactions; no cleanup/report/RP mutation occurs. A rolled-back insert leaves an unusable object, not publishable evidence; request a fresh ticket rather than retrying an immutable orphan. An ambiguous commit failure can leave a committed photo, so never automatically delete its object on SQL error. Existing #29 SQL-row housekeeping cannot find R2-only objects; complete and verify object-only reclamation before activation. Object metadata records photo ID, stored SHA-256 and ticket expiry for that follow-up, without resident IDs or bearer tickets.

Cleanup PUT remains 503 before reading/storing bytes: B/C still need an agreed durable binding between the ticket's report target and the evidence consumed by analysis. No speculative migration or metadata-only target protocol is introduced. **Activation remains blocked:** #27 distributed UID/IP quotas and count grouping, durable cleanup binding, R2-only orphan reclamation, actual R2 conditional-write behavior and Worker CPU/memory checks. No private bucket, cron, new key, cloud configuration or billable resource was created. Do not bind a live bucket or claim G1/Green from this candidate. Google Secret Manager remains the sole configuration source.

Verification: typecheck; 317 unit tests; 69 real-PostgreSQL integration tests plus one intentional skipped invariant probe; Vite/Worker build dry-run; 16 Chromium/local Worker browser checks. The new integration cases prove simultaneous PUT admission, immutable row/hash/ordinal, no RP, SQL rollback retaining an unusable object, retry conflict, and storage-failure/no-row behavior. R2 is explicitly a conditional in-memory double, not live storage evidence. Revert this code to disable report finalization; it has no schema migration and must preserve existing objects/rows during rollback. Independent Gate A remains PENDING until the user supplies the verdict; a human reviews and merges.

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

The secret payload is a flat JSON object whose keys are listed in `.env.example` and whose values are strings. There is no shell execution or `source .env` of fetched configuration. Unknown keys, non-string/multiline values and invalid deployment origins are rejected. Staging now contains the Cloudflare deployment credentials, target URLs and Firebase web configuration with `DEPLOY_ENABLED=true`; production remains disabled. The current evidence section below records the verified deployment and outstanding product dependencies.

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

When enabled, the job installs locked dependencies, builds, deploys, then verifies the exact Git release through `/api/health`. Workers may briefly serve the previous release while the new deployment propagates, including as an HTTP 200 response; the smoke check retries the full request, JSON parse and release validation for transient network failures, invalid JSON, or an old release. It makes at most seven attempts, with a 10-second curl timeout, a 12-second subprocess timeout and 3 seconds between attempts (about 102 seconds worst case, plus process overhead), with no nested curl retries. A current-SHA response that fails target validation fails immediately. Only a response with `ok: true`, the exact release SHA and the target-specific health checks writes `verified_url`; exhaustion leaves the summary without a live link and the job failed. Staging uses `develop`; production requires a manual run from `main` with target `application`. The infrastructure test can never be the production target. Deployment jobs have only `contents: read` and `id-token: write`; actions are pinned and no secret values are passed between jobs or uploaded as artifacts.

## Product staging deployment on `develop`

The product Worker is `iskra-staging`. The staging environment now enables its own `workers.dev` route; production remains private to its future hostname configuration. The URL `https://iskra-develop-check.matvey-nesterenko.workers.dev` is a separate health-check Worker (`iskra-deployment-check`); keep it in `DEPLOYMENT_CHECK_URL`, not the product `APP_URL`.

The product staging origin `https://iskra-staging.matvey-nesterenko.workers.dev` is now live and its exact release was verified after workflow 40714986035. It is stored as `APP_URL` in Google Secret Manager. The isolated check Worker remains a separate target.

The existing workflow already deploys the application from `develop`: on relevant pushes, `auto` selects the root application because `package.json` exists. A manual run must select branch `develop`, environment `staging`, target `application` (the form's default target is the infrastructure check). After a successful release-health check, the workflow run summary shows a direct link to the deployed origin, target and exact release SHA. No link is shown as live when deployment is disabled or its health check fails. The summary link appears on the Actions run attached to the merged commit; it does not turn this Worker into a fully accepted Green release.

Activation sequence:

1. In `iskra-staging-env`, configure `DEPLOY_ENABLED="true"`, `CLOUDFLARE_ACCOUNT_ID`, a least-privilege `CLOUDFLARE_API_TOKEN`, the confirmed product `APP_URL`, and `APP_ENV="staging"`. Keep the token only in Google Secret Manager. The workflow selects `APP_URL` for the application and `DEPLOYMENT_CHECK_URL` for the isolated test Worker, so manual test deployments do not overwrite the product origin.
2. Add the exact staging origin to Firebase Authentication's authorized domains and to the MapTiler key's allowed origins. Confirm the Firebase redirect and map load on that origin.
3. Add the application values listed in `.env.example` to the same Google configuration. For staging, the application deploy validator requires matching Firebase Worker/browser project settings, API key, auth domain and app ID. Gemini/model/media/MapTiler values are required for their later feature activation and remain mandatory in production; missing SQL/R2 still blocks G1, not staging shell delivery.
4. Configure and verify the product's private R2 and Hyperdrive/Cloud SQL bindings before claiming G1 or a functioning report flow. They are not present in this Worker configuration today.
5. Run **Deploy to Cloudflare** from `develop` with environment `staging` and target `application`, then check the release link in the workflow summary and confirm `/api/health` reports the same SHA. Later relevant merges to `develop` repeat this staging deployment automatically.

Staging deployment is now enabled. Relevant pushes to `develop` select the application target; until its required configuration is complete, validation fails rather than skipping deployment. The successful manual check-Worker deployment below is a separate target. Auth/staging integration PR #103 supplies the staged configuration policy, allowing the sign-in shell to deploy before AI/map/media integration. The app's health deliberately says `applicationReady: false`; neither a successful workflow nor a Workers URL alone passes M1/G1.

### Google → Cloudflare flow

- **Deployment credential:** read `CLOUDFLARE_API_TOKEN` and account ID from the Google configuration, provide them only to the Wrangler deployment process. The token never becomes a Worker runtime secret or browser value.
- **Browser values:** read `VITE_*` values from Google and provide them only to the frontend build. They necessarily appear in the resulting browser bundle; restrict MapTiler by origin and Firebase by its approved project/domain settings.
- **Server values:** read non-deployment, non-`VITE_*` runtime configuration from Google; deploy it as Cloudflare Worker Secrets using Wrangler's `--secrets-file` JSON option. Google remains the source, Cloudflare holds operational copies. Rotating a Google version requires a deployment/sync; this is not an automatic per-request Secret Manager lookup.
- **Temporary runner files:** private mode `0600`, not committed/artifacted, removed on success or failure. The auth action also cleans up its short-lived credential file. Local human login sessions remain local authentication, not application-key storage.

## Test Wrangler deployment on develop

The isolated Worker is `iskra-develop-check`, with no storage/database/AI bindings. It accepts GET `/api/health`, includes `ok`, `release`, `service: iskra-deployment-check`, and `applicationReady: false`; other paths return JSON 404 and mutation methods 405. The workflow uses `DEPLOYMENT_CHECK_URL` for this target and verifies the `service` identity, not just a matching release SHA.

```bash
npm ci --prefix infra/deployment-check
npm test --prefix infra/deployment-check
npm run build --prefix infra/deployment-check
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
```

The initial local deployment, three Worker tests, live health/release checks, JSON 404/405 checks and initial GitHub CI passed. The original live health release predates the user-requested Git history rewrite. The [keyless develop workflow](https://github.com/SWOFART/ISKRA/actions/runs/40524377245) passed: Google OIDC authentication, Secret Manager retrieval, configuration validation and temporary-file cleanup all succeeded. The Cloudflare deployment step was correctly skipped because Google config disables deployment. CI also passed on both branches. That disabled run is historical; the successful automated check-Worker deployment on 2026-10-28 is recorded below.

## Later activation — values stay in Google

Do not add a GitHub secret or settings variable to complete this checklist.

- [x] Added a new version of `iskra-staging-env` in **Google Cloud project `iskra-512914`**. For the infrastructure test, populate `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` and `DEPLOYMENT_CHECK_URL`, then set string `DEPLOY_ENABLED` to `true`. Keep it `false` while values are missing.
- [x] `DEPLOYMENT_CHECK_URL` is the verified check Worker origin above, not the tunnel URL. Use an account-scoped Workers deployment token with minimum verified permissions; never a Global API Key. Create/rotate that token at Cloudflare and save its value directly in Google Secret Manager, not chat or GitHub.
- [x] Ran **Deploy to Cloudflare** from `develop`, environment `staging`, target `deployment-check`; workflow 40708613504 and live health match SHA bd3a412412ca997695f25c0976ea808bf0158d65.
- [ ] For the product: set `APP_URL` to the confirmed product Worker origin, while retaining `DEPLOYMENT_CHECK_URL` for the optional isolated test. Add the remaining relevant `.env.example` values to Google's environment JSON. Configure separate named Workers, Hyperdrive/R2 bindings, Firebase domains, MapTiler origins and release health.
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
| 1.4, partial | Read-only Firebase and Google configuration probes below; current Firebase/Workers documentation reviewed. The user-confirmed credit/budget/access owner is @kapustazh. Remaining credit balance, cap/currency/overage authorization, teardown, model/quota, map origins and isolated product resources remain unverified/unconfigured. Staging credentials were subsequently verified; see current activation evidence below. |
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

### Gemini adapter documentation check — 2026-10-28

The C adapter uses the native REST endpoint POST https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL_ID}:generateContent, sends each validated JPEG as inline image data, places GEMINI_API_KEY in the x-goog-api-key header, and requests JSON using responseMimeType plus responseJsonSchema. The current official [GenerateContent API](https://ai.google.dev/api/generate-content), [image input guide](https://ai.google.dev/gemini-api/docs/image-understanding), [structured output guide](https://ai.google.dev/gemini-api/docs/structured-output), and [API key guide](https://ai.google.dev/gemini-api/docs/api-key) were checked for those request shapes.

No model ID has been selected or added. Project-specific model availability, quota, billing, latency, and cost remain unverified because no Gemini key or live request is available; mocked tests do not pass D10/D11 or task 4.6.

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

Public model check on 2026-10-28: Google's [model catalog](https://ai.google.dev/gemini-api/docs/models) lists stable `gemini-3.5-flash-lite` and `gemini-3.8-flash`; the [image guide](https://ai.google.dev/gemini-api/docs/image-understanding) demonstrates multiple image inputs, and the [GenerateContent API reference](https://ai.google.dev/api/generate-content) documents `responseJsonSchema` with `oneOf` interpreted as `anyOf`. These are compatibility candidates, not a project model selection. The public [pricing page](https://ai.google.dev/gemini-api/docs/pricing) lists paid input/output rates per million tokens as $0.30/$2.50 for 3.5 Flash-Lite and $0.75/$3.75 for 3.8 Flash through 2026-12-31, changing to $1.50/$7.50 from 2027-01-01. These published rates do not estimate cost per report or confirm project tier, availability or quota. No API key is configured, and no real latency, token use, per-request cost or active project limit has been measured; keep `GEMINI_MODEL_ID` unset until an authorized project probe confirms those facts.

### Historical read-only recheck on 2026-10-28 — issue #8 (before activation)

Read-only checks in the current workstation session reconfirmed the project and narrowed the setup blockers. No API was enabled, secret changed, resource created, or deployment run. For environment secrets, the CLI parsed only key names, the `DEPLOY_ENABLED` state, and presence booleans; it did not print or save secret values.

| Probe | Verified result | Consequence |
|---|---|---|
| Google project metadata | `iskra-512914` is ACTIVE; project number `976498049675` | Project identity is confirmed. |
| Secret Manager | API enabled; `iskra-staging-env` and `iskra-production-env` each have enabled version 1 | The environment records exist. |
| Google CI identities | Workload Identity pool `iskra-github` and provider `github` are ACTIVE; `iskra-ci-staging` and `iskra-ci-production` service accounts exist. | Keyless CI identities are provisioned. This does not supply a Cloudflare deployment token or enable deployment. |
| Relevant API state | Secret Manager, STS, IAM Credentials, Firebase and Identity Toolkit APIs are enabled; Cloud SQL Admin, Generative Language and Vertex AI APIs are disabled. | Existing secret/auth identity plumbing is active; SQL and Gemini APIs are not enabled. No APIs were enabled during this check. |
| Environment JSON shape | Both records contain only `DEPLOY_ENABLED="false"`; Cloudflare token/account ID, `APP_URL`, Gemini, media-signing, Firebase browser and MapTiler values are absent | This agrees with disabled deployment; app/staging and production are not configured. The existing deploy workflow skips build/deploy/smoke when disabled. Latest observed develop workflow run [40600990343](https://github.com/SWOFART/ISKRA/actions/runs/40600990343) completed its validation and skipped those deployment steps. |
| Firebase providers/domains | Email/password and Google sign-in were enabled in the prior Firebase Console check. Authorized domains were `localhost`, `iskra-512914.firebaseapp.com` and `iskra-512914.web.app`; the assumed staging origin was absent. A fresh Identity Toolkit API read via workstation ADC returned 403 because no quota project is configured. | Provider/domain state is not freshly API-verified. Add the verified staging origin before real sign-in; no real sign-in was tested. |
| Project billing / budget | Cloud CLI reports `billingEnabled=true`; the prior console check showed an account-wide Cloud Run alert budget (amount omitted). | This alert budget is not an ISKRA-specific hard spend cap. @kapustazh is the user-confirmed credit/budget/access owner; remaining credit balance, cap/currency/overage authorization and teardown date are unconfirmed. Billing status does not approve new spend. |
| Billing APIs | Cloud Billing and Cloud Billing Budgets APIs are disabled. | API-based billing/budget discovery is unavailable; no APIs were enabled. |
| Cloud SQL | Cloud SQL Admin API is disabled; listing reported `SERVICE_DISABLED` and offered activation | No instance inventory can be inferred. Do not enable the API or provision an instance until the spend cap, teardown and network plan are confirmed. |
| Cloudflare R2 | `wrangler r2 bucket list` returned error 10042 and asked to enable R2 | R2 is not available to this account session yet; no bucket is confirmed or created. Account-side activation remains required. |
| Cloudflare Hyperdrive | `wrangler hyperdrive list` returned no configurations | There is no observed ISKRA Hyperdrive binding/configuration. No SQL connectivity or TLS check has run. |
| Local CLI identities | Google Cloud CLI and Wrangler OAuth resolve to an existing collaborator account, separate from the GitHub commit identity configured in this checkout | This proves only the current collaborator session's read access. It is not the Google keyless CI identity or the product's Cloudflare deployment credential. No Cloudflare account ID or OAuth token is recorded here. |

See Firebase's [web authentication domain guidance](https://firebase.google.com/docs/auth/web/redirect-best-practices) before adding the verified staging origin. Google's [Cloud Billing budgets guidance](https://docs.cloud.google.com/billing/docs/how-to/budgets) distinguishes alert-only budgets from spend caps; the visible account-wide alerts do not establish an ISKRA spending limit. Restricted MapTiler origins, Gemini model/quota, remaining credit/cap/overage authorization and teardown remain unverified. Issue #8 remains open. The workflow run recorded in that historical table skipped deployment. The later successful deployment below supersedes that state.

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

## Firebase browser sign-in and staged application delivery — issues #25/#19

The existing client shell now uses the Firebase browser SDK for Email/Password, account creation, password reset and Google popup. Login is inline and bilingual; guests can return to browsing without a camera/location request. Session persistence is limited to the browser session. Only public `VITE_FIREBASE_*` settings are built into the browser; server requests receive Firebase ID tokens through the existing API client, including its bounded refresh behavior. Passwords and tokens are neither logged nor committed.

Authentication success is followed by a live `POST /api/me/bootstrap` using shared request/receipt schemas. UI action intent stays in memory and resumes only after successful bootstrap. Cancellation clears the intent and invalidates a late sign-in completion. When Firebase succeeds but SQL is unavailable, the screen explicitly says account setup is unavailable and offers retry/sign-out. Camera, map rendering, real Impact and Rewards remain separate work; this change does not claim those screens are complete.

The missing-database bootstrap path now authenticates before returning unavailable: anonymous/invalid credentials return 401; a verified identity still receives 503 until a Hyperdrive database is configured. This is useful real-token verification evidence, but a 503 is not successful account creation or G1. No Firebase Admin/service-account key is needed by the Worker; it verifies Google's public JWT signatures.

Staging deployment requires matching browser/Worker Firebase project settings, the Firebase auth domain and application ID from Google Secret Manager. Unused Gemini/media/MapTiler credentials no longer block deployment of the incomplete staging shell; their features continue to fail closed. Production keeps its existing stronger configuration requirements and manual deployment. `.env.example` still contains blank names only. The GitHub staging environment URL is published only after the workflow's exact-release smoke passes; the Actions summary retains the target/release link.

Local evidence: typecheck, the unit suite, 23 cloud-configuration tests, Vite/Worker dry-run and 16 Chromium/local-workerd tests passed. Browser tests use explicit fake Firebase responses, including failed sign-in, successful provider sign-in followed by bootstrap 503/retry, cancellation with immediate retry and harmless late results, English/German mobile/keyboard and selected-tab persistence after SDK initialization. Desktop/mobile screenshots were inspected. These are local fixtures, not real provider/hardware evidence. Real staging sign-in, Google popup and Android/iOS remain to verify after deployment; SQL/R2/AI and G1/Green remain pending.


## Current staging activation evidence — 2026-10-28

This supersedes the earlier disabled-configuration and missing-domain observations above. No secret values were logged or committed.

- Google Secret Manager `iskra-staging-env` version 4 has `DEPLOY_ENABLED=true`, the account-scoped Workers Scripts: Edit token, account identifier, separate application/check URLs and Firebase browser/Worker configuration. The approved CI token expires **2026-11-04**; rotate it in Google Secret Manager before then. Production remains disabled. A temporary transfer secret version was disabled after transfer; it is not an active configuration source.
- Firebase project `iskra-512914` was freshly API-verified with Email/Password and Google enabled. Its existing ISKRA web application supplies the configuration. The authorized domains include `iskra-staging.matvey-nesterenko.workers.dev` alongside localhost and the Firebase hosting domains. Provider configuration is not proof of a working browser popup or account bootstrap.
- [Workflow 40708613504](https://github.com/SWOFART/ISKRA/actions/runs/40708613504) successfully fetched Google configuration, built, deployed and smoke-tested **the isolated deployment-check target** from develop SHA `bd3a412412ca997695f25c0976ea808bf0158d65`. A separate HTTPS GET confirmed `ok=true`, service `iskra-deployment-check`, that exact release and `applicationReady=false`. This is real CI delivery evidence; it is not an application deployment or G1.
- The staging application origin is configured as `https://iskra-staging.matvey-nesterenko.workers.dev`; application delivery succeeded in workflow 40714986035 at release bbcae49b703792f6ad5a60f3596a6accbf5ff74d; real sign-in verification follows below. SQL/Hyperdrive, private R2, Gemini model/quota/key and MapTiler setup remain incomplete. No new billable SQL instance was provisioned.
- Issue #8 remains open for budget/credits/cap/teardown, SQL/network/TLS, media and AI access acceptance. GitHub contains no environment/key values; Google remains the source and Cloudflare receives operational copies only.


## First application delivery and real-token runtime correction — 2026-10-28

[Workflow 40714986035](https://github.com/SWOFART/ISKRA/actions/runs/40714986035) passed all checks and deployed the actual application from `develop` release `bbcae49b703792f6ad5a60f3596a6accbf5ff74d`. GitHub's staging deployment status reports success with the verified application URL. Production was not deployed.

The subsequent genuine Firebase test caught a runtime defect that unit mocks missed: Cloudflare Workers rejects fetch option `redirect: error` while retrieving Google's signing keys, so valid tokens returned 401. A loopback-only workerd diagnostic reproduced the exact platform error without logging credentials. The fix uses `manual` and rejects non-2xx responses, preserving the fixed key origin and refusing redirects. Typecheck and 25 Firebase verifier tests passed, including hostile-redirect rejection. A fresh real Firebase token then passed the corrected verifier in local workerd; the disposable test user was deleted. Deployment of this correction and real deployed browser verification remain pending at this commit.

The user confirmed that no database has been created. SQL/Hyperdrive and private R2 remain unprovisioned; identity verification cannot count as successful account bootstrap, G1 or Green. No new keys are required for staging delivery or email sign-in. Gemini later requires `GEMINI_API_KEY` and an approved `GEMINI_MODEL_ID`; private media requires `MEDIA_SIGNING_SECRET` and the R2 binding. All configuration continues to originate in Google Secret Manager.

## Upload ticket foundation — task 4.1 / issue #27

Contract `v1-candidate.2`; C-owned routes and evidence admission. This is a partial implementation candidate. #27 remains open until the reservation/quota decisions and integrated acceptance below are reviewed. No canonical OpenSpec task is checked off.

**ASSUMPTION for review:** a reservation is a signed, stateless capability until validated upload finalization. Issuance reads SQL account/cleanup eligibility but writes no photo row, R2 object, cleanup claim, ledger entry or reward. The current photo schema requires an actual content hash and has no separate pre-attachment cleanup-target column; do not insert a fabricated hash or use attachment columns for an upload target. #28 must persist the signed target binding before analysis; B/C must agree the durable representation within B's schema ownership before that integration. This proposal is not an approved schema decision.

Authenticated sequence:

1. Complete Firebase sign-in and B's `POST /api/me/bootstrap` integration (#80). The verified Firebase UID is the SQL `users.id`; the client never supplies an owner. Tickets fail `NOT_ELIGIBLE` if that account does not exist.
2. For each camera JPEG, send `POST /api/uploads` with bearer auth and JSON `{purpose:"REPORT",mimeType:"image/jpeg",byteSize,ordinal}`. Cleanup instead uses `purpose:"CLEANUP"` plus `reportId`. Ordinals are one-based 1–5, declared bytes 1–1,048,576, and unknown fields/arrays are rejected. A cleanup target must currently be GREEN/VERIFIED; issuance claims no cleanup slot, including for self-cleanup.
3. Receive `201 {photoId,uploadUrl,expiresAt,maxBytes}`. The HTTPS Worker URL contains an HS256 capability bound to UID, generated UUID, full metadata, target, issuance time, exact 300-second lifetime and application origin. It cannot be transferred across owners, photo paths or origins. `MEDIA_SIGNING_SECRET` must contain at least 32 bytes from a securely generated random key; Google Secret Manager remains its source. Signing-key rotation invalidates outstanding tickets. No new environment names or GitHub settings values are introduced.
4. The client will PUT bytes to that exact `uploadUrl` with bearer auth and `Content-Type: image/jpeg`. `authorizeUpload` verifies signature, type, issuer, origin, metadata, owner/path and expiry, then rechecks account/cleanup state and rejects any existing photo ID. It derives the private object key internally; public responses expose no provider key or bucket URL. On this branch valid PUT admission still returns `503 UNAVAILABLE`: #28 owns actual byte/type/dimension checks, conditional immutable R2 creation, exact declared-size comparison and SQL finalization. There is no fabricated UPLOADED response. The preflight SQL check alone is not concurrency/overwrite protection.
5. Keep capability URLs out of logs, analytics, error reporting and referrers. Responses use `Cache-Control: no-store` and `Referrer-Policy: no-referrer`; this code logs neither tokens nor SQL/provider data. Confirm query redaction in actual platform access logging at runtime activation. Never expose a public bucket/listing or permanent provider URL.

The frozen HTTP request has no batch/session ID. Ordinal limits are per ticket; `PhotoIdsSchema` owns the unique 1–5 photo selection at analysis admission (task 4.5), not a global count of tickets a resident may mint. Repeated single-photo requests can currently produce additional tickets. Cross-request/UID/IP issuance and storage quotas are **not implemented or approved**; no per-isolate map is presented as a distributed limit. Review B/C's grouping/quota policy before completing #27/live activation. Do not claim the single-request array/ordinal tests prove a distributed quota or six-photo analysis rejection.

Runtime status: `createApp({database,verify})` accepts the existing `TransactionDatabase` boundary for integration/tests. The default Worker now uses `createWorkerHandler()` and a request-scoped PostgreSQL connection when `HYPERDRIVE.connectionString` is configured; transaction primitives and account bootstrap are merged. The Cloudflare Hyperdrive binding, live database credentials/network and private R2 binding are not provisioned. #19 must configure and verify that deployed runtime and supply the Google-sourced signing secret; this PR creates no bucket or cloud resource. G1 and the live evidence checkpoint remain pending.

Verification uses the normal unit suite and `TEST_DATABASE_URL=postgres://iskra_test@127.0.0.1:55432/iskra_test npm run test:integration`. Four new real-PostgreSQL tests apply the unchanged migration only in generated disposable schemas and cover bootstrap identity, cleanup admission/state changes and existing photo IDs. Unit tests cover ticket scope/tampering/expiry and the HTTP boundary. These do not prove a live Firebase token, R2 upload, atomic finalization, rate limit, analysis or Green flow. Roll back by reverting this code; there is no migration, persisted reservation or cloud write to undo.

## Private photo-read integration — task 4.3 / issue #29 (partial)

The C media boundary now implements B's existing `ReportMediaResolver`. When a request has the Hyperdrive database, private `PHOTOS` R2 binding and Google-sourced `MEDIA_SIGNING_SECRET`, `createWorkerHandler` injects the resolver into the existing report/publication/vote/cleanup routes. These consumers no longer need a fixture resolver to produce their shared `Photo` DTO. No public API contract, migration, new key name or dependency is introduced.

`GET`/`HEAD /api/photos/:id/content?token=...` validates an HS256 read capability bound to photo ID, fixed issuer/type, application origin and exact five-minute lifetime. Every request rechecks the current SQL row. Guest links work only for ATTACHED evidence with a real report/cleanup parent; RESERVED photos cannot be read. OWNER capabilities also require the matching verified Firebase identity and current row owner. Keys stay internal to SQL/R2; the response is a JPEG stream, not a bucket/provider redirect. Responses retain no-store, no-referrer and nosniff. HEAD reads metadata only. Missing objects, wrong object lengths or unavailable storage fail safely. Refresh links by refetching the report detail; signing-key rotation invalidates old links. The internal owner-capability producer is available for the later authenticated preview/analysis integration; no new owner-link endpoint or public listing is exposed here.

`removeExpiredPhotos` is an operator/scheduler-only batch: at most 25 SQL-indexed unattached photos whose upload expiry is more than 24 hours old, excluding active unconsumed analyses. It locks each candidate through object deletion and SQL removal; concurrent jobs skip locked photos. Attached evidence is preserved regardless of old upload expiry. Storage failure rolls SQL back; a failure after object deletion leaves an expired row that can be retried with idempotent object deletion. The Worker has a scheduled handler that closes its request-scoped database on success or error.

**Activation and remaining limits:** no cron trigger is configured, so this change does not start automatic cleanup or provision resources. Configure a reviewed schedule only after the private bucket/database are ready and verified. This batch cannot discover objects that have no SQL row; R2-only orphan reclamation must be completed with #28's finalization/object-metadata/target-binding protocol. Owner preview issuance, real upload finalization, live R2 access, actual platform query-token log redaction and controlled-demo retention evidence remain pending. Published-photo retention before a public pilot is still D12. Keep #29/task 4.3 open; do not count this as G1/Green or complete media infrastructure.

Local verification: typecheck, the full unit suite (280 before the added scheduled-close regression), 62 real-PostgreSQL integration tests plus one intentional skipped invariant probe, Vite/Worker build and 16 Chromium/local-workerd browser checks passed. New coverage includes guest published versus owner-only unattached reads, path/origin/key/expiry/tamper rejection, safe storage failure/HEAD behavior, report DTO integration, attached/fresh/active-analysis preservation, real row-lock races, storage/SQL rollback retry and the 25-object batch bound. Integration tests use the unchanged schema in disposable loopback PostgreSQL schemas and an explicitly mocked R2 store; no Cloud SQL connection or cloud resource was created.

The latest verified staging delivery before this branch was [workflow 40718737653](https://github.com/SWOFART/ISKRA/actions/runs/40718737653), exact develop SHA `7fa0aaf65a9dddc0c3ab0ff03c6cbfa68019bd26`. Earlier real email sign-in/token verification and cancellation passed after #104; those checks did not create an ISKRA SQL profile. All real configuration continues to come from Google Secret Manager.

## Cloud SQL staging activation — issue #19 / 2026-10-28

The user approved a **US$10 spending allowance for 48 hours** on 2026-10-28. Google Cloud SQL Admin and Cloud Billing catalog APIs were enabled under that setup request. The new staging instance is `iskra-staging-pg` in project `iskra-512914`, region `europe-west3` (Frankfurt), PostgreSQL17, Enterprise `db-f1-micro`, single zone, fixed10GiB SSD with automatic storage growth disabled. Google's regional SKU catalog lists compute atUS$0.0126/hour (US$0.6048/48hours), before storage, backup/network charges and taxes; this is a test tier without a production SLA. The allowance is not a Google-enforced billing cap. Creation began2026-10-28T16:39:26Z, so the approved48hours ends2026-10-30T16:39:26Z (17:39Berlin); retention/spending after that needs a follow-up decision. An expiry label records the date; it is not an automatic deletion mechanism.

The instance requires trusted client certificates and accepts direct PostgreSQL connectivity only from Cloudflare's published15IPv4 CIDRs. No world-wide0.0.0.0/0 rule is used. Hyperdrive is to use the instance-specific CA, a Cloud SQL client certificate, strict `verify-ca`, caching disabled and a small origin pool. Local operator access uses Cloud SQL Auth Proxy2.26.3 on loopback with Google IAM/TLS, not an extra permanent network allowlist. No service-account JSON private key is introduced.

Private operator credentials/certificates and connection metadata live in the separate Google Secret Manager record `iskra-staging-sql-access`, replicated in Frankfurt. It is not read by the GitHub CI identity or sent to the browser/Worker. The runtime database user and migration user have separate generated passwords; Cloudflare receives operational copies only. The existing `MIGRATION_DATABASE_URL` name remains operator-only; no migration credential belongs in Worker runtime secrets.

`HYPERDRIVE_ID` is the new blank name in `.env.example`; its value belongs in `iskra-staging-env` in Google Secret Manager. CI generates a0600temporary Wrangler config with the selected environment's HYPERDRIVE binding, resolving main/assets paths from the repository before passing `--config` to Wrangler. The ID is not a database password and is not copied into browser/Worker environment variables; no GitHub settings value or actual binding ID is committed. The temporary config is removed by the existing always-run cleanup. An absent ID keeps the existing honest unavailable database behavior until activation.

The reviewed baseline checksum remains `bae5a68906a6e4ba971d06a7cae1e02a3b989e81dba0d00551a3d6fb945aeaa8`. Apply it once, transactionally, with the dedicated migrator after a verified pre-migration Cloud SQL backup. The application runtime must not own the schema, create/alter/drop tables, mutate existing reward-ledger rows or delete reports. Runtime role/search-path, actual migration/backup, Hyperdrive TLS/cache-off and real Firebase profile creation evidence must be recorded after completion; provisioning alone does not pass G1. Backup restore, storage/AI, real devices and the full Green scenario remain separate acceptance.

Prepared code verification:28cloud-configuration tests,281unit tests, typecheck, application build, three check-Worker tests/build and diff-check passed. A Wrangler dry-run using a deliberately fake test Hyperdrive ID confirmed that the generated config retains assets and the HYPERDRIVE binding without deploying or printing credentials. Live activation is pending at this commit.

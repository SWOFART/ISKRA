# ISKRA

**One Photo. Three Paths. Real Impact.**

ISKRA is a mobile-first civic reporting and community action project for the Green City Hackathon in Heilbronn. Its name comes from the Ukrainian word **«іскра»**, meaning **“spark.”** The idea is simple: a photo can spark a practical, verifiable response to a problem in the city.

## The idea

A resident photographs a local issue. The application uses the evidence to suggest one of three paths. AI helps assess and describe what is visible, but it does not decide that an issue has been resolved. Residents verify the important steps.

### Green — clean it up together

Green is the core community cleanup flow:

1. A resident captures 1–5 new photos and a current location, then submits the report for analysis.
2. The service assesses the submitted photos and routes an accepted report to Green when it appears suitable for community cleanup.
3. Other eligible residents confirm that the issue exists. Three distinct eligible YES votes verify this stage.
4. The reporter or another resident can choose to clean it up. That action is not a reservation and does not guarantee a reward.
5. The cleaner captures new after-photos and location. The service checks that the evidence appears to show the same place, that it is clean, and that no hazard remains.
6. Three distinct eligible YES votes verify the cleanup and resolve the report.

The current Green reward policy awards the reporter 5 RP when the report is published and 15 more RP after resolution. The verified cleaner receives 40 RP after resolution. Each accepted YES or NO verification vote earns its voter 5 RP. RP means reward points; it is not an Impact Score.

### Yellow — organize a community initiative

Yellow is intended for issues that could benefit from a group activity, such as an organized cleanup. The planned flow includes creating or joining a mission associated with an eligible Yellow report. Mission attendance and rewards require separate verification rules. This path is not complete in the current application.

### Red — respond safely to a hazard

Red is for potentially hazardous situations. The intended experience gives residents immediate, cautious safety guidance and may help them prepare a factual, personal report. The application will not encourage residents to handle dangerous materials, send complaints automatically, claim that an authority received a complaint, or mark an issue resolved just because a report was prepared. This path is not complete in the current application.

## Product principles

- **Evidence before claims:** publication, AI analysis, community verification and resolution are separate states.
- **AI assists; residents verify:** model output cannot set votes, balances or a resolved status.
- **Fresh, camera-captured evidence:** the planned report and cleanup flows use newly captured photos and measured location, rather than gallery uploads or silent drafts.
- **No implied assignment:** choosing to clean locally does not reserve a report or promise the cleaner a reward.
- **Safety first:** uncertain or hazardous evidence must not silently become a Green cleanup task.
- **Honest civic actions:** preparing a report is not the same as sending it or receiving a response from a municipality.

## Current implementation status

The `develop` branch integrates a mobile-first client shell with the **Hono** API and **Cloudflare Workers**. The Worker can serve the shell and direct client routes. The interface structure is available in staging and can be run locally from `develop`.

The shell is not yet a complete product flow: sign-in, live map data, camera capture and report-detail data are still placeholders, and the complete camera-to-resolution Green journey is not ready. The server has request and security middleware, Firebase ID-token verification, shared API contracts, a health endpoint, and parts of the report, vote, cleanup and impact API/domain logic. Some domain endpoints still return `503` until their dependencies and integrations are available. The health endpoint reports `applicationReady: false` while the genuine Green flow is incomplete.

**Branch note:** older feature branches may predate the client integration. In those checkouts, `npm run dev` starts only the API Worker and client page routes return `503`. Use an up-to-date `develop` checkout to run the client shell as described below.

## Technology

### In the repository now

- **Hono** API running on **Cloudflare Workers**
- **TypeScript** with strict type checking
- **Firebase ID-token verification** for protected requests
- Shared request and response contracts, validation and security boundaries
- **Vitest** unit and integration test suites; **Playwright** browser smoke tests

### Product architecture in the plan

The target is a mobile-first web client served with the API from Cloudflare Workers. The planned services include Firebase Authentication, PostgreSQL through Cloudflare Hyperdrive, private photo storage, Gemini for photo analysis, and MapLibre for the map. These are target architecture components; their presence in the plan does not mean every service is already connected or production-ready.

## Run locally

### Requirements

- Node.js **24 or newer**
- npm
- Docker only if you want to run the optional disposable PostgreSQL integration tests

### Start the client shell and API Worker

From an up-to-date `develop` checkout, install the locked dependencies and start Wrangler in local mode. The `dev` script first builds the browser client, then starts the Worker that serves it:

```bash
npm ci
npm run dev -- --local
```

Open the application at `http://localhost:8787/`. The API health endpoint is:

```text
http://localhost:8787/api/health
```

The health response should be JSON with `ok: true`, `release: "local"`, and `applicationReady: false`. The page confirms that the client shell is being served; the health response confirms that the Worker is running. Neither confirms that sign-in, live map data, camera evidence, database, AI analysis, photo storage or the complete Green workflow is working. The shell and health check need no cloud credentials. Stop the server with `Ctrl+C`.

If your checkout does not have `src/client/` and `vite.config.ts`, it predates the client integration. In that checkout, the same `npm run dev -- --local` command runs the API Worker only and client page routes return `503`.

### Run the available project checks

```bash
npm run typecheck
npm run test:unit
npm run build
```

On `develop`, `npm run build` builds the browser client and then runs Wrangler's dry-run Worker build. It does not deploy the application. Integration checks use a disposable, loopback-only PostgreSQL database; browser smoke tests start a local Worker and Chromium. See the [runbook](infra/runbook.md#disposable-postgresql-and-browser-harness--task-24) for the exact setup and safety constraints.

## Configuration and credentials

The local health check requires no secrets. Authenticated product flows require a real Firebase project configuration and the relevant server services; there is no unsigned-token or authentication-bypass mode.

Google Cloud Secret Manager in project `iskra-512914` is the source of environment values and keys. The root `.env.example` lists variable names only and contains no values. Do not commit credentials, put them in README examples, or store them in GitHub variables or secrets. See the [infrastructure runbook](infra/runbook.md) for environment and deployment procedures.

## Repository guide

- [`src/client/`](src/client/) — client shell and browser-side modules (available on `develop`)
- [`src/worker/`](src/worker/) — Worker entry point, middleware, routes, database runtime and services
- [`src/shared/`](src/shared/) — shared API contracts, schemas, location helpers and API documentation
- [`migrations/`](migrations/) — reviewed PostgreSQL migrations
- [`tests/`](tests/) — unit, integration, end-to-end and fixture files
- [`infra/`](infra/) — deployment runbook and isolated deployment-check Worker
- [`openspec/changes/build-iskra-hackathon-mvp/`](openspec/changes/build-iskra-hackathon-mvp/) — active product specifications and implementation tasks

## Project documentation

- [Product and implementation plan](plan.md)
- [Active OpenSpec change](openspec/changes/build-iskra-hackathon-mvp/)
- [Infrastructure and deployment runbook](infra/runbook.md)
- [Contribution guide](CONTRIBUTING.md)
- [Team UX and design board](https://miro.com/app/board/uXjVEYikPLY=/)

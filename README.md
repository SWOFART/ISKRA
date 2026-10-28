# ISKRA

**One Photo. Three Paths. Real Impact.**

ISKRA (from Ukrainian «іскра», “spark”) is a mobile-first civic cleanup web app planned for the 48-hour Green City Hackathon in Heilbronn.

This repository is the team's documentation and delivery base: **https://github.com/SWOFART/ISKRA**.

## Start here

- [Implementation plan](plan.md): requirements, priorities, architecture, API/data contracts, risks and milestones.
- [Active OpenSpec change](openspec/changes/build-iskra-hackathon-mvp/): current approved policy refinements, owner boundaries and implementation tasks. Its later confirmed decisions supersede conflicting historical examples in `plan.md`.
- [Infrastructure and CI/CD runbook](infra/runbook.md): tooling, environments, credentials and deployment activation.
- [Contribution workflow](CONTRIBUTING.md): issues, branch names, PRs, checks and releases.
- [Team Miro board](https://miro.com/app/board/uXjVEYikPLY=/): primary UX/design source.
- [Villa Borghese](https://www.behance.net/gallery/230474273/Villa-Borghese-Visual-Identity-Wayfinding-Project): sole retained external design reference.

## Current status

Person A's three-tab client shell is integrated with Person C's Vite build and Hono Worker. `npm run build` generates browser files in `dist/client` and a dry-run Worker bundle in `dist/worker`. The Worker serves the shell on direct client routes, including `/impact` and `/reports/:id`, while unknown `/api` routes remain JSON 404. Sign-in, map, camera and report-detail data are still placeholders; B's unfinished domain facade returns explicit JSON 503. `/api/health` keeps `applicationReady: false` because the genuine Green flow is incomplete.

The infrastructure-only [deployment-check Worker](infra/deployment-check/) remains separate. Neither Worker health nor local tests prove a working Green flow.

```bash
npm ci
npm run typecheck
npm run test:unit
npm run build
npm run dev -- --local
```

`npm run dev` builds the client and starts a local Worker; restart it after client changes. This deliberately reuses Wrangler's existing asset/runtime/deployment path rather than adding a second dev server. The shell and health/404 checks need no credentials. Authenticated routes will require Google-sourced `FIREBASE_PROJECT_ID` and real Firebase ID tokens; no auth emulator or signature bypass exists.

Person C's [test harness](infra/runbook.md#disposable-postgresql-and-browser-harness--task-24) adds `npm run test:integration` against disposable loopback PostgreSQL and `npm run test:e2e` against a local Worker/Chromium. Browser checks cover the served shell, deep links, keyboard/mobile navigation and API boundaries. Domain transactions, real sign-in/capture and real Green acceptance remain separate work.

Production will run on **Cloudflare Workers**, serving Vite browser assets and Hono `/api/*` routes. The current shell uses A's DOM implementation; integrating it does not add React or redesign the client. It must work when a developer's computer is off. Google Cloud SQL, Firebase Authentication and Gemini remain the planned services.

The user-provided tunnel `c0c32852-fe5d-4a65-af4c-058cdf786627` is reserved for development previews; it is not the production hosting target or a Workers deployment credential. Its hostname and connector status have not been verified.

## CI/CD

- Pull requests and pushes to `main`/`develop` run repository checks, root typecheck/unit tests/client and Worker build, disposable PostgreSQL tests plus a failure-detection probe, local Worker/Chromium smoke and the separate deployment-check Worker tests/build. No production credentials are used by these tests.
- Changes on `develop` can deploy to `staging` after CI passes and deployment is enabled in Google. With the root manifest present, automatic target selection chooses the root Worker. Keep deployment disabled until the product prerequisites in the runbook are met; this foundation alone is incomplete.
- Production deployment is a manual **Deploy to Cloudflare** workflow run from `main`.
- All environment values and keys come from **Google Cloud Secret Manager** in project `iskra-512914`. GitHub settings contain no environment variables or secrets. Keyless Google federation is used by CI; `.env.example` contains key names only.
- Deployment starts disabled in the Google configuration (`DEPLOY_ENABLED=false`). Actual values will be populated there later; a tunnel ID is not a deployment credential.
- A passing CI or deployment-check Worker is not evidence of a working product application. See the [activation checklist](infra/runbook.md#activate-deployment).

No Docker image build, container registry or image update pipeline is needed for the selected Workers deployment.

## Git identity

Commits and pushes use **kapustazh**, with GitHub privacy email `51422901+kapustazh@users.noreply.github.com`. The earlier setup commits were rewritten at the user's request.

## Current scope

The user is Person C under the existing OpenSpec split. This branch integrates A's existing client entry with C's build and Worker configuration. A owns the client, B owns shared contracts/domain/SQL and the canonical OpenSpec checklist. C reports evidence and pending dependencies through the PR; this branch does not reassign people or mark partial tasks complete.

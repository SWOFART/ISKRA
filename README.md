# ISKRA

**One Photo. Three Paths. Real Impact.**

ISKRA (from Ukrainian «іскра», “spark”) is a mobile-first civic cleanup web app planned for the 48-hour Green City Hackathon in Heilbronn.

This repository is the team's documentation and delivery base: **https://github.com/SWOFART/ISKRA**.

## Start here

- [Implementation plan](plan.md): requirements, priorities, architecture, API/data contracts, risks and milestones.
- [Infrastructure and CI/CD runbook](infra/runbook.md): tooling, environments, credentials and deployment activation.
- [Contribution workflow](CONTRIBUTING.md): issues, branch names, PRs, checks and releases.
- [Team Miro board](https://miro.com/app/board/uXjVEYikPLY=/): primary UX/design source.
- [Villa Borghese](https://www.behance.net/gallery/230474273/Villa-Borghese-Visual-Identity-Wayfinding-Project): sole retained external design reference.

## Current status

The repository contains documentation, GitHub Actions and an infrastructure-only [deployment-check Worker](infra/deployment-check/). The product application and database migrations have not been implemented. The check Worker exposes only `/api/health` and explicitly reports `applicationReady: false`.

Production will run on **Cloudflare Workers**, serving React/Vite assets and Hono `/api/*` routes. It must work when a developer's computer is off. Google Cloud SQL, Firebase Authentication and Gemini remain the planned services.

The user-provided tunnel `c0c32852-fe5d-4a65-af4c-058cdf786627` is reserved for development previews; it is not the production hosting target or a Workers deployment credential. Its hostname and connector status have not been verified.

## CI/CD

- Pull requests and pushes to `main`/`develop` run repository checks and the deployment-check Worker tests/build. Application checks become mandatory when `package.json` is added: a lockfile, `typecheck`, `test:unit`, `build`, and project-local Wrangler are required.
- Changes on `develop` can deploy to `staging` after CI passes and deployment is enabled. Until the root application exists, this deploys only the infrastructure-check Worker.
- Production deployment is a manual **Deploy to Cloudflare** workflow run from `main`.
- All environment values and keys come from **Google Cloud Secret Manager** in project `iskra-512914`. GitHub settings contain no environment variables or secrets. Keyless Google federation is used by CI; `.env.example` contains key names only.
- Deployment starts disabled in the Google configuration (`DEPLOY_ENABLED=false`). Actual values will be populated there later; a tunnel ID is not a deployment credential.
- A passing CI or deployment-check Worker is not evidence of a working product application. See the [activation checklist](infra/runbook.md#activate-deployment).

No Docker image build, container registry or image update pipeline is needed for the selected Workers deployment.

## Git identity

Commits and pushes use **kapustazh**, with GitHub privacy email `51422901+kapustazh@users.noreply.github.com`. The earlier setup commits were rewritten at the user's request.

## Current scope

Deployment and CI/CD only. Product work and team coordination are handled separately; this setup does not assign people, split implementation tasks or start product features.

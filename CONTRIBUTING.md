# Contributing to ISKRA

Use [plan.md](plan.md) for product rules and architecture, and [infra/runbook.md](infra/runbook.md) for deployment. Team assignments are coordinated separately.

## Issue → branch → pull request

1. Open one issue per actionable bug or task, with acceptance criteria. Check existing issues first and assign the issue to the person doing the work.
2. Branch from the latest `develop`. Keep the change focused on that issue.
3. Run the relevant checks and open a **draft pull request targeting `develop`**. Include `Closes #<number>` when merging should complete the issue.
4. Request review when the change is ready. A human reviews and merges after CI passes.
5. Release through a separate PR from `develop` to `main`. Production deployment remains a manual action; merging a PR does not deploy production.

Do not push feature work directly to `develop` or `main`. Do not force-push shared branches without explicit authorization. These are contribution rules; server-side branch protection is not configured by this change.

## Branch names

Use `type/<issue-number>-short-description`, lowercase with hyphens:

| Type | Use | Example |
|---|---|---|
| `feat` | New functionality | `feat/12-report-camera` |
| `fix` | Bug fix | `fix/18-duplicate-vote` |
| `docs` | Documentation | `docs/21-api-contracts` |
| `chore` | Tooling, CI or infrastructure | `chore/24-cloudflare-deploy` |
| `refactor` | Internal changes without a behavior change | `refactor/28-photo-validation` |
| `test` | Test coverage | `test/30-reward-races` |
| `codex` | Agent-created task branch | `codex/32-repository-conventions` |

For a small task without an issue, omit the number, for example `codex/repository-conventions`. Long-lived branches are exactly `develop` and `main`. Release PRs use `develop` → `main`, with no extra release branch required. These naming conventions are checked by reviewers, not by an additional CI validator.

## Commits and PR titles

Use `type: short description`, for example `fix: prevent duplicate vote rewards`. The types above apply; a scope such as `fix(auth): ...` is optional. Explain the resulting behavior, validation and material limits in the PR. Keep secrets and personal data out of descriptions, screenshots and logs.

Set your own Git identity locally; do not copy another contributor's author identity. Git authentication controls who pushes, while the commit author is separate metadata. Agents in this workstation use the authorized GitHub identity configured for this repository.

## Checks

For infrastructure/configuration changes, run:

```bash
python3 -m unittest discover -s .github/scripts -p 'test_*.py'
npm ci --prefix infra/deployment-check
npm test --prefix infra/deployment-check
npm run build --prefix infra/deployment-check
git diff --check
```

Once the application exists, run its required `typecheck`, `test:unit` and `build` scripts as well, plus checks relevant to the changed behavior. Do not weaken checks to make CI green. A dry-run or health-check Worker is not a successful product deployment.

## Configuration and deployment

- Google Secret Manager in `iskra-512914` is the source for all environment values and keys. `.env.example` has names and blank values only.
- Do not store keys or environment values in GitHub settings. Public Google authentication bootstrap identifiers live in `infra/cloudflare-bootstrap.json`.
- `develop` uses staging; `main` uses production. Follow the runbook for keyless authentication, deployment activation and rollback.
- Tests must preserve transaction, idempotency and authorization guarantees for votes, rewards and uploads. Clearly label simulated data.

## Template provenance

The review topics and problem-report structure were informed by [SWOFART/open-circuit](https://github.com/SWOFART/open-circuit). ISKRA's templates are independently worded and adapted to this repository. Open Circuit's desktop build pipeline and mandatory manual Gate A process are not ISKRA requirements. The existing ISKRA MIT license is unchanged.

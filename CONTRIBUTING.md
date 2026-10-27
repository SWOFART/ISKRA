# Contributing to ISKRA

Use [plan.md](plan.md) and the [active OpenSpec change](openspec/changes/build-iskra-hackathon-mvp/) for product rules and architecture; later confirmed OpenSpec decisions supersede conflicting historical plan examples. Follow [infra/runbook.md](infra/runbook.md) for deployment and the existing A/B/C ownership boundaries.

## Issue → branch → pull request

1. Open one issue per actionable bug or task, with acceptance criteria. Check existing issues first and assign the issue to the person doing the work.
2. Branch from the latest `develop`. Keep the change focused on that issue.
3. Run the relevant checks and open a **draft pull request targeting `develop`**. Include `Closes #<number>` when merging should complete the issue.
4. Complete the required PR checklist and independent Gate A below before marking ready for review. A human reviews and merges after the remaining gates pass.
5. Release through a separate PR from `develop` to `main`. Production deployment remains a manual action; merging a PR does not deploy production.

Do not push feature work directly to `develop` or `main`. Do not force-push shared branches without explicit authorization. These are contribution rules; server-side branch protection is not configured by this change.

## Required PR gates

Use the [PR template](.github/pull_request_template.md) for every PR, including PRs opened through a CLI. Templates do not retroactively populate existing PRs, and a custom `--body-file` must retain the checklist. Keep incomplete gates unchecked and the PR draft; do not mark them satisfied merely because follow-up work is documented.

1. **Scope and acceptance:** link existing task issues, record criteria and verify only what the change claims. Use `Related #N` for partial work and `Closes #N` only after the whole task is complete. B alone updates the canonical OpenSpec checklist after integrated evidence; A/C hand off through PRs.
2. **Architecture/security/configuration:** verify the template's required checks, including OpenSpec ownership/contracts, safe data handling and Google-sourced configuration. Explain non-applicable guarantees explicitly; do not copy another project's build stack.
3. **Independent Gate A:** fill the [review prompt](.github/prompts/gate-a-review.md) with the issue/criteria, exact base and HEAD SHAs, validation results and known omissions. Provide the filled prompt to the user for independent review. Record the actual user-provided reviewer/verdict/evidence. Author self-review or an invented PASS does not qualify. Until evidence arrives, use PENDING and stay draft. Resolve blocking findings; any new commit or changed reviewed base requires a new verdict for that candidate.
4. **CI and OpenSpec acceptance:** CI must pass for the current HEAD; applicable G0–G5/H48 gates must have real evidence. Document N/A only when the task does not require that milestone. A dry-run, fixtures or health endpoint cannot pass a live runtime/Green gate.
5. **Human review and merge:** an independent human reviews the PR and a human owner merges it. Agents do not approve their own changes or merge automatically.

These are mandatory review-process gates, matching Open Circuit's manual review pattern. Markdown checkboxes do not technically block GitHub merging. No new body validator or branch-protection rule is installed here; current develop is unprotected, so maintainers must enforce this process until repository protection is configured separately.

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

The review topics, required checklists and independent Gate A pattern were adapted from [SWOFART/open-circuit](https://github.com/SWOFART/open-circuit), as requested by the user. ISKRA's template and reusable prompt are independently worded for OpenSpec, Workers and Google-sourced configuration. Open Circuit's desktop build pipeline is not imported. The existing ISKRA MIT license is unchanged.

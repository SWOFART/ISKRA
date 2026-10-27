# Working in ISKRA

- Read `plan.md`, `CONTRIBUTING.md`, and relevant code before changing behavior. Deployment work also follows `infra/runbook.md`.
- Check the branch and working tree first. Preserve unrelated work; use a focused task branch, normally from `develop`, following CONTRIBUTING.md.
- Keep changes limited to the user's task. Do not assign people or split the project unless explicitly requested.
- Use Google Secret Manager as the environment/key source. Never commit/log secret values or add them to GitHub variables/secrets. `.env.example` contains names and blank values only.
- Keep contracts, documentation and relevant tests consistent. Preserve validation, authorization, database transactions and idempotency. Do not bypass CI or report a mock/dry-run as a real integration.
- Link an issue when one exists; check for duplicates before creating a requested issue. State acceptance criteria and verification clearly.
- Open agent-created PRs as drafts targeting `develop`; release PRs go from `develop` to `main`. A human reviews and merges. Do not force-push or rewrite shared history without explicit user authorization.
- Follow the existing deployment workflow. Do not import another repository's build stack or approval gates as unstated requirements.
- The user explicitly requested Open Circuit's checklist/Gate A pattern. Preserve the full PR template when creating/updating a PR, follow CONTRIBUTING.md's required gates, and provide the filled `.github/prompts/gate-a-review.md` prompt for independent review. Gate A stays PENDING without an actual user-provided verdict; self-review is not independent evidence.

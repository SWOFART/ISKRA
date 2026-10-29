# Working in ISKRA

- Read `plan.md`, `CONTRIBUTING.md`, and relevant code before changing behavior. Deployment work also follows `infra/runbook.md`.
- Check the branch and working tree first. Preserve unrelated work; use a focused task branch, normally from `develop`, following CONTRIBUTING.md.
- Keep changes limited to the user's task. Do not assign people or split the project unless explicitly requested.
- Use Google Secret Manager as the environment/key source. Never commit/log secret values or add them to GitHub variables/secrets. `.env.example` contains names and blank values only.
- Keep contracts, documentation and relevant tests consistent. Preserve validation, authorization, database transactions and idempotency. Do not bypass CI or report a mock/dry-run as a real integration.
- Link an issue when one exists; check for duplicates before creating a requested issue. State acceptance criteria and verification clearly.
- Open agent-created PRs as drafts targeting `develop`; release PRs go from `develop` to `main`. Codex may mark a PR ready and merge it after Gate A passes for the exact base/HEAD, required CI passes for the current HEAD, and applicable OpenSpec acceptance gates have evidence. No human review or approval is required. Do not bypass active GitHub protection rules or required checks. Do not force-push or rewrite shared history without explicit user authorization.
- Follow the existing deployment workflow. Do not import another repository's build stack or approval gates as unstated requirements.
- Preserve the full PR template when creating/updating a PR and follow CONTRIBUTING.md's required gates. Complete Gate A with the filled `.github/prompts/gate-a-review.md` prompt in a fresh, read-only Codex review pass; the implementation agent may perform this pass and must identify itself truthfully. Gate A stays PENDING until that actual review returns PASS; each new commit or changed base requires another review. No user-provided verdict or separate human approval is required.

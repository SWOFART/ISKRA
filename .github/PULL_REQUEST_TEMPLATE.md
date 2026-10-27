## Summary

<!-- Concrete problem and resulting behavior. Related #123 for partial work; Closes #123 only for a fully completed issue. -->

## Scope and acceptance criteria — required

- [ ] The change is limited to the linked issue/task, with no unrelated cleanup.
- [ ] Each claimed acceptance criterion has evidence; incomplete criteria remain listed and the PR stays draft.
- [ ] The branch/title follow CONTRIBUTING.md and the target is develop (release: develop → main).

Acceptance criteria and remaining work:

<!-- List criteria, evidence and dependencies. Do not close a whole issue for a partial foundation. -->

## Architecture and OpenSpec — required

- [ ] The change follows plan.md and the active OpenSpec change's later confirmed decisions.
- [ ] File ownership, frozen contracts and affected interfaces are respected and documented.
- [ ] Task IDs, contract revision and applicable OpenSpec gates have evidence; no partial task is marked complete.

OpenSpec change / task IDs / contract revision:

| Applicable gate | PASS / FAIL / PENDING / N/A | Evidence or reason for N/A |
|---|---|---|
| <!-- G0 contracts, G1 runtime, G2/G3 real Green, G4 freeze, G5 rehearsals, H48 handoff; list only applicable gates --> | PENDING | |

## Security, data and configuration — required

- [ ] No secrets, credentials or sensitive personal data are included.
- [ ] Relevant authorization, privacy, transaction/idempotency and accessibility guarantees are preserved.
- [ ] Environment values come from Google Cloud; .env.example contains names only; no GitHub settings values were added.
- [ ] Deployment changes follow infra/runbook.md and preserve environment separation and manual production deployment.

Notes / non-applicable guarantees and reasons:

<!-- A check means verified or explicitly explained N/A. Gate A, passing CI and human review cannot be waived by N/A. -->

## Validation — required

```text
command/check: PASS / FAIL / NOT RUN — concise evidence
```

Not tested / live acceptance still missing:

## Independent Gate A review — required before ready for review

<!-- Use .github/prompts/gate-a-review.md. Author self-review is not Gate A. Record only an actual independent verdict supplied by the user; otherwise keep PENDING. -->

- Candidate base revision:
- Candidate HEAD revision:
- Exact prompt provided to the user (link or text, with revisions filled):
- User-provided Gate A verdict: `PENDING`
- Reviewer / evidence:
- Blocking findings and resolution / residual risks:

## Risks and recovery

- Remaining risks:
- Rollback / data migration implications:
- Follow-up issues:

## Merge gates — required

- [ ] Independent Gate A is PASS for the exact base and HEAD above; blocking findings are resolved.
- [ ] Required CI checks pass for the current HEAD.
- [ ] Applicable OpenSpec acceptance gates pass; no fixture/dry-run is presented as live evidence.
- [ ] An independent human review is complete; a human owner performs the merge.

<!-- Keep unchecked gates visible and stay draft. Any new commit invalidates the prior Gate A verdict. This checklist records process; repository rules must separately enforce merge restrictions. -->

# Shared API contracts

Issue #6 / OpenSpec task 1.2, extended by issue #7 / task 1.3 and issue #56 / task 9.2; revision `v1-candidate.3`. These are executable contract candidates for A/B/C review, not a frozen G0 contract or live product implementation. B (@SuPuHe) owns this directory. Root configuration and mounts remain C-owned. See the [API v1 handoff](api-v1.md) for endpoint, error, upload, location, internal-interface, mission and RP rules; G0 remains pending A/C acknowledgment.

- [contracts.ts](contracts.ts): policy constants, strict JSON runtime schemas and inferred TypeScript DTOs. Schema objects expose `parse(unknown)` and `safeParse(unknown)`; failures never coerce input, strip unknown fields or include input values in error text. This small dependency-free validator supports only the JSON shapes used here.
- [api-v1.md](api-v1.md): the P0 API and internal contract handoff, including machine-matched HTTP/error retry policy. It remains a review candidate until A/C acknowledge it.
- [location.ts](location.ts): measured distance and new-action admission. A valid fix is at most 60 seconds old, at most 50m reported accuracy and within 150m for voting/cleanup; the report pin may move at most 3m. Freshness is a server-clock operation check, not a property of a timeless DTO. Accepted operation replays and consumption of still-valid bound analyses skip new-action freshness. These helpers do not prove physical presence.
- [p0.json](../../tests/fixtures/contracts/p0.json): synthetic `DEMO` examples for A/C. `demo.invalid` URLs and tokens are inert placeholders. Run them through the same exported schemas as actual responses. Never activate them as a production fallback or live acceptance evidence.

Validation from the repository root with Node 24:

```sh
npm run test:unit
npm exec tsc -- --project tests/unit/contracts/tsconfig.json
npm run typecheck
npm run build
```

The current root TypeScript include belongs to C and covers the platform only. The explicit contracts project checks shared source, fixtures and contract tests without editing C's configuration; C should include these in the eventual root/CI typecheck. Vitest already discovers the contract tests.

## Consumer rules

All objects are strict, including nested objects and empty request bodies. UUIDs identify reports/photos/analyses/operations; user IDs are bounded Firebase UIDs. Timestamps are canonical UTC seconds or milliseconds. Enums are uppercase except locale and `heilbronn`. Text stays plain text; schema validation is not HTML sanitization. UI renders text without execution. Every object field is required; nullable fields explicitly use null. Analysis envelopes form a union: RUNNING has only ID/status; READY has result/expiry; FAILED has a safe structured error. A READY result can be ACCEPT or RETAKE; RETAKE never has a route. Locale is explicitly required on analysis inputs to bind generated text to the input hash.

`PublicReportDetailSchema` forbids viewer/account data. `ViewerReportDetailSchema` adds only per-stage viewer permissions, never private balances. Owner mutation receipts/Impact carry separate account `balanceVersion`; report `version` cannot order balances across reports. Public identity excludes email/provider name. Producers must deliberately construct the appropriate projection before validation; these schemas reject leaks rather than silently filtering them. Unattached photos, analyses, Impact and notifications require owner authorization outside these DTO schemas.

During AWAITING_RESOLUTION, `currentStage` is RESOLUTION while both vote stages stay open. Existence YES counts are not capped at 3; resolution counts are 0–3. Permission flags are private hints: server services must recheck identity, roles, current stage and location under the authoritative transaction. Media URLs are scoped expiring HTTPS capabilities; actual provider scope, ownership and expiry enforcement remain C's media implementation.

Reporter total is 20 per report (5 initial +15 final), cleaner 40 after resolution, and each newly accepted YES/NO vote pays 5. Cleanup submission returns only provisional 40, with no actual balance credit. Vote replay returns zero new RP and current balance/report versions. Publication receipt can return 0 for replay or 5 for a new publication. Lifetime earned RP and category totals remain distinct from spendable signed balance and pending RP; a future negative balance is representable.

New publication (`rpAwarded:5`) returns the initial committed AWAITING_EXISTENCE report with zero existence votes. A publication replay (`rpAwarded:0`) returns the current report/account snapshots, which may have advanced. The new-cleanup example starts resolution at 0/3; replaying cleanup may carry a later canonical report snapshot, with the same provisional amount and no actual payment.

The schemas record D01–D08 and required P0 DTOs. They do not implement JWT verification, SQL transactions, rate limits, photo decoding, analysis expiry/consumption, live provider calls or conditional P1 routes. Platform errors `UNAVAILABLE` and `INTERNAL_ERROR` have explicit HTTP/retry policy alongside the planned codes. No live integration or G0 pass is claimed.

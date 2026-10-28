# API v1 candidate handoff

OpenSpec `build-iskra-hackathon-mvp`, task 1.3 / issue #7. Contract revision: `v1-candidate.2`.

This is the review candidate for A/B/C. It consolidates the already selected D01–D08 policies and the P0 DTOs in [contracts.ts](contracts.ts). G0 remains **PENDING** until A and C acknowledge the endpoint, error, media, location and internal-interface boundaries and the required independent review is complete. No product policy is reopened here. Changes after acknowledgment require a new candidate revision and consumer notes.

## Shared HTTP rules

- API base is `/api`; JSON uses UTF-8, UUID resource/operation IDs and canonical UTC timestamps. Requests reject unknown fields and client-supplied authority such as `userId`, route, status, tally, reward or balance.
- Protected endpoints use `Authorization: Bearer <Firebase ID token>`. `GET /reports` and `GET /reports/:id` allow a guest or authenticated viewer. `GET /photos/:id/content` uses a scoped expiring capability; unattached media also requires its owner identity.
- Every error uses `{error:{code,message,requestId,retryable}}`. Messages are safe for display; never include SQL, JWTs, capability values, provider payloads or private identity. Public/private responses use `Cache-Control: no-store`; no auth-aware response is shared-cacheable.
- `Idempotency-Key` is a UUID required for report/cleanup AI analysis, publication, votes and cleanup submission. Reuse the same key and body after an ambiguous transport failure. A changed body conflicts. When a resident changes inputs or starts a fresh analysis after failure/expiry, use a new operation key. Semantic database uniqueness remains authoritative if a client loses its key.
- `retryable:true` means the UI has a defined recovery path while retaining the resident's intent or evidence. It never authorizes blind retries. Reuse the original key for an uncertain outcome; create a new key only for an explicitly changed request or a fresh analysis attempt. Rate-limit responses may include `Retry-After`; clients honor it and keep automatic retries bounded.

## P0 endpoint inventory

All shapes below use the exported schemas in [contracts.ts](contracts.ts). The owner column is the implementation/contract handoff, not a claim that the route already exists.

| Owner | Method and path | Access / request | Success |
|---|---|---|---|
| C | `GET /health` | Public | `200 {ok,release}`; no infrastructure details |
| B | `POST /me/bootstrap` | Auth; `{}` | `200 BootstrapReceipt` |
| B | `GET /reports` | Public/optional auth; `cityId=heilbronn`, optional bbox, route filters, resolved/needs-verification filters, cursor and limit | `200 ReportList`; maximum 100 items |
| B | `GET /reports/:id` | Public/optional auth; UUID path | `200 ReportDetail`; no viewer data for guests |
| C | `POST /uploads` | Auth; `UploadRequest` | `201 UploadTicket` |
| C | `PUT /uploads/:id/content?ticket=…` | Auth plus scoped ticket; bounded binary JPEG body | `200 UploadResult` |
| C | `GET /photos/:id/content?token=…` | Scoped read capability; owner auth for unattached evidence | JPEG bytes, only for a published photo or its owner |
| C | `POST /ai/analyze-report` | Auth + key; `ReportAnalysisRequest` | `200 READY` or `202 RUNNING` using `ReportAnalysis` |
| C | `GET /ai/analyses/:id` | Analysis owner | `200 ReportAnalysis` or `CleanupAnalysis` |
| B | `POST /reports` | Auth + key; `PublishRequest` | `201 PublicationReceipt` |
| B | `POST /reports/:id/votes` | Auth + key; `VoteRequest` | `200 VoteReceipt` |
| C | `POST /ai/analyze-cleanup` | Auth + key; `CleanupAnalysisRequest` | `200 READY` or `202 RUNNING` using `CleanupAnalysis` |
| B | `POST /reports/:id/cleanups` | Auth + key; `CleanupRequest` | `201 CleanupReceipt`; 40 RP is provisional only |
| B | `GET /me/impact` | Auth; owner-only | `200 Impact` |
| B | `GET /me/notifications` | Auth; owner-only; optional `locale=en|de` (default `en`) and cursor | `200 NotificationList`; maximum 100 items |
| B | `PATCH /me/notifications/:id` | Auth; `{read:true}` | `200 NotificationReadReceipt`; idempotent |

Notification text is projected from its stored kind in the requested interface locale; the database message is not rewritten when the resident switches languages. The cursor orders by immutable creation time and UUID, and a read acknowledgment only updates the authenticated resident's notification. Missing and other residents' notification IDs return the same `404 NOT_FOUND` response.

Conditional Yellow, Red and rewards routes are outside this P0 API candidate. They must not use the Green cleanup route to bypass their own verification rules.

## Error status and recovery map

`API_ERROR_POLICY` in `contracts.ts` is the machine-checked mapping. A retry marked `true` requires the named recovery below; errors do not imply that the same request body can be resent unchanged.

| HTTP | Codes | `retryable` | Recovery / meaning |
|---:|---|:---:|---|
| 400 | `INVALID_INPUT` | false | Correct the request; no mutation occurred. |
| 401 | `UNAUTHENTICATED` | false | Complete or refresh sign-in, then start the protected action. |
| 403 | `SELF_VOTE` (false), `NOT_ELIGIBLE` (false), `TOO_FAR` (true), `FORBIDDEN` (false) | See each code | `TOO_FAR` is retryable after obtaining a fresh eligible fix; the others are not. No vote/award is made. |
| 404 | `NOT_FOUND` | false | Resource is absent or not visible to this caller. |
| 409 | `ALREADY_VOTED`, `STAGE_CLOSED`, `IDEMPOTENCY_CONFLICT`, `ANALYSIS_CONSUMED`, `CLEANUP_ALREADY_SUBMITTED`, `INSUFFICIENT_RP`, `PRICE_CHANGED` | false | Resolve the state conflict; do not mint a new operation to repeat the rejected effect. An identical accepted operation still replays before new-action checks. |
| 410 | `EXPIRED` | true | Refresh an expired read/upload capability or explicitly start a fresh analysis; never publish/submit with an expired result. |
| 413 | `PHOTO_TOO_LARGE` | false | Capture/prepare evidence within the byte limit. |
| 415 | `UNSUPPORTED_MEDIA` | false | Capture supported JPEG evidence. |
| 422 | `LOCATION_INACCURATE`, `LOCATION_STALE`, `PIN_TOO_FAR`, `AI_UNCERTAIN`, `AI_REJECTED` | true | Reacquire/fix location or recapture/review evidence, then submit a new request as applicable. The server does not silently relax bounds or route a retake. |
| 429 | `RATE_LIMITED` | true | Wait for `Retry-After` when supplied, then resume with bounded retry behavior. |
| 500 | `INTERNAL_ERROR` | false | Safe generic failure; preserve the request ID for diagnosis. |
| 502 | `AI_INVALID_OUTPUT` | true | Provider output failed validation; retain photos and explicitly retry analysis. |
| 503 | `AI_UNAVAILABLE`, `DATABASE_UNAVAILABLE`, `UNAVAILABLE` | true | Dependency/runtime unavailable; retain user evidence and retry the same keyed operation only when its outcome is uncertain. |
| 504 | `AI_TIMEOUT` | true | Poll the existing analysis or retry its original key; a fresh attempt gets a new key after the old attempt fails/expires. |

`LOCATION_INACCURATE` is explicitly retryable in the existing plan example. `retryable` for location/AI recovery codes means an action can continue after correction or new evidence, not that the previous operation succeeded. All failed mutations create no vote, reward, cleanup candidate or publication. For an accepted idempotent replay, return `rpAwarded:0` and current canonical report/account snapshots.

## Upload and cleanup evidence protocol

1. Capture 1–5 JPEGs in the client camera flow. A cleanup capture obtains a new location fix for that cleanup session; it cannot reuse the report's earlier fix. The client submits metadata, not raw bytes, to `POST /uploads`.
2. C validates the authenticated owner, purpose, target report, ordinal, declared MIME/size and quota, then reserves an opaque photo ID/object key and returns a scoped HTTPS ticket. The selected ticket lifetime is five minutes and the maximum file size is 1 MiB. A cleanup target must be an eligible verified GREEN report; starting camera capture itself creates no reservation or cleaner claim.
3. The client `PUT`s the JPEG bytes to the Worker content route with the ticket. C enforces the streaming byte limit, actual JPEG signature/decode and dimensions, owner/purpose/target binding, ticket expiry and no overwrite. Successful upload returns `{photoId,state:"UPLOADED"}`. Raw objects remain private in R2; SQL and public DTOs use opaque IDs, and no bucket listing/public object URL is exposed.
4. Report analysis binds the measured report location and pin; the pin may move at most 3m. Cleanup analysis binds the newly measured location, after-photo IDs and immutable before-evidence hash. A new cleanup fix must be at most 60 seconds old, have reported accuracy ≤50m and be within measured 150m of the report point. These bounds are engineering checks, not proof of physical presence. The precise cleanup fix/audit stays private and is never returned in public report DTOs.
5. B consumes only an owned, unexpired READY+ACCEPT analysis in the same database transaction that attaches its complete evidence. The first valid cleanup submission wins; it creates the sole `AWAITING_VERIFICATION` candidate with provisional 40 RP and no balance credit. Loser evidence remains unattached and expires or is discarded. Three eligible resolution YES votes later grant the cleaner 40 RP; there is no replacement submission or early payment.

## Internal router, transaction and evidence boundaries

- **Router:** C mounts B's `createDomainRoutes` under `/api` beside C's evidence routes. B owns the domain endpoint contracts/handlers; C owns the Worker entry point, environment/context types, middleware and route mounting. Unimplemented routes return the standard safe JSON error, never synthetic success.
- **Transaction:** B exposes one checked-out PostgreSQL client through a `withTransaction(work)` facade. The callback receives that same transaction client for every query/Drizzle operation; helpers do not open a pool connection or start a nested transaction. B owns report locks, idempotency, semantic unique constraints, ledger entries, report/account versions and atomic lifecycle effects.
- **Evidence producer/store:** C owns authenticated upload/read, private R2, analysis execution/leases and `db/evidence-store.ts`. It validates owner, purpose/target, expiry, image bytes and accepted result, and provides only stable photo/analysis IDs plus bounded DTOs to B. Model calls and object transfer stay outside SQL transactions.
- **Report context:** B provides C the narrow `ReportContext` `{reportId,route,status,beforePhotoIds,beforeEvidenceHash,reportLocation,description}`. C binds cleanup analysis to that immutable before-evidence hash and the new measured cleanup location; support votes may change report `version` without invalidating that evidence. Private GPS, viewer permissions, balances and voter identities are excluded.
- **Trust boundary:** client permission flags are UX hints. Every mutation rechecks authenticated UID, ownership/roles, current lifecycle, location and evidence under the authoritative server/transaction boundary.

## Vote stages and RP accounting

`currentStage` identifies the primary UI focus; it is not the only open purpose. An unresolved report in `AWAITING_RESOLUTION` exposes `openVoteStages:["EXISTENCE","RESOLUTION"]`. Each `VoteRequest` names exactly one stage and uses its own key/semantic uniqueness `(reportId,stage,userId)`. The same resident may vote once at each stage if independently eligible; reporter/cleaner exclusions and prior-vote checks are stage-specific. Existence YES support remains uncapped until the report is `RESOLVED`; resolution YES remains bounded at 3.

POST /api/reports/{id}/votes requires Firebase authentication, a UUID Idempotency-Key and a strict {stage,choice,location} body. A genuinely new vote is admitted only when its measured fix is at most 60 seconds old, reports accuracy of at most 50m and is at most 150m from the report pin. These client measurements are eligibility inputs, not proof of exact physical position. The report row is locked before checking stage/self eligibility or recording the vote. Reporter existence votes and cleaner resolution votes are rejected; resolution votes are accepted only during AWAITING_RESOLUTION. An eligible resident may participate once in each stage.

An accepted same-key retry replays its stored vote before rechecking freshness or stage closure and returns rpAwarded: 0 with current balance/report snapshots. A different key for an already accepted identical stage choice is also a zero-RP semantic replay; a different choice returns ALREADY_VOTED, and changing a request under its original key returns IDEMPOTENCY_CONFLICT. Every newly accepted YES or NO adds one vote and one +5 VOTE ledger entry; only YES advances its stage count. The third existence YES confirms the report once and creates one quiet in-app notification while existence support remains open. The third resolution YES verifies the pending cleanup, resolves the report, credits +15 to the reporter and +40 to the cleaner with separate ledger references, and creates one author notification. Vote, counts, lifecycle, notifications, ledger and account versions commit together; an unexpected failure rolls all of them back. If the media resolver is unavailable, the endpoint returns UNAVAILABLE before mutation.

### Report publication

`POST /reports` accepts only `{analysisId,description}` and a UUID `Idempotency-Key`. The description is the resident's final factual edit and must contain a non-whitespace character. The server rejects client-supplied route, photo IDs, location, status, reward or balance fields. Publication reads the route and original AI description from the stored schema-validated analysis, and reads ordered IDs from `ai_analyses.photo_ids` plus `{comment,measuredLocation,pin,cityId,outputLocale}` from `ai_analyses.context` validated by `ReportAnalysisContextSchema`; it never trusts replacement values from the publication request.

The server requires an owner-bound, current, unexpired `READY+ACCEPT` report analysis and one to five complete, owned, uploaded, unexpired report photos in their stored order. It attaches those photos, creates one `AWAITING_EXISTENCE` report with reporter total 20 RP, writes exactly one `REPORT_INITIAL` ledger entry for +5 RP, updates the account balance/version and consumes the analysis in one PostgreSQL transaction. Photo count does not change the reward. The remaining 15 RP is pending until the report is resolved. A `RETAKE`, failed/running, expired, superseded, consumed, unowned or tampered analysis cannot create a report, attach media or award points.

The first receipt projects the report state captured in the publication transaction, so an existence vote that commits before response serialization cannot make the already-committed publication receipt invalid. An identical retry with the same key returns the canonical report and current account snapshot with `rpAwarded:0`; a changed body with that key returns `IDEMPOTENCY_CONFLICT`. Reusing a consumed analysis under a different key returns `ANALYSIS_CONSUMED`. If the C photo-capability resolver is not injected, the endpoint returns `UNAVAILABLE` before the publication transaction begins. The root Worker currently does not inject the product database or media resolver, so this candidate does not claim a live publication route.

### Report reads

- `GET /api/reports` defaults to `cityId=heilbronn`, `limit=50`, `needsVerification=false` and `resolved=false`. Optional filters are `bbox=west,south,east,north`, `routes=GREEN,YELLOW,RED` (one or more comma-separated routes), `needsVerification=true|false`, `resolved=true|false`, `limit=1..100` and the `cursor` returned by the previous page. Unknown or duplicate query parameters and unsupported cities return `INVALID_INPUT`. Bounding boxes apply to ordinary map queries and are validated; `needsVerification=true` ignores the viewport bounds and queries the selected citywide route set.
- `needsVerification=true` returns citywide reports whose current threshold is still pending: `AWAITING_EXISTENCE` or `AWAITING_RESOLUTION`. For authenticated viewers it excludes self-votes and a prior vote only at that pending stage, so a prior existence vote does not hide a newly opened resolution stage. A `VERIFIED` report is not mislabeled as awaiting its initial three confirmations, while its unresolved existence-support stage remains available in detail and ordinary list results.
- `GET /api/reports/{id}` is public with optional Firebase authentication. The public projection includes support counts/timestamps and allowlisted author/cleaner identities. An authenticated projection adds stage-specific `canVote`/`hasVoted` hints and cleanup permission; it never includes vote choices or balances. Services must re-check permission and location inside the authoritative mutation transaction.
- Detail photo URLs are supplied through C's `ReportMediaResolver` boundary from attached photo IDs only. A capability must be HTTPS, scoped, and unexpired; no object key or listing is part of the response. If runtime media resolution is not injected, detail returns `UNAVAILABLE` rather than fabricating a URL.
- C reads cleanup analysis context through `ReportContextReader`; its PostgreSQL implementation returns only verified GREEN reports and hashes the ordered immutable photo IDs/content digests. Private measured locations and voter identities are not returned.

| Ledger category | Credit condition | Amount | Impact treatment |
|---|---|---:|---|
| `REPORT_INITIAL` | First committed publication | +5 | Reporter earned; 15 remains pending toward that report's 20 total |
| `REPORT_FINAL` | Third eligible resolution YES | +15 | Reporter earned; completes the 20 report total |
| `CLEANUP` | Third eligible resolution YES | +40 | Accepted cleaner earned; candidate's 40 is pending before this |
| `VOTE` | Each new accepted YES or NO in either open stage | +5 | Verifier earned; accepted vote count counts both choices |

Role earnings are separate from signed spendable balance and pending RP. `Impact.totals.earnedRp` is the sum of positive category credits; `Impact.totals.balanceRp` is the current ledger balance and may differ (including a future negative balance); pending reporter/cleaner amounts are not earned or credited. A reporter who also cleans keeps both role credits and one de-duplicated report-history item. A replay pays zero and returns the current balance/version, not the historical response balance.

The validating examples in [p0.json](../../tests/fixtures/contracts/p0.json) include independent requests for both vote stages, READY/ACCEPT versus READY/RETAKE versus RUNNING/FAILED analysis states, and separate earned, pending and balance values. They are synthetic `DEMO` fixtures only.

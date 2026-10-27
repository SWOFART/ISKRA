# Proposal

## Why

ISKRA needs a deployed, demonstrable path from a resident's photo to independently verified cleanup and accurate personal impact. The repository currently contains planning and an infrastructure health-check Worker; this change translates `plan.md` into reviewable behavior and three asynchronous implementation streams within a 48-hour timebox.

## What Changes

- **P0:** Deliver the real Green vertical slice: login → map → 1–5 camera photos → all-photo Gemini analysis → publication and 5 reporter RP → three eligible existence YES votes → after-photo analysis with a new location fix → three eligible resolution YES votes → resolved, remaining 15 reporter RP and 40 cleaner RP → My Impact. The 20 reporter RP are per report, independent of photo count.
- **P0:** Provide the three-tab mobile shell in English/German for Heilbronn, guest map, controlled photo access, separate reporter/cleaner statistics and verification earnings, in-app notifications and immediate RED hazard guidance.
- **P0:** Keep existence voting available to new eligible residents until RESOLVED, including after existence is confirmed at three YES. Each new accepted YES/NO still earns +5; threshold effects occur once. Resolution voting closes at three YES. The same eligible residents can participate once in each stage.
- **P0:** Distinguish schema-valid ACCEPT with a route from RETAKE without a route, and both from technical analysis failure. The first valid cleanup submission establishes the pending cleaner candidate; the 40 RP are paid only after independent resolution verification.
- **P0:** Enforce server identity, ownership, immutable classification, atomic state/ledger transitions, replay protection and private/public projections. Demonstrate real integrations separately from visibly labeled sandbox acceleration.
- **P1, conditional on M3 and capacity:** Rich My Impact, verified Yellow mission create/display/join/update, personal Red draft/copy/sent declaration, and atomic demo Rewards. These remain conditional work, not P0 acceptance requirements. A cut requires an explicit recorded scope decision and coherent artifact update; an omitted feature is never marked implemented.
- **P2, deferred:** Public profiles/settings/achievements, Yellow attendance/results/equal attendee payouts, web push and broader hardening. Preserve their boundaries and prerequisites without putting them on the Green critical path.
- Establish one owner per shared file, frozen contract v1, bounded handoffs and integration evidence for Person A (client), B (domain/SQL/contracts), C (platform/media/AI/acceptance harness).

`plan.md` remains the unchanged historical baseline. The user's subsequent 2026-10-27 decisions and confirmed follow-up take precedence where they refine that baseline: reporter 20 (5+15), cleaner 40, continued existence voting, new cleanup GPS, first accepted cleanup candidate, separate role/earning statistics, ACCEPT/RETAKE behavior, English/German and Heilbronn. Under the user's delegated technical choice, use private R2 and an initial measured proximity limit of 150m with accuracy ≤50m and location age ≤60s; validate these engineering settings on real devices. Remaining OPEN/runtime gates are recorded in `design.md`. The setup stop point is superseded for planning/team assignment only; no implementation is authorized in this operation.

## Capabilities

### New Capabilities

- `resident-identity`: Firebase identity, neutral public identity and protected/private API access.
- `city-report-map`: Guest discovery, three tabs, route/status filters, report sheets and navigation.
- `camera-evidence`: Camera-only capture, bounded location adjustment and owner-controlled media lifecycle.
- `report-analysis`: Real all-photo report/cleanup analysis, trusted results and conservative failures.
- `green-report-lifecycle`: Publication, immutable evidence, no-reservation cleanup and truthful lifecycle.
- `verification-ledger`: Independent stage voting, atomic RP/notifications and replay/concurrency behavior.
- `personal-impact`: Real multi-role activity, balances, in-app messages and optional richer presentation.
- `yellow-missions`: Conditional P1 mission creation/join/update and exclusion of unimplemented P2 payout flows.
- `red-assistance`: P0 urgent guidance and conditional P1 personal draft/sent declaration.
- `demo-rewards`: Conditional P1 catalog, confirmed atomic debit and explicitly demo vouchers.
- `delivery-operations`: Cloud deployment, release/security gates, isolated demo tooling and honest fallbacks.

### Modified Capabilities

None. The existing main-spec inventory is empty.

## Impact

Future implementation creates the product `src/client`, `src/worker`, `src/shared`, root package/config files, migrations and application tests. It extends existing `.github/workflows/{checks,cloudflare}.yml` and `infra/runbook.md` while preserving the separate `infra/deployment-check` service. Dependencies remain React/Vite/Hono/Workers, PostgreSQL through Hyperdrive, Firebase, Gemini, MapLibre/MapTiler and selected private R2. Continued existence votes require uncapped existence counts, per-stage admission data and a last-confirmation timestamp; cleanup analysis binds a newly measured location. Role/category earnings are separate from spendable balance.

Source review read all 788 lines of root `plan.md`, README/runbook, workflows and the check Worker files. The original `GREEN_CITY_CODEX_PROMPT_CREATE_PLAN_2026-10-27_EN.md` and optional context Markdown were not found locally. During reconciliation, the connected Miro board's v2.0 document was read and all four concept-image previews inspected; older RP/route/gallery examples do not override newer user decisions. GPS/R2 primary documentation informed the delegated choices; account/model/network access remains unverified. See `design.md` for source links, remaining gates and three-owner contracts.

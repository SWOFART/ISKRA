## Purpose

Keep deployment, acceptance evidence and hackathon demonstrations reproducible, isolated and truthful about working product capabilities.

## ADDED Requirements

### Requirement: Cloud-hosted release identity
The product SHALL run over HTTPS on the final custom domain without a developer laptop. Health SHALL identify the deployed release. Direct SPA routes SHALL work, while unknown API routes SHALL return JSON errors.

#### Scenario: Infrastructure check is not the app
- **WHEN** the existing deployment-check health endpoint is healthy
- **THEN** it does not satisfy product deployment or Green acceptance
- **AND** product smoke must verify the application origin and expected commit SHA

### Requirement: Safe isolated environments
Dev/demo and production SHALL isolate identity, database permissions, photo access and secrets. Live deployment SHALL require approved account/budget/resource selections. Unsafe database connectivity SHALL block release rather than relax authentication, TLS or firewall policy.

#### Scenario: Network prerequisites fail
- **WHEN** database access works only with public all-IP ingress or unverified TLS
- **THEN** integration/release is blocked and the selected stack is not silently replaced

### Requirement: Deliberate deployment and migration gates
CI SHALL check the actual application and real-database invariants before data-changing releases. Staging SHALL deploy from develop and production manually from main through the existing single pipeline. Migrations SHALL be reviewed and shall not run destructively on application startup.

#### Scenario: Missing application integration checks
- **WHEN** only repository/check-Worker checks pass
- **THEN** the release cannot claim the product's database, auth, AI or end-to-end acceptance has passed

#### Scenario: Rollback preserves ledger
- **WHEN** an application release must be rolled back
- **THEN** the compatible prior Worker can be restored without erasing the ledger, and any database restore uses a separate verified target and controlled binding switch

### Requirement: Real Green release gate
Release acceptance SHALL demonstrate real login, camera/location including a new cleanup fix, private uploads, all-photo Gemini, publication, both vote stages, continued existence votes, role credits 5+15/40, notifications and real role/category Impact. It SHALL include English/German flows, self-cleaning, retry/race/security checks and real Android Chrome/iOS Safari testing.

#### Scenario: Fixtures only
- **WHEN** the app can show only seeded or recorded Green states
- **THEN** Green release acceptance remains incomplete even if the presentation looks successful

#### Scenario: Approved policy regression
- **WHEN** the deployed product rejects a fourth eligible existence vote before resolution, pays 20 RP per photo, pays cleanup immediately after AI or reuses the report's GPS for cleanup
- **THEN** the P0 release gate fails even if the basic three-vote happy path succeeds

### Requirement: Visible sandbox provenance
Synthetic reports, accounts, votes and recorded model results SHALL be visibly labeled in an isolated sandbox. Accelerated votes SHALL use trusted operator tooling and the same transactional domain service, with no public bypass endpoint, header or query parameter.

#### Scenario: Demonstrate verification
- **WHEN** each stage is presented with one genuine nearby test vote and two accelerated votes
- **THEN** the accelerated portion is explicitly announced and persistently marked
- **AND** a separate genuine protocol test uses three distinct authenticated eligible residents

### Requirement: Guarded reset and honest fallback
Reset tooling SHALL refuse production and non-demo targets, delete only known sandbox data/objects and verify invariants after reseeding through valid ledger operations. Outage fallbacks SHALL disclose recorded AI, simulated location or prerecorded presentation.

#### Scenario: Reset scope mismatch
- **WHEN** environment identity, database marker or report provenance is not the expected demo scope
- **THEN** reset/acceleration refuses to mutate data

#### Scenario: Live service unavailable
- **WHEN** AI, GPS, camera or internet is unavailable during presentation
- **THEN** retry, a tested device/outdoor station or a labeled recording/fixture is used without claiming live acceptance

### Requirement: Timebox preserves priority and hard rules
The 48-hour schedule SHALL be treated as a target timebox. P1 SHALL start only after real Green M3 and a capacity decision; P2 SHALL remain deferred. Cuts SHALL not weaken identity, transactions, privacy, camera-only capture, safety, three-YES verification or honest demo labeling.

#### Scenario: Missed Green checkpoint
- **WHEN** publication/existence is incomplete at H18 or Green is incomplete at H28
- **THEN** optional P1/P2 work is cut or stays unstarted and remaining capacity focuses on P0
- **AND** H36 freezes new features, with accurate disclosure of incomplete integrations at H48

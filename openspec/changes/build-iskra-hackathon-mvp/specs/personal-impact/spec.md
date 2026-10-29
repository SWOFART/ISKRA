## Purpose

Show residents the actual outcome and status of their participation without confusing activity, RP and an undefined Impact Score.

## ADDED Requirements

### Requirement: Real minimal Impact
P0 My Impact SHALL show created reports, submitted/verified cleanups, confirmed reports and real RP earned by reporting, cleaning and verification. Reporter and cleaner statistics SHALL be separate. History SHALL retain all applicable roles while grouping each report once. Sample-only activity SHALL not satisfy real Green completion.

#### Scenario: Multi-role report
- **WHEN** a resident authored, cleaned and/or voted on the same report
- **THEN** all applicable roles remain available in the response
- **AND** one history row retains all applicable roles, while independent reporter and cleaner counters each include their role's participation

#### Scenario: Vote is complete but report is pending
- **WHEN** an accepted verification action belongs to a still-pending report
- **THEN** activity labels distinguish the completed vote from unresolved report/cleanup status

### Requirement: Separate role and verification statistics
Reporter statistics SHALL show created reports, their lifecycle counts and reporter RP. Cleaner statistics SHALL show submitted, pending and verified cleanups with cleaner RP. Verification activity SHALL show accepted votes, distinct reports receiving the resident's accepted YES and verification RP, without exposing other residents' choices.

#### Scenario: Same resident reports and cleans
- **WHEN** one resident publishes a report and later verifies their own cleanup through other residents
- **THEN** reporter statistics show one created report and 20 earned RP, cleaner statistics show one verified cleanup and 40 earned RP, and the combined earned amount is 60 RP
- **AND** the role totals remain separate even though history has one report row

#### Scenario: Two stage votes for one report
- **WHEN** an eligible resident casts accepted YES votes at both stages of the same report
- **THEN** verification shows two accepted votes, one distinct confirmed report and 10 earned RP
- **AND** an accepted NO earns 5 verification RP without being counted as the resident's YES confirmation

### Requirement: Earned RP differs from balance
Earned RP by category SHALL derive from completed positive ledger credits, while pending awards SHALL be displayed separately. Spendable balance SHALL include debits. Redeeming a reward SHALL not erase historical role earnings.

#### Scenario: Pending cleanup and later redemption
- **WHEN** a resident has 40 pending cleaner RP
- **THEN** those points are absent from earned totals and spendable balance until independent verification
- **AND** a later demo purchase reduces balance without reducing historical reporting/cleaning/verification earnings

### Requirement: Impact Score remains unconfigured
Until an Impact Score formula is separately approved, real API data SHALL expose a null score with NOT_CONFIGURED state, and UI SHALL show Not configured or an em dash. RP SHALL not be relabeled or converted into Impact Score.

#### Scenario: Account has RP but no score policy
- **WHEN** a resident has earned RP
- **THEN** their balance is real and visible while Impact Score remains unconfigured
- **AND** any sample score is persistently labeled as a demo fixture

### Requirement: Canonical activity after mutation
Publication, accepted vote, accepted cleanup and resolution SHALL refresh Impact, balance, map and details from committed data without allowing older responses to regress state.

#### Scenario: Resolution updates all views
- **WHEN** the third resolution YES commits
- **THEN** actor balances, report state and My Impact agree immediately after the response/refetch
- **AND** a delayed prior fetch cannot replace them with older values

### Requirement: Quiet in-app notifications
Existence confirmation SHALL create one quiet author notification. Resolution SHALL create one author message "Your city is cleaner thanks to you!" or its German equivalent. Residents SHALL read and idempotently mark their own notifications as read; the message meaning SHALL be preserved across locale changes.

#### Scenario: Transition replay
- **WHEN** a completed stage response is retried
- **THEN** no duplicate message is created
- **AND** no per-vote, RP or badge push notification is generated

### Requirement: Conditional richer Impact presentation
If admitted at the M3 scope gate, P1 SHALL add In progress/Completed tabs, compact rows and stable last-relevant-update ordering while preserving report navigation and Back position.

#### Scenario: Rich view admitted or cut
- **WHEN** P1 rich Impact is admitted
- **THEN** rows use report-lifecycle grouping with a stable ID tie-break, retain the separate role statistics and restore tab/scroll on Back
- **AND** if it is deferred, the real minimal P0 view remains usable without claiming the rich view is implemented

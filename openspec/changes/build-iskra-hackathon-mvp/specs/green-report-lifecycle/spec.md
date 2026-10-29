## Purpose

Maintain truthful report publication and cleanup states, with immutable evidence and independent confirmation before a cleanup becomes resolved.

## ADDED Requirements

### Requirement: Atomic publication from accepted analysis
Publication SHALL consume an owned accepted analysis, attach its 1–5 complete photos, create AWAITING_EXISTENCE and credit 5 RP once toward a snapshotted reporter total of 20 RP. This award SHALL be per report, not per photo. Invalid publication SHALL leave no partial report, photo attachment or credit.

#### Scenario: Successful publication
- **WHEN** a resident publishes a valid accepted analysis
- **THEN** the response contains the committed report, balance and initial RP
- **AND** the UI shows "You've started making your city better!" or its German equivalent with 5 credited and 15 pending out of 20 RP, then returns to a highlighted marker with the sheet closed

#### Scenario: Replayed publication
- **WHEN** the response is lost and the same operation is retried
- **THEN** the same report is returned without another initial credit

#### Scenario: Five photos still form one report
- **WHEN** one accepted report contains five photos rather than one
- **THEN** the reporter still earns 5 initial RP and 15 pending RP, not five report rewards

### Requirement: Immutable published facts
After publication, author, route, evidence, location, measured-fix audit and reward snapshots SHALL be immutable. Description edits SHALL be limited to the final pre-publication preview in this MVP.

#### Scenario: Client changes classification
- **WHEN** a client attempts to publish its own route, reward, status or replacement evidence
- **THEN** the mutation is rejected and only the stored validated analysis can establish those facts

### Requirement: Verification governs lifecycle
A report SHALL move from AWAITING_EXISTENCE to VERIFIED only through three eligible existence YES votes. A verified GREEN report SHALL move to AWAITING_RESOLUTION only after accepted cleanup evidence, and to RESOLVED only through three eligible resolution YES votes.

#### Scenario: NO or delay does not resolve
- **WHEN** a pending stage has NO votes, insufficient YES votes or no further activity
- **THEN** its actual pending state/counts remain visible with no timeout resolution or automatic fraud penalty

### Requirement: Cleanup intent is not reservation
An authenticated resident, including the reporter, SHALL be able to start cleanup locally for verified GREEN without creating an assignment, reservation or reward claim. The result-photo action SHALL appear in the same report sheet.

#### Scenario: Two residents start locally
- **WHEN** two residents tap "I'll clean it up!"
- **THEN** both can capture locally and neither receives a reservation or guaranteed award
- **AND** the first valid AI-accepted submission accepted by the server establishes the sole pending cleaner candidate

#### Scenario: Concurrent valid submissions
- **WHEN** two valid cleanup submissions race
- **THEN** exactly one becomes the accepted candidate and the other returns CLEANUP_ALREADY_SUBMITTED without attaching its evidence or awarding RP
- **AND** the losing candidate can discard their local preview; unattached uploads expire under housekeeping without becoming an automatic draft

### Requirement: Accepted cleanup awaits independent verification
Cleanup submission SHALL validate owned accepted analysis and newly captured location against a verified GREEN target and attach 1–5 after photos atomically. It SHALL create pending verification with 40 provisional RP and zero cleaner credit before three eligible resolution YES votes. No replacement submission SHALL be accepted in this MVP.

#### Scenario: Accepted after evidence
- **WHEN** an eligible cleaner submits accepted evidence
- **THEN** the report becomes AWAITING_RESOLUTION at 0/3
- **AND** a separate screen shows "Thank you! You've helped make the city cleaner!" or its German equivalent, pending 40 RP and a button to general My Impact

#### Scenario: Cross-route cleanup attempt
- **WHEN** the Green cleanup endpoint receives a YELLOW or RED report
- **THEN** it rejects the submission rather than bypassing unimplemented route-specific workflows

### Requirement: Distinct actor roles
The product SHALL preserve reporter and cleaner roles even when the same resident fills both. Independent verification eligibility SHALL use the role relevant to the current stage.

#### Scenario: Reporter also cleans
- **WHEN** a reporter submits their own accepted cleanup
- **THEN** both roles remain visible, separate role awards remain due on resolution and that person cannot verify either of their own stages

#### Scenario: Final awards for self-cleaning
- **WHEN** the third eligible resolution YES verifies a reporter's own cleanup
- **THEN** the account has earned 20 reporter RP and 40 cleaner RP through distinct role ledger entries, excluding any unrelated earnings

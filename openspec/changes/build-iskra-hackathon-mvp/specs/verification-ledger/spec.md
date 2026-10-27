## Purpose

Make independent verification and every RP movement consistent under retries, simultaneous requests and process failures.

## ADDED Requirements

### Requirement: Eligible stage-specific voting
New voting SHALL require authentication, an admitting stage, location age ≤60 seconds, reported accuracy ≤50m and measured distance ≤150m from the report pin. Existence SHALL exclude the reporter; resolution SHALL exclude the cleaner. One resident SHALL have at most one immutable choice per report/stage.

#### Scenario: Role independence
- **WHEN** a reporter votes on their existence stage, a cleaner votes on their resolution stage or a guest votes
- **THEN** no vote or RP is created
- **AND** a nearby reporter can verify a different cleaner's resolution if otherwise eligible

#### Scenario: Repeat-stage verifier policy
- **WHEN** the same resident attempts to participate at both stages
- **THEN** the same resident can vote once in each stage if independently eligible for each

#### Scenario: Measured proximity boundary
- **WHEN** a new vote is measured at 150m with accuracy 50m and age 60 seconds
- **THEN** it passes those numeric limits, while exceeding any limit is rejected
- **AND** those measurements are not presented as proof of exact physical position

### Requirement: Three YES rather than majority
Existence SHALL become confirmed on the third distinct eligible YES, while resolution SHALL complete on its third distinct eligible YES. Each newly accepted YES or NO SHALL credit the voter exactly +5 RP. NO SHALL neither increment YES progress nor reverse previous credits.

#### Scenario: Two YES and one NO
- **WHEN** three distinct eligible residents cast YES, YES and NO
- **THEN** YES progress is 2/3, the stage stays pending and each resident receives +5 once
- **AND** a later eligible YES reaches the confirmation threshold at 3/3 without closing existence voting

### Requirement: Continued existence voting
Existence votes SHALL remain admissible from publication until RESOLVED, including VERIFIED and AWAITING_RESOLUTION. New residents SHALL still receive +5 per accepted YES/NO. Existence YES totals SHALL not be capped at three; further YES votes SHALL update the latest confirmation time without repeating threshold effects.

#### Scenario: Fourth existence confirmation
- **WHEN** a new eligible resident casts YES after existence is confirmed but before resolution
- **THEN** the YES total increases from 3 to 4, the voter earns +5, threshold progress stays 3/3 and the last-confirmation timestamp advances
- **AND** no repeated reporter credit, lifecycle transition or existence notification occurs

#### Scenario: Both stages available during cleanup verification
- **WHEN** a report is AWAITING_RESOLUTION
- **THEN** a new eligible resident can cast an existence vote or a resolution vote under that stage's own permissions
- **AND** a prior existence vote does not prevent an otherwise eligible resolution vote

#### Scenario: New vote after resolution
- **WHEN** a new existence or resolution vote arrives after RESOLVED
- **THEN** it is rejected as STAGE_CLOSED with no credit, while previously accepted identical operations still replay safely

### Requirement: Replays do not repay
An identical accepted vote replay SHALL return its recorded vote with zero newly awarded RP, including after closure or expiry of its original location fix. A changed choice SHALL conflict. Idempotency keys SHALL bind actor, operation and request contents; fresh-location admission SHALL apply to new votes only.

#### Scenario: Different keys same resident
- **WHEN** one resident concurrently submits the same stage choice using different keys
- **THEN** exactly one vote and one +5 ledger credit exist

#### Scenario: Changed payload under one key
- **WHEN** the same operation key is reused for different content
- **THEN** it conflicts without a second vote, publication, cleanup or payment

#### Scenario: Replay with original old location
- **WHEN** an authenticated resident retries their accepted vote using the original payload more than 60 seconds later
- **THEN** the accepted vote is replayed with zero new RP before any new-vote location-freshness check

### Requirement: Stage transitions and role awards are atomic
The third existence YES SHALL confirm existence and create one quiet author notification. The third resolution YES SHALL resolve report/cleanup, close further new votes, credit 15 final reporter RP and 40 cleaner RP exactly once, and create one author resolution notification.

#### Scenario: Separate and combined accounts
- **WHEN** resolution completes for a different cleaner or a reporter who also cleaned
- **THEN** reporter 5 initial plus 15 final equals the 20 RP total, cleaner receives 40 RP and every role award has its own ledger reference
- **AND** a shared account receives the sum once without losing either role

### Requirement: Concurrency and failure preserve invariants
Committed vote, count, ledger, balance, lifecycle and notification effects SHALL agree. A failed transition SHALL leave no partial effects. Cached or replayed receipts SHALL not overwrite current report versions or balances.

#### Scenario: Competing votes
- **WHEN** two distinct eligible YES requests race from count 1
- **THEN** count becomes 3 with two voter credits and one stage transition

#### Scenario: Existence threshold race
- **WHEN** two distinct eligible existence YES requests race from count 2 on an unresolved report
- **THEN** both are accepted, the total becomes 4 and each voter earns +5
- **AND** existence confirmation and its notification occur exactly once

#### Scenario: Resolution threshold race
- **WHEN** two distinct eligible resolution YES requests race from count 2
- **THEN** exactly one is accepted as the third YES with +5 and the other receives STAGE_CLOSED with no new vote/credit
- **AND** role payouts and the resolution notification occur once

#### Scenario: Lost response or ledger conflict
- **WHEN** a process fails before commit, a committed response is lost, or a ledger uniqueness conflict occurs
- **THEN** rollback or replay preserves a single consistent result without an extra credit

### Requirement: Ledger is the RP authority
RP SHALL be integer-valued, with append-only nonzero movements and unique semantic references. From a zero seed, balance SHALL equal the sum of the resident's ledger. A single NO SHALL not impose a penalty, and no arbitrary daily report-RP cap SHALL apply.

#### Scenario: Reconcile balance
- **WHEN** publication, voting, resolution or a demo redemption is reconciled
- **THEN** balances equal ledger sums and YES counters equal accepted YES rows
- **AND** no Impact Score conversion or unexplained seed balance is present

#### Scenario: Future reversal boundary
- **WHEN** a negative balance is represented for future conclusive adjudication
- **THEN** it is not clamped to zero and the MVP exposes no ad hoc reversal or moderation API

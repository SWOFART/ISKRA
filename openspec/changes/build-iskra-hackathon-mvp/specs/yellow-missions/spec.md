## Purpose

Define a bounded optional group-cleanup entry flow without implying that attendance, verified mission completion or Yellow awards already exist.

## ADDED Requirements

### Requirement: Conditional verified mission creation
For the user-authorized serialized B implementation lane recorded in `design.md`, P1 SHALL let an authenticated resident create one OPEN mission for a VERIFIED YELLOW report, with start time and independent meeting point, even while real Green M3 remains unverified. This implementation exception does not claim M3 acceptance, authorize deployment/public release, or enable P2 actions. Its creator SHALL be organizer and participant.

#### Scenario: Mission eligibility
- **WHEN** mission creation is attempted for an unverified report, a different route or a report with an existing mission
- **THEN** it is rejected without duplicate mission/participant records
- **AND** an eligible creation records the meeting point independently of the report pin

### Requirement: Open join and organizer update
If P1 Yellow is admitted, residents SHALL join OPEN missions without approval; repeated joins SHALL be safe. Public details SHALL show organizer, count and announcement without private email/roster disclosure. Only the organizer SHALL update bounded plain-text announcements.

#### Scenario: Join twice and update
- **WHEN** a resident joins twice and a nonorganizer attempts to change the announcement
- **THEN** one participation exists and the unauthorized update is denied

### Requirement: P1 does not imply P2 completion
P1 SHALL expose no working attendance, result verification or Yellow payout actions. Unimplemented later stages SHALL be deferred or visibly labeled fixtures. Yellow RP SHALL remain unset until an equal confirmed-attendee award is approved for P2.

#### Scenario: Attempted payout bypass
- **WHEN** a Yellow mission participant calls a Green cleanup/payout path
- **THEN** the request is rejected and no mission completion or reward is recorded

#### Scenario: Future attendance boundary
- **WHEN** P2 is proposed later
- **THEN** its plan must freeze organizer-confirmed attendance before verification, exclude all participants from resolution voting, and award confirmed attendees equally only after three eligible nonparticipant YES votes

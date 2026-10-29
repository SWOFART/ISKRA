## Purpose

Give immediate conservative hazard guidance and an optional resident-controlled complaint draft without claiming municipal receipt or resolution.

## ADDED Requirements

### Requirement: Immediate hazard guidance
P0 SHALL display do-not-handle hazard guidance on a RED assessment without waiting for existence votes or draft generation. Preliminary AI SHALL not certify that handling an issue is safe.

#### Scenario: Hazard before publication
- **WHEN** report analysis returns an accepted RED result with safety guidance
- **THEN** the resident sees that guidance immediately and is not encouraged to handle sharps, chemicals, unknown containers or dangerous locations

### Requirement: Conditional personal editable draft
Ordinary P1 admission remains conditional on M3 and explicit capacity admission. The user-authorized serialized B implementation lane recorded in design.md may implement this backend task while M3 remains unverified; this narrow exception does not claim release readiness or authorize deployment. P1 SHALL provide a resident-owned editable factual Red draft and copy data. Generation SHALL not invent facts, legal citations or contacts and SHALL not overwrite resident edits. A clearly identified English or German factual template can replace optional AI generation.

#### Scenario: Create, edit and revisit
- **WHEN** the report owner creates a draft, edits it and later revisits or repeats the create request
- **THEN** the saved plain text is returned unchanged until that owner explicitly edits it again

#### Scenario: Another resident requests the draft
- **WHEN** a different resident requests or edits a report owner's Red draft
- **THEN** the API returns the same not-found result as for an absent private draft and changes no data

### Requirement: Verified contacts only
Any contact shown in a draft SHALL come from a manually verified source with provenance; absent a verified contact, the response SHALL expose no contact rather than a generated address.

#### Scenario: No known authority contact
- **WHEN** the contact allowlist has no verified entry
- **THEN** the draft remains usable with an empty contact list and without invented contact details or sending claims

### Requirement: Sending is a personal declaration
For admitted P1 work, declaring sent SHALL record only an idempotent user-reported timestamp. It SHALL not send automatically, claim receipt or authority response, or change the report lifecycle, votes, verification or rewards.

#### Scenario: Repeated sent declaration
- **WHEN** a resident copies a draft and declares it sent twice
- **THEN** one personal timestamp is retained and the report's independent verification state is unchanged

## Purpose

Give immediate conservative hazard guidance and an optional resident-controlled complaint draft without claiming municipal receipt or resolution.

## ADDED Requirements

### Requirement: Immediate hazard guidance
P0 SHALL display do-not-handle hazard guidance on a RED assessment without waiting for existence votes or draft generation. Preliminary AI SHALL not certify that handling an issue is safe.

#### Scenario: Hazard before publication
- **WHEN** report analysis returns an accepted RED result with safety guidance
- **THEN** the resident sees that guidance immediately and is not encouraged to handle sharps, chemicals, unknown containers or dangerous locations

### Requirement: Conditional personal editable draft
If admitted after M3, P1 SHALL provide a resident-owned editable factual Red draft and copy action. Generation SHALL not invent facts, legal citations or contacts and SHALL not overwrite resident edits. A clearly identified template can replace optional AI generation.

#### Scenario: Edit and regenerate
- **WHEN** a resident edits a draft and later revisits it
- **THEN** their personal text is preserved and cannot be overwritten by another resident or silent model generation

### Requirement: Verified contacts only
Any contact shown in a draft SHALL come from a manually verified source with provenance; absent a verified contact, the response SHALL expose no contact rather than a generated address.

#### Scenario: No known authority contact
- **WHEN** the contact allowlist has no verified entry
- **THEN** the draft remains usable without invented contact details or sending claims

### Requirement: Sending is a personal declaration
If P1 is admitted, declaring sent SHALL record only an idempotent user-reported timestamp. It SHALL not send automatically, claim receipt or authority response, or change the report to RESOLVED or a separate SENT lifecycle status.

#### Scenario: Repeated sent declaration
- **WHEN** a resident copies a draft and declares it sent twice
- **THEN** one personal timestamp is retained and the report's independent verification state is unchanged

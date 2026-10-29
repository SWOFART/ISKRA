## Purpose

Collect bounded new photographic evidence and measured location while preventing unowned, expired or unpublished media disclosure.

## ADDED Requirements

### Requirement: Camera-only evidence
Initial and cleanup submissions SHALL use 1–5 newly captured camera photos, with preview, delete and retake. Camera streams SHALL stop on exit. The application SHALL not offer gallery upload or silently save a draft.

#### Scenario: Capture boundaries and exit
- **WHEN** a resident captures photos and attempts to continue or leave
- **THEN** zero or six photos cannot continue, one or five can, and leaving offers Continue creating or Discard and exit
- **AND** discarded media is not restored as an automatic draft

#### Scenario: Camera permission denied
- **WHEN** camera access is denied or unsupported
- **THEN** the UI explains HTTPS/permission recovery and offers retry or exit without a file-picker fallback

### Requirement: Measured location and bounded pin
Report capture SHALL obtain a new location fix, with a pin no farther than 3m from it. Location age SHALL be at most 60 seconds at analysis admission and reported accuracy at most 50m. The server SHALL validate finite coordinates, freshness and displacement independently; the 3m edit limit SHALL not be presented as GPS accuracy.

#### Scenario: Client bypass attempt
- **WHEN** the client submits a pin more than 3 m from its measured fix, nonfinite coordinates or an unacceptable stale/inaccurate fix
- **THEN** analysis is rejected and the UI requests a new valid fix rather than invented coordinates

#### Scenario: Location prompts have a purpose
- **WHEN** a user only views the map or evidence
- **THEN** no location is requested until report capture, cleanup-result capture, voting or explicit My location

### Requirement: New location for cleanup evidence
Cleanup-result capture SHALL obtain a new location fix rather than reuse the report's fix. Cleanup analysis SHALL require accuracy ≤50m, age ≤60 seconds and measured distance ≤150m from the report pin, and bind that location to the accepted evidence.

#### Scenario: Remote or stale after-photo submission
- **WHEN** a cleaner submits an old fix, accuracy worse than 50m or coordinates measured more than 150m from the report
- **THEN** cleanup analysis is rejected with location recovery and no candidate or RP is created

#### Scenario: Legitimate multi-minute preview
- **WHEN** a valid fresh fix is admitted with evidence and the resident spends several minutes reviewing the accepted analysis
- **THEN** consuming that still-valid bound analysis does not require its original fix to be less than 60 seconds old again
- **AND** changing the captured location requires new analysis

### Requirement: Owned bounded upload
Upload authorization SHALL bind resident, photo ID, purpose, target when applicable, media type, size and expiry. The upload SHALL require authentication, validate actual image content and dimensions, enforce a streamed size limit and prevent overwrite or reuse of attached photos.

#### Scenario: Forged or expired upload
- **WHEN** another resident reuses a ticket, the ticket expires, the stream exceeds the configured limit or JPEG content is invalid
- **THEN** upload is denied without producing usable evidence

#### Scenario: Duplicate content upload
- **WHEN** an UPLOADED or ATTACHED photo is overwritten
- **THEN** the existing immutable object remains unchanged and the request conflicts

### Requirement: Controlled photo access
Unattached photos SHALL be accessible only to their owner. Published report photos SHALL remain guest-viewable through bounded expiring read capabilities without public bucket listing or permanent provider URLs.

#### Scenario: Unpublished versus public evidence
- **WHEN** a guest requests a resident's unattached photo and then a published report photo
- **THEN** the unattached photo is denied and the published photo can be delivered through its authorized capability

### Requirement: Media privacy and retention
Camera images SHALL be re-encoded without carrying EXIF, signing tokens SHALL not be logged or sent as referrers, and housekeeping SHALL delete only expired unattached evidence. Published-photo retention SHALL be decided before an uncontrolled public pilot.

#### Scenario: Cleanup of orphans
- **WHEN** housekeeping processes expired upload objects
- **THEN** attached report/cleanup evidence is preserved even if its upload ticket is old
- **AND** public demo captures use controlled scenes with visible framing/privacy guidance

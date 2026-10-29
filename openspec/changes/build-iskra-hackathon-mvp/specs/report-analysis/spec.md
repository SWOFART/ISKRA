## Purpose

Provide preliminary all-photo classification and cleanup assessment without allowing model output or clients to claim verified civic outcomes.

## ADDED Requirements

### Requirement: Real all-photo model analysis
Real report analysis SHALL send every supplied photo to Gemini. Cleanup analysis SHALL include every accepted before photo and every submitted after photo. Model availability and structured multimodal support SHALL be verified from the deployed environment.

#### Scenario: Maximum evidence set
- **WHEN** a resident analyzes five initial photos or five before plus five after photos
- **THEN** the real model receives all images and its response passes the declared result schema
- **AND** no image is silently dropped to satisfy a provider limit

### Requirement: Validated conservative assessment
Analysis SHALL accept only bounded schema-valid output. GREEN with a non-NONE hazard level SHALL fail validation. Cleanup acceptance SHALL require LIKELY same scene, appearsClean=true and hazardRemaining=false, while final completion still requires resident verification.

#### Scenario: Inconsistent or insufficient output
- **WHEN** output has extra fields, invalid JSON, an unsupported route, GREEN plus hazard or contradictory cleanup evidence
- **THEN** it cannot become a usable accepted analysis or publish a report
- **AND** insufficient evidence requests RETAKE without a route, plausible visible hazards receive RED guidance, and a client cannot override classification to GREEN

### Requirement: Distinct assessment outcomes
A report ACCEPT result SHALL contain its validated route and factual description. RETAKE SHALL contain a reason and capture instruction without a route or publish authorization. Technical service failure SHALL remain a separate error and SHALL not require new photos merely because the service failed.

#### Scenario: Blurred image versus possible hazard
- **WHEN** an image is too blurred to assess, or instead clearly shows a potentially hazardous unknown container
- **THEN** the first result requests RETAKE without a guessed route and the second can return ACCEPT with RED and immediate safety guidance

#### Scenario: Provider fails with usable local photos
- **WHEN** Gemini times out or is unavailable
- **THEN** the user can retry analysis of the retained photos without a forced retake, automatic route or publication

#### Scenario: Cleanup is not yet evidenced
- **WHEN** after photos show a different scene, inadequate framing, remaining litter or remaining hazard
- **THEN** no accepted cleanup candidate or payout is created
- **AND** the response directs recapture, finishing safe cleanup before recapture, or not handling hazards, according to the actual reason

### Requirement: Trusted analysis binding
Accepted analysis SHALL be owned, expiring and bound to ordered photo content, comment, measured fix, pin and city; cleanup analysis SHALL additionally bind its new location, target and immutable before evidence. Publication SHALL use the stored result rather than client-posted classification.

#### Scenario: Changed inputs require reassessment
- **WHEN** photos, comment or location changes before publication
- **THEN** the old analysis cannot authorize the new inputs
- **AND** only the final factual description can be edited without a fresh analysis

#### Scenario: Consumed or unowned result
- **WHEN** a caller uses an expired, already consumed or another resident's analysis
- **THEN** publication/submission fails without attaching photos or awarding RP

#### Scenario: Support vote during cleanup review
- **WHEN** new existence votes change report counts/version while a cleaner reviews valid analysis of unchanged before evidence
- **THEN** those votes alone do not invalidate the analysis
- **AND** acceptance still rechecks the live route, cleanup availability and lifecycle

### Requirement: New analysis after expiry
An expired or failed attempt SHALL not permanently prevent fresh analysis of the same owned input. A new explicit attempt SHALL obtain a new analysis identity while ordinary network retries preserve the original operation identity and cannot consume old results twice.

#### Scenario: Reanalyze unchanged photos
- **WHEN** an owned result expires and the user explicitly starts analysis again with the same photos
- **THEN** a new bounded attempt can run without a permanent input-hash uniqueness conflict
- **AND** the old analysis remains expired and cannot publish

### Requirement: Bounded execution and safe retry
Analysis SHALL bound runtime, retries, input/output sizes and per-user abuse. Concurrent identical requests SHALL share an in-progress result where possible, and a provider failure SHALL not fabricate real success.

#### Scenario: Slow or unavailable provider
- **WHEN** Gemini times out, refuses, exhausts quota or returns persistently invalid output
- **THEN** the UI retains the local preview with retry/discard and a safe error
- **AND** no automatic publication, GREEN fallback or reward occurs

#### Scenario: Duplicate analysis request
- **WHEN** two requests identify the same owned inputs while analysis is running
- **THEN** they can receive a shared analysis ID with RUNNING and poll for its result
- **AND** a crash/retry cannot duplicate publication or RP even if provider cost is repeated

### Requirement: Untrusted prompts and secret isolation
Image text and comments SHALL be treated as observations rather than instructions. Model prompts SHALL not invent identities, official contacts, safety guarantees or completed cleanup. Provider keys and private bytes SHALL remain server-side.

#### Scenario: Instruction hidden in an image
- **WHEN** evidence includes a request to override classification or award points
- **THEN** the instruction cannot change account balances, verification status or the validated response contract

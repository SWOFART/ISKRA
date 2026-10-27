## Purpose

Let residents authenticate while preserving guest browsing and protecting private identity, activity and account data.

## ADDED Requirements

### Requirement: Verified resident identity
Protected operations SHALL derive identity from a cryptographically verified Firebase ID token for the configured project and SHALL reject invalid or missing tokens.

#### Scenario: Invalid token fails closed
- **WHEN** a token has a wrong signature, algorithm, key, issuer, audience, time claim or empty subject
- **THEN** the operation is rejected without mutation or disclosure of verification internals
- **AND** unknown signing keys receive only a bounded provider-key refresh

#### Scenario: Caller cannot choose identity
- **WHEN** a signed-in caller posts another user ID in a protected mutation
- **THEN** the request is rejected and identity remains the verified token subject

### Requirement: Neutral public identity
Bootstrap SHALL create or return one resident account per verified UID with a generated nickname and avatar, without automatically publishing provider display names or email addresses.

#### Scenario: Repeated bootstrap
- **WHEN** the same verified resident bootstraps twice
- **THEN** both responses refer to the same account and no duplicate balance or public identity is created

### Requirement: Guest login handoff
Guest camera entry SHALL request login and open capture after successful authentication. Protected direct routes SHALL offer login and retain only transient navigation intent.

#### Scenario: Camera intent survives login
- **WHEN** a guest taps the Map camera action and completes login
- **THEN** capture opens directly without mandatory onboarding or a fourth tab

#### Scenario: Cancelled login
- **WHEN** login fails or is cancelled
- **THEN** a usable guest view is restored and no report or media draft is silently persisted

### Requirement: Private projections
Public report, mission and identity responses SHALL exclude private balances, email, individual vote choices and exact voter locations. Impact, analyses, vouchers and notifications SHALL be accessible only to their owner.

#### Scenario: Cross-account access
- **WHEN** a resident requests another resident's analysis or private activity
- **THEN** access is denied without disclosing the private payload

#### Scenario: Optional authentication is cache safe
- **WHEN** a report response includes viewer permissions or a resident balance
- **THEN** it is not reusable as another viewer's response and carries no-store caching instructions

### Requirement: Safe API failures
The API SHALL validate bounded inputs, reject unknown authority-bearing fields, return safe structured errors with request IDs and retryability, and render untrusted text without execution.

#### Scenario: Authority injection and API routing
- **WHEN** a request supplies client-controlled status, route, RP, SQL-like input or an unknown API path
- **THEN** authority fields and invalid inputs are rejected, text cannot execute, and API errors remain JSON rather than an HTML SPA fallback

#### Scenario: Browser request origin
- **WHEN** a protected browser mutation comes from an unexpected origin
- **THEN** it is rejected without enabling permissive cross-origin protected access

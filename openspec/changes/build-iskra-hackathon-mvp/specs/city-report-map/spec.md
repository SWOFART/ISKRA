## Purpose

Provide mobile discovery of civic reports with truthful route, lifecycle and verification information for guests and residents.

## ADDED Requirements

### Requirement: Three-tab guest shell
The application SHALL show exactly three bottom tabs for Map, My Impact and Rewards with localized labels. Guest entry SHALL open Heilbronn without prompting for location. The camera action SHALL appear on Map above the safe area. The MVP SHALL not require a multi-city selector.

#### Scenario: First guest visit
- **WHEN** a guest opens the application
- **THEN** all active route categories are enabled, resolved reports are hidden, three tabs remain visible and no location prompt appears

### Requirement: English and German interface
The interface SHALL support English and German for navigation, actions, statuses, success messages, validation, safety and recovery. Changing interface language SHALL preserve the active report and its state without silently translating resident-authored evidence descriptions or drafts.

#### Scenario: German flow
- **WHEN** a resident chooses German
- **THEN** the same Heilbronn capture, analysis, voting, cleanup and Impact flow works with German interface copy and localized number/date presentation
- **AND** fixed English success wording has a meaning-preserving German equivalent rather than forcing an English screen

### Requirement: Clustered route and status discovery
The map SHALL cluster Heilbronn reports and display GREEN, YELLOW and RED routes independently of verification status, with text or symbols supplementing color. Route, resolved and needs-verification filters SHALL have consistent results within the selected MVP city.

#### Scenario: Citywide verification filter
- **WHEN** needs-verification is selected and the map viewport covers only part of the selected city
- **THEN** eligible pending reports across the city are included and a fit/extent action is available
- **AND** a signed-in viewer's prior vote excludes only that same stage, so a newly opened resolution stage can reappear

#### Scenario: Confirmed report remains supportable
- **WHEN** existence is confirmed and no cleanup result is awaiting verification
- **THEN** the unresolved report stays on the active map and new eligible residents can support its existence
- **AND** it is not labeled as still missing the initial three existence confirmations

#### Scenario: Resolved route remains recognizable
- **WHEN** resolved reports are included
- **THEN** lifecycle is visibly resolved while the original route color remains unchanged

### Requirement: Accessible report detail and independent galleries
Report details SHALL provide an expandable bottom sheet with keyboard and touch controls, accurate stage counts, accessible voting controls and independent Before/After galleries of 1–5 photos each.

#### Scenario: Open and inspect evidence
- **WHEN** a report marker is selected
- **THEN** its sheet opens at approximately two-thirds height, can expand or close, and supports independent horizontal and full-screen photo viewing without a comparison slider

#### Scenario: Two vote purposes during resolution review
- **WHEN** a report admits existence votes and resolution votes
- **THEN** the sheet presents clearly labeled stage-specific actions and permissions, with resolution review primary
- **AND** an existence-support vote cannot be mistaken for a cleanup-confirmation vote

### Requirement: Publication and Impact navigation
Return from publication SHALL center and highlight the new marker with its sheet closed. Selecting a My Impact row SHALL center the report and open its sheet; Back SHALL restore the prior Impact position.

#### Scenario: Distinct map entry intents
- **WHEN** a resident returns from publication and later opens that report from My Impact
- **THEN** the first entry highlights without opening details and the second opens details
- **AND** returning to My Impact restores its tab and scroll position

### Requirement: Canonical progress after mutations
The UI SHALL display committed mutation values, suppress duplicate actions in flight and reject older report responses. Threshold progress SHALL be displayed as at most 3/3, while actual existence YES totals above three and the latest existence-confirmation time SHALL remain visible separately.

#### Scenario: Delayed response cannot regress state
- **WHEN** a 3/3 mutation response arrives before an older 2/3 fetch
- **THEN** the UI retains 3/3, current stage and canonical balance, and does not repeat reward feedback

#### Scenario: More than three supporters
- **WHEN** a confirmed unresolved report has eight existence YES votes
- **THEN** the UI shows its confirmed threshold and eight confirmations with the latest confirmation time
- **AND** it does not display 8/3 as incomplete progress or claim the report is resolved

### Requirement: Honest recovery states
Tile, permission, API and expiring-photo failures SHALL provide readable recovery without fabricated location, payment or resolution. Tile failure SHALL retain a list of available reports.

#### Scenario: Map or photo unavailable
- **WHEN** tiles fail or a media capability expires
- **THEN** the user can retry or use the report list, and expired photo access is refreshed through authorized APIs

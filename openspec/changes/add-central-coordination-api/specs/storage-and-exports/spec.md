# Storage and Exports

## ADDED Requirements

### Requirement: SQLite MUST be the authoritative coordination store in the first implementation
This requirement applies to both pull requests and issues.

The system MUST use SQLite as the authoritative coordination store during the first implementation phases.

#### Scenario: Authoritative data lives in SQLite
- **Given** a webhook, analysis payload, or review-fact payload is accepted
- **When** the server persists it
- **Then** the authoritative record is stored in SQLite
- **And** API reads are served from SQLite-backed state

### Requirement: Spreadsheet output MUST be export-only and MUST NOT be the source of truth
This requirement applies to both pull requests and issues.

The system MAY generate spreadsheet-friendly exports, but edits to exported files MUST NOT directly mutate authoritative coordination state.

#### Scenario: Exported CSV is read-only from the system’s perspective
- **Given** an operator exports the triage queue as CSV
- **When** they sort or annotate the file outside the system
- **Then** the server’s authoritative state is unchanged
- **And** no export file becomes the write path for central CRUD

### Requirement: The system MUST provide operator-friendly exports for review and reporting
This requirement applies to both pull requests and issues.

The system MUST provide CSV or equivalent tabular exports for operator workflows.

#### Scenario: Triage export includes maintainer-facing columns
- **Given** the operator requests the triage export
- **When** the export is generated
- **Then** each row includes item identity, title, current state, problem intent, recommendation, cluster key, and updated timestamp
- **And** the export can be opened in a spreadsheet tool without requiring schema knowledge

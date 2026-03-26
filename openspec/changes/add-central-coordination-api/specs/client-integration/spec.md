# Client Integration

## ADDED Requirements

### Requirement: The existing CLI and TUI MUST remain usable during the migration
This requirement applies to both pull requests and issues.

The system MUST preserve the current local-first workflows while adding central-mode support.

#### Scenario: No API config keeps current behavior
- **Given** the operator has not configured an API URL
- **When** they run existing sync or TUI commands
- **Then** the repo continues to use the current local `gh`-backed flows
- **And** no central-service dependency is required

### Requirement: API-backed data sources MUST satisfy the current PR and issue data-source interfaces
This requirement applies to both pull requests and issues.

The system MUST introduce API-backed adapters instead of bypassing the existing interface boundaries.

#### Scenario: Store sync uses the API adapter
- **Given** the operator configured an API URL and authenticated successfully
- **When** the local store runs sync
- **Then** it can use the API-backed pull-request and issue data sources
- **And** the local store still receives records in the current interface shapes

### Requirement: Central attention state MUST be per-user when API mode is enabled
This requirement applies to both pull requests and issues.

The system MUST scope attention state to the authenticated user in central mode.

#### Scenario: Two maintainers watch different items
- **Given** maintainer A marks pull request `#123` as `watch`
- **And** maintainer B marks the same pull request as `ignore`
- **When** each maintainer opens the TUI in API mode
- **Then** each sees their own attention state
- **And** one user’s attention choice does not overwrite the other’s

### Requirement: Local mirrors MAY cache central state for fast terminal UX
This requirement applies to both pull requests and issues.

The system MAY mirror central data into the existing local SQLite store after sync.

#### Scenario: TUI keeps fast local reads
- **Given** the local client synced from the central API
- **When** the user opens the TUI
- **Then** the TUI can still read from the local SQLite cache for speed
- **And** that cache is treated as a client read model, not the source of truth

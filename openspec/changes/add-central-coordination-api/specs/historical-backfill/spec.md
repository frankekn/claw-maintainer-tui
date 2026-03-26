# Historical Backfill

## ADDED Requirements

### Requirement: The server MUST support resumable backfill runs for existing PRs and issues
This requirement applies to both pull requests and issues.

The system MUST allow operators to create resumable backfill runs that enumerate existing items and schedule hydrate and analyze work.

#### Scenario: Backfill resumes after interruption
- **Given** a backfill run has processed part of the open pull request history
- **And** the server stops unexpectedly
- **When** the server restarts and resumes the run
- **Then** it continues from the stored cursor
- **And** it does not restart from the beginning unless explicitly requested

### Requirement: The initial backfill priority MUST prefer active and recent work
This requirement applies to both pull requests and issues.

The system MUST prioritize the highest-value historical items first.

#### Scenario: Open items go before closed historical items
- **Given** the operator starts a default backfill
- **When** the coordinator orders work
- **Then** open pull requests are scheduled before open issues
- **And** open issues are scheduled before older closed items
- **And** merged PRs in the configured recent window are scheduled before old closed issues

### Requirement: Historical analysis SHOULD reuse the same triage contract as real-time analysis
This requirement applies to both pull requests and issues.

The system SHOULD avoid a separate historical reasoning prompt and SHOULD reuse the same structured maintainer-analysis schema.

#### Scenario: Backfill item produces the same analysis shape
- **Given** an existing open issue is analyzed during backfill
- **When** the analysis result is stored
- **Then** it uses the same maintainer-analysis schema version as real-time triage
- **And** API consumers do not need a separate code path for historical results

### Requirement: Backfill MUST skip already fresh analyses unless recompute is requested
This requirement applies to pull requests and issues, with head-SHA freshness only applying to pull requests.

The system MUST avoid redundant historical analysis when a fresh successful analysis already exists.

#### Scenario: Existing fresh PR analysis is skipped
- **Given** pull request `#123` already has a successful analysis for the current head SHA and schema version
- **When** a default backfill reaches that item
- **Then** it skips creating another analyze job for that same freshness key

#### Scenario: Explicit recompute overrides the skip
- **Given** an operator requested recompute for issue `#456`
- **When** the backfill reaches that item
- **Then** it schedules a new analysis even if an earlier successful result exists

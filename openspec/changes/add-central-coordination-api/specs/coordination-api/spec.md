# Coordination API

## ADDED Requirements

### Requirement: GitHub webhook ingest MUST create idempotent normalized PR and issue state
This requirement applies to both pull requests and issues.

The system MUST accept GitHub App webhook deliveries, verify authenticity, store each delivery idempotently, and normalize enough summary state to make the item searchable and schedulable without waiting for the full hydrate path.

#### Scenario: New pull request delivery is ingested once
- **Given** a valid GitHub webhook for pull request `#123` with delivery id `d_1`
- **When** the server receives the webhook
- **Then** it stores the raw delivery with `delivery_id = d_1`
- **And** it upserts the normalized pull request summary
- **And** it enqueues follow-up hydrate and analyze jobs as needed

#### Scenario: Duplicate webhook delivery does not duplicate work
- **Given** a valid GitHub webhook with delivery id `d_1` was already processed
- **When** the same delivery is sent again
- **Then** the server does not create duplicate normalized rows
- **And** it does not enqueue duplicate jobs for the same item and head SHA window

### Requirement: The API MUST expose sync-friendly changed feeds and hydrated detail endpoints
This requirement applies to both pull requests and issues.

The system MUST expose JSON endpoints that let clients fetch changed summaries by watermark and fetch hydrated detail for a specific item.

#### Scenario: Pull request changed feed uses a watermark
- **Given** the client previously synced pull requests through watermark `2026-03-26T10:00:00Z`
- **When** it requests the changed feed after that watermark
- **Then** the API returns only pull requests changed after that watermark
- **And** it returns a new watermark for the next sync

#### Scenario: Issue detail endpoint returns hydration data
- **Given** issue `#456` exists in the central store
- **When** the client requests the hydrated issue endpoint
- **Then** the API returns the issue summary
- **And** recent normalized comments
- **And** labels
- **And** the latest stored analysis summary if one exists

### Requirement: The API MUST accept structured review facts and maintainer analyses as first-class records
This requirement applies to both pull requests and issues, with review facts applying to pull requests only.

The system MUST expose ingest endpoints for structured review facts and maintainer analyses and persist them with dedupe rules that preserve item identity and head-SHA freshness.

#### Scenario: Review fact import remains backward-compatible
- **Given** a worker submits a review-fact payload using the existing `review-fact import` JSON shape
- **When** the server processes the payload
- **Then** it accepts the payload without requiring a new shape
- **And** it stores the review fact keyed by repo, PR number, head SHA, and source

#### Scenario: Maintainer analysis is tied to a specific PR head SHA
- **Given** an OpenClaw worker submits analysis for pull request `#123` at head SHA `abc123`
- **When** the server stores the analysis
- **Then** the record is uniquely identifiable by item identity, analyzer identity, schema version, and head SHA
- **And** later analyses for a different head SHA do not overwrite the earlier one

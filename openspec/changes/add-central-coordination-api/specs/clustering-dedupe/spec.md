# Clustering and Dedupe

## ADDED Requirements

### Requirement: Candidate generation MUST combine deterministic shared signals before optional vector search
This requirement applies to both pull requests and issues.

The system MUST generate related-intent candidates using deterministic shared signals before any optional vector rerank is applied.

#### Scenario: Candidate generation works with vectors disabled
- **Given** vector search is disabled
- **When** the API searches for related-intent candidates for a PR
- **Then** it still returns candidates using linked issues, changed-file terms, FTS, labels, and recency

#### Scenario: Optional vector rerank refines an existing candidate list
- **Given** deterministic candidate generation already returned a candidate set
- **And** vectors are enabled
- **When** rerank runs
- **Then** it only refines the ordering of the candidate set
- **And** it does not become the only source of relatedness

### Requirement: Cluster membership MUST represent shared problem families without erasing solution variants
This requirement applies to both pull requests and issues.

The system MUST let multiple items belong to the same problem family while still recording how their solutions differ.

#### Scenario: Same problem, broader fix and narrower fix
- **Given** PR `#10` and PR `#20` both address the same linked human problem
- **And** PR `#10` is the broader fix
- **When** the analyses are linked
- **Then** the system can place both items in one cluster
- **And** it can record that one item is a same-problem variant rather than an exact duplicate

### Requirement: The API MUST expose related-intent results for clankers and operator UIs
This requirement applies to both pull requests and issues.

The system MUST expose an endpoint that returns related items or clusters for a given item or problem-intent query.

#### Scenario: Clanker asks for related items before spending tokens
- **Given** a worker wants to triage pull request `#123`
- **When** it calls the related-intent endpoint
- **Then** it receives ranked related candidates and cluster summaries from shared stored data
- **And** it can use that result to avoid reprocessing obviously duplicated work

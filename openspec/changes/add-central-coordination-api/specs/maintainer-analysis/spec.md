# Maintainer Analysis

## ADDED Requirements

### Requirement: Each analysis MUST store both problem intent and solution shape
This requirement applies to both pull requests and issues.

The system MUST store a plain-language `problem_intent` and a plain-language `solution_shape` for every maintainer analysis.

#### Scenario: Same human problem with a different fix direction
- **Given** two pull requests aim to solve the same user-visible problem
- **And** they use different implementation strategies
- **When** the system stores their analyses
- **Then** both analyses can share the same problem family
- **And** each keeps its own distinct solution-shape description

#### Scenario: Technical PR description is rewritten into human language
- **Given** a pull request body is overly technical or model-generated
- **When** the triage analysis is stored
- **Then** the `problem_intent` field contains plain human language
- **And** it does not merely repeat low-level jargon

### Requirement: The analysis MUST classify autonomy, refactor need, and final recommendation as structured fields
This requirement applies to both pull requests and issues.

The system MUST represent the triage judgment with structured fields rather than prose-only comments.

#### Scenario: Fundamental refactor stops autonomy
- **Given** the analysis concludes that a fundamental refactor is required
- **When** the analysis is persisted
- **Then** `refactor_needed` is `fundamental`
- **And** `human_attention_required` is `true`
- **And** `autonomy_lane` is `stop`
- **And** `final_recommendation` is `escalate`

#### Scenario: Superficial refactor can continue autonomously
- **Given** the analysis concludes that only a superficial refactor is needed
- **When** the analysis is persisted
- **Then** `refactor_needed` is `superficial`
- **And** the item may still be marked safe to continue autonomously

### Requirement: Pull-request analysis MUST be fresh per head SHA
This requirement applies to pull requests.

The system MUST treat a change in head SHA as a new analysis target.

#### Scenario: New commit invalidates latest analysis freshness
- **Given** pull request `#123` has a stored successful analysis for head SHA `abc123`
- **When** a new commit updates the PR to head SHA `def456`
- **Then** the previous analysis remains historical
- **And** the system schedules or expects a new analysis for `def456`

### Requirement: Analysis output MUST support labels and reviewer suggestions as optional structured data
This requirement applies to both pull requests and issues.

The system MUST persist structured labels and MAY persist reviewer suggestions with rationale.

#### Scenario: Reviewer suggestions are available but not mandatory
- **Given** the analyzer suggests reviewers `alice` and `bob`
- **When** the server stores the analysis
- **Then** the reviewer suggestions are queryable as metadata
- **And** no API consumer is required to treat them as mandatory assignees

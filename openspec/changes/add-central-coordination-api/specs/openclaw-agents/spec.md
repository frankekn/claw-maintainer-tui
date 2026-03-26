# OpenClaw Agents

## ADDED Requirements

### Requirement: A dedicated OpenClaw hook agent MUST process triage jobs from the coordination API
This requirement applies to both pull requests and issues.

The system MUST use a dedicated OpenClaw hook agent for maintainer triage work.

#### Scenario: Analyze job is dispatched to the dedicated agent
- **Given** the server has an analyze job for pull request `#123`
- **When** the dispatch worker sends the job to OpenClaw
- **Then** the request targets the configured dedicated triage agent id
- **And** the request does not rely on the user’s main operator agent session

### Requirement: The triage agent MUST fetch context from the API and POST structured results back to the API
This requirement applies to both pull requests and issues.

The agent MUST use the central API as its source of truth for normalized context and result submission.

#### Scenario: Agent fetches normalized PR context first
- **Given** the hook message identifies pull request `#123`
- **When** the triage agent starts work
- **Then** it first fetches the PR context bundle from the API
- **And** it does not independently enumerate repository history before using that context

#### Scenario: Agent returns a structured analysis payload
- **Given** the triage agent completed reasoning about issue `#456`
- **When** it finishes the job
- **Then** it submits the structured maintainer-analysis payload to the API
- **And** the payload includes problem intent, solution shape, recommendation, and relationship decisions

### Requirement: Hook ingress MUST be constrained by dedicated auth and agent routing controls
This requirement applies to both pull requests and issues.

The system MUST protect hook ingress with a dedicated token and restricted agent routing.

#### Scenario: Hook request with disallowed agent id is rejected or downgraded safely
- **Given** the OpenClaw hook surface is configured with an allowlist of agent ids
- **When** a request tries to route to an agent id outside that allowlist
- **Then** the request is rejected or safely falls back according to configured policy
- **And** the triage-specific hook path cannot arbitrarily target unrelated agents

#### Scenario: Hook token is required
- **Given** an external caller submits a hook request without the configured token
- **When** OpenClaw evaluates the request
- **Then** the request is not accepted for triage work

### Requirement: The triage agent MUST stop before deep automated review when human framing is required
This requirement applies to both pull requests and issues, with automated review only applying to pull requests.

The triage agent MUST stop the autonomous path when the structured judgment says human attention is required.

#### Scenario: Human framing required
- **Given** the analysis concludes the item is solving the wrong problem
- **When** the triage agent finalizes the result
- **Then** it marks the item as requiring human attention
- **And** it does not continue into Codex review within the same autonomous lane

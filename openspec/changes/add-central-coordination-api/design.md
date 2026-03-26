# Design: Central coordination API for clawlens

## Overview

This design keeps the current repo and local-first ergonomics while adding a central coordination plane.

High-level flow:

1. GitHub App webhooks hit the central server.
2. The server normalizes PRs, issues, comments, labels, linked issues, changed files, and status state into SQLite.
3. The server enqueues analysis jobs.
4. A dispatch worker triggers a dedicated OpenClaw hook agent.
5. The OpenClaw triage agent fetches item context and candidate related-intent items from the API.
6. The triage agent returns structured analysis to the API.
7. API-backed adapters let the current CLI/TUI sync shared state into the existing local store.

This creates shared memory without centralizing all execution.

---

## Repository layout

Additive layout:

```text
/server/
  go.mod
  cmd/clawlensd/main.go
  internal/
    api/
    auth/
    backfill/
    config/
    githubapp/
    jobs/
    openclaw/
    search/
    store/
    types/

/src/
  api/
    auth.ts
    client.ts
    data-source.ts
    types.ts
  cli.ts                  # new auth/config and API-aware sync commands
  tui/
    data-service.ts       # updated to accept API-backed sources

/openclaw/
  skills/
    maintainer-triage/
      SKILL.md
    historical-backfill/
      SKILL.md
  examples/
    hooks.github-triage.json

/openspec/
  ...
```

The TypeScript app stays the user-facing CLI/TUI.
The Go module is the coordination service.

---

## Design principles

### Preserve existing seams
The current repo already separates:
- acquisition (`PullRequestDataSource`, `IssueDataSource`)
- local read model and search (`PrIndexStore`)
- TUI consumption (`TuiDataService`)

Do not rewrite those boundaries first.
Add `ApiPullRequestDataSource` and `ApiIssueDataSource` that satisfy the existing contracts.

### Separate shared facts from local preferences
Centralize:
- PR/issue state
- linked issues
- changed files and terms
- review facts
- maintainer analyses
- cluster links
- backfill and job metadata

Keep local-only or per-user:
- watch / ignore / seen
- personal filters and attention decisions

When centralized, attention state must be keyed by user identity.

### Separate problem from solution
The analysis model must always store:
- `problem_intent`
- `solution_shape`

This prevents “same human problem, different fixes” from collapsing into one opaque bucket.

### Start deterministic, add vectors later
The server starts with:
- linked issue overlap
- changed-file-term overlap
- FTS over title/body/comment and `problem_intent`
- exact head SHA identity
- label overlap
- author / reviewer history

Optional vector search is phase 5+, behind a feature flag.

---

## External system choices

### GitHub
Use a GitHub App.

Reasons:
- centralized webhook delivery
- installation-token automation
- user access tokens for user-attributed auth
- org membership checks during login

### OpenClaw
Use a dedicated hook agent, not the main operator agent.
The hook agent receives external trigger work only.
It runs with:
- dedicated `hooks.token`
- `hooks.allowedAgentIds` restricted to the triage agent
- loopback or tailnet-only ingress
- strict tool policy and sandboxing

### Server storage
Use SQLite in WAL mode.
Enable:
- normalized relational tables
- FTS5 for text search
- JSON columns only where structure is genuinely open-ended
- periodic backups / snapshot export

Do not make spreadsheets authoritative.

---

## Authentication design

## Modes

### Automation mode
The server authenticates as the GitHub App installation.
Use this mode for:
- webhook follow-up calls
- hydration
- fetching PR facts
- backfill enumeration

### User mode
The server authenticates users through GitHub App user authorization and then mints server sessions.

## Why the server brokers device flow
For CLI/TUI login, the client should not hold the GitHub App client secret.
Therefore:
1. CLI calls `POST /v1/auth/device/start`
2. Server starts GitHub device flow and returns:
   - `user_code`
   - `verification_uri`
   - `expires_in`
   - `interval`
   - `login_request_id`
3. CLI polls `POST /v1/auth/device/poll`
4. Server exchanges device grant for GitHub user token
5. Server checks org membership
6. Server mints:
   - short-lived access token
   - refresh token
7. CLI stores server session credentials locally with 0600 permissions

Web UI can later use the normal web application flow.

## Session model

### Access token
Short-lived bearer token for API calls.

### Refresh token
Longer-lived token used only against the server’s refresh endpoint.

### User record
Stored fields:
- GitHub user id
- login
- avatar URL (optional)
- org membership state
- last authenticated at

### Authorization
Initial role model:
- `org_member`
- `admin`

The system may later add repo-specific roles, but not in the first implementation.

---

## Data model

## Core identity rules

### Repo identity
Canonical repo key is `owner/name`.
Internally, use numeric surrogate IDs.

### Item identity
Use:
- `item_kind`: `pull_request` or `issue`
- `item_number`
- `repo_id`

### PR analysis identity
A PR analysis record is unique on:
- `repo_id`
- `pr_number`
- `head_sha`
- `analyzer_id`
- `analyzer_version`
- `schema_version`

The current head SHA determines freshness.
If the head SHA changes, the previous analysis becomes historical.

## Tables

### `github_webhook_events`
Purpose: idempotent ingest and replay.
Columns:
- `delivery_id` TEXT PRIMARY KEY
- `event_name` TEXT NOT NULL
- `action` TEXT
- `repo_id` INTEGER
- `item_kind` TEXT
- `item_number` INTEGER
- `payload_json` TEXT NOT NULL
- `received_at` TEXT NOT NULL
- `processed_at` TEXT
- `processing_error` TEXT

### `repos`
- `id`
- `owner`
- `name`
- `installation_id`
- `default_branch`
- `created_at`
- `updated_at`

### `pull_requests`
- `repo_id`
- `number`
- `title`
- `body`
- `state`
- `is_draft`
- `author_login`
- `base_ref`
- `head_ref`
- `head_sha`
- `url`
- `created_at`
- `updated_at`
- `closed_at`
- `merged_at`
- `labels_json`
- `last_hydrated_at`

### `issues`
- same identity pattern as pull requests
- issue-specific state and labels
- `last_hydrated_at`

### `item_comments`
Unify issue comments, PR reviews, and review comments with:
- `repo_id`
- `item_kind`
- `item_number`
- `source_id`
- `comment_kind`
- `author_login`
- `body`
- `path`
- `url`
- `created_at`
- `updated_at`

### `linked_issues`
- `repo_id`
- `pr_number`
- `issue_number`
- `link_source`

### `changed_files`
- `repo_id`
- `pr_number`
- `path`
- `kind`

### `changed_file_terms`
- `repo_id`
- `pr_number`
- `term_kind`
- `term_value`

### `pr_review_facts`
Port the current review-fact shape nearly unchanged:
- `repo_key`
- `pr_number`
- `head_sha`
- `decision`
- `summary`
- `commands_json`
- `failing_tests_json`
- `source`
- `recorded_at`

### `maintainer_analyses`
Primary shared intelligence table.
Columns:
- `id`
- `repo_id`
- `item_kind`
- `item_number`
- `head_sha` NULL for issues
- `analyzer_id`
- `analyzer_version`
- `schema_version`
- `problem_intent`
- `solution_shape`
- `intent_valid`
- `solves_right_problem`
- `refactor_needed`
- `human_attention_required`
- `autonomy_lane`
- `ai_review_status`
- `ci_status`
- `final_recommendation`
- `reviewer_candidates_json`
- `labels_json`
- `evidence_json`
- `problem_intent_normalized`
- `created_at`

### `analysis_relationships`
Stores explicit agent decisions between analyses or between an analysis and candidate items.
Columns:
- `repo_id`
- `source_analysis_id`
- `target_item_kind`
- `target_item_number`
- `target_head_sha`
- `relationship`
- `score`
- `reason`

Relationships:
- `duplicate`
- `same_problem_variant`
- `related`
- `distinct`

### `clusters`
- `id`
- `repo_id`
- `cluster_key`
- `basis`
- `canonical_problem_intent`
- `created_at`
- `updated_at`

### `cluster_members`
- `cluster_id`
- `item_kind`
- `item_number`
- `head_sha`
- `membership_kind`
- `added_at`

### `user_item_state`
Central per-user watch state:
- `user_id`
- `repo_id`
- `item_kind`
- `item_number`
- `attention_state`
- `updated_at`

### `jobs`
- `id`
- `job_type`
- `repo_id`
- `item_kind`
- `item_number`
- `head_sha`
- `payload_json`
- `status`
- `attempt_count`
- `available_at`
- `started_at`
- `finished_at`
- `error`

### `backfill_runs`
- `id`
- `repo_id`
- `scope`
- `status`
- `cursor_json`
- `requested_by`
- `created_at`
- `updated_at`

---

## API contracts

The server speaks JSON over HTTP.

## Auth endpoints

### `POST /v1/auth/device/start`
Starts server-brokered GitHub device flow.

Response:
```json
{
  "login_request_id": "lrq_123",
  "user_code": "ABCD-EFGH",
  "verification_uri": "https://github.com/login/device",
  "expires_in": 900,
  "interval": 5
}
```

### `POST /v1/auth/device/poll`
Input:
```json
{ "login_request_id": "lrq_123" }
```

Possible responses:
- `pending`
- `authorized`
- `expired`

Authorized response:
```json
{
  "status": "authorized",
  "access_token": "srv_at_...",
  "refresh_token": "srv_rt_...",
  "expires_at": "2026-03-26T12:00:00Z",
  "user": {
    "github_login": "octocat",
    "org_role": "org_member"
  }
}
```

### `POST /v1/auth/refresh`
Refreshes a server access token.

### `POST /v1/auth/logout`
Revokes the current server session.

## Webhook endpoint

### `POST /webhooks/github`
Responsibilities:
- verify GitHub signature
- dedupe on `delivery_id`
- normalize summary state
- enqueue hydrate / analyze jobs
- return success quickly

Do not run heavy analysis inline.

## Repo and item endpoints

### `GET /v1/repos/{owner}/{repo}/pulls/changed?since=...`
Returns PR summaries changed since the watermark.
Purpose: API-backed sync into the current local store.

### `GET /v1/repos/{owner}/{repo}/pulls/{number}`
Returns hydrated PR detail:
- PR summary
- comments
- linked issues
- changed files
- current facts
- latest stored analysis summary

### `GET /v1/repos/{owner}/{repo}/issues/changed?since=...`
Same pattern for issues.

### `GET /v1/repos/{owner}/{repo}/issues/{number}`
Hydrated issue detail.

## Analysis endpoints

### `GET /v1/context/pulls/{owner}/{repo}/{number}`
Returns the context bundle the OpenClaw triage agent needs:
- PR summary
- recent comments
- linked issues with titles/bodies
- changed files and changed-file terms
- latest review facts
- status summary
- candidate related-intent items

### `GET /v1/context/issues/{owner}/{repo}/{number}`
Issue equivalent.

### `POST /v1/analyses/candidate-search`
Input:
```json
{
  "repo": "owner/name",
  "item_kind": "pull_request",
  "item_number": 123,
  "head_sha": "abc123",
  "problem_intent": "Users want ...",
  "linked_issue_numbers": [456],
  "changed_file_terms": ["area/auth", "file/login"],
  "limit": 20
}
```

Behavior:
- deterministic candidate generation using FTS, linked issues, changed-file-term overlap, labels, and recency
- optional vector rerank later

### `POST /v1/analyses`
Ingests structured maintainer analysis.

Canonical payload:
```json
{
  "repo": "owner/name",
  "item_kind": "pull_request",
  "item_number": 123,
  "head_sha": "abc123",
  "analyzer_id": "openclaw-maintainer-triage",
  "analyzer_version": "0.1.0",
  "schema_version": "2026-03-26",
  "problem_intent": "Users want ...",
  "solution_shape": "This PR ...",
  "intent_valid": "yes",
  "solves_right_problem": "partly",
  "refactor_needed": "fundamental",
  "human_attention_required": true,
  "autonomy_lane": "stop",
  "ai_review_status": "not_run",
  "ci_status": "not_checked",
  "final_recommendation": "escalate",
  "labels": [
    "intent:auth-session-persistence",
    "risk:medium",
    "lane:human"
  ],
  "reviewer_candidates": ["alice", "bob"],
  "evidence": [
    "PR only changes UI text while linked issue describes state persistence.",
    "Changed files overlap with existing merged PR #98."
  ],
  "relationships": [
    {
      "target_item_kind": "pull_request",
      "target_item_number": 98,
      "target_head_sha": "def456",
      "relationship": "same_problem_variant",
      "score": 0.92,
      "reason": "same human problem, broader fix"
    }
  ]
}
```

### `GET /v1/analyses/latest?...`
Fetches the latest analysis for a given item/head SHA.

### `GET /v1/related-intents?...`
Returns related clusters or items for operator views and TUI.

## Review-fact endpoints

### `POST /v1/review-facts`
Accepts the same shape currently handled by `review-fact import`.
This is the lowest-risk first worker integration.

---

## Sync and hydrate strategy

Reuse the current concept of summary versus hydrate refresh.

### Summary write
Use webhook payload data to upsert lightweight PR or issue summaries immediately.

### Hydrate job
Queue a hydrate when:
- the item is first seen
- the PR head SHA changed
- payload lacks fields needed by the store
- issue/PR body or comments changed materially
- a full refresh is explicitly requested

This preserves current efficiency.

---

## OpenClaw integration design

## Dedicated agent
Use an agent id such as `maintainer-triage`.

It should not be the user’s main operator agent.
Its workspace should contain:
- the maintainer triage skill
- optional backfill skill
- minimal hook-specific instructions

## Trigger path
The server dispatch worker calls OpenClaw on loopback or tailnet:

`POST /hooks/agent`

Payload shape:
```json
{
  "agentId": "maintainer-triage",
  "name": "GitHub Triage",
  "message": "Analyze repo=openclaw/openclaw item=pull_request#123 head=abc123 via API base URL ...",
  "wakeMode": "now",
  "deliver": false,
  "model": "openai/gpt-5.2-mini",
  "thinking": "medium"
}
```

## Triage skill responsibilities
The skill must instruct the agent to:
1. fetch the normalized context bundle from the API
2. recover `problem_intent` in plain human language
3. describe `solution_shape`
4. decide intent validity and whether the current item solves the right problem
5. label the item
6. request candidate related-intent items from the API when not already included
7. decide cluster relationships against candidates
8. return the structured analysis payload
9. stop before Codex review if `human_attention_required=true`

## Why the agent should not own candidate generation
Server-side candidate generation is cheaper, repeatable, and shared.
The agent should decide among candidates, not search the whole universe from scratch.

## Optional later stage: ACP/Codex review
After the autonomy gate passes:
- the system may trigger a later review stage that uses Codex through ACP
- this is not required for the first server rollout
- the triage analysis must carry enough structure to gate that later stage

---

## Historical backfill design

## Coordinator
Use a server-side backfill coordinator, not a separate reasoning model.

Responsibilities:
- enumerate existing items from GitHub using installation auth
- write summary state
- enqueue hydrate jobs
- enqueue analysis jobs
- checkpoint cursor progress
- respect repo and time-range filters

## Initial backfill scope
MVP order:
1. open PRs
2. open issues
3. merged PRs from last 90 days
4. closed issues only when explicitly requested

## Resume rules
A backfill run is resumable if the server restarts.
Store cursor state in `backfill_runs.cursor_json`.

## Reanalysis rules
Do not re-run expensive analysis when:
- the same item has the same head SHA
- the same analyzer and schema version already produced a success record
- no force-recompute flag is present

Do re-run when:
- head SHA changed
- analyzer version changed
- schema version changed
- operator requested recompute
- candidate generation inputs changed materially

---

## Dedupe and clustering design

## Signals
Candidate generation uses:
1. exact linked-issue overlap
2. changed-file-term overlap
3. FTS over title/body/comments and previous `problem_intent`
4. label overlap
5. recency
6. optional vector rerank later

## Problem-first clustering
A cluster is a family of items solving the same human problem.
Different solution variants can live in one cluster.

## Relationship semantics
- `duplicate`: same problem, materially same fix direction
- `same_problem_variant`: same problem, different fix direction or scope
- `related`: nearby but not same family
- `distinct`: not the same family

## Reviewer hints
Phase 5 reviewer hints can be heuristic:
- recent reviewers on similar changed-file terms
- authors of recent accepted fixes in the same area
- maintainers historically involved in the linked issues

Store these as suggestions, never as required routing.

---

## Client integration design

## New API-backed data sources
Add:
- `ApiPullRequestDataSource`
- `ApiIssueDataSource`

They must satisfy the current interfaces used by the store.

## Local store remains
The local SQLite store still exists as a read model for:
- TUI speed
- offline-ish operation after sync
- local search / clustering reuse during transition

## API-aware CLI
Add commands:
- `clawlens auth login --api-url ...`
- `clawlens auth status`
- `clawlens auth logout`
- `clawlens sync --api-url ...`
- `clawlens sync-issues --api-url ...`

Keep existing `gh`-backed behavior as the default when no API URL is configured.

## Attention state migration
Current local attention state is repo-wide local state.
Central mode must use `user_item_state`.
If central mode is enabled, TUI writes attention changes to the API first, then mirrors them locally.

---

## Spreadsheet export design

Use export, not source-of-truth.

## Exports
Add:
- `GET /v1/exports/triage.csv`
- `GET /v1/exports/clusters.csv`
- `GET /v1/exports/review-facts.csv`

Fields should be operator-friendly:
- repo
- item kind
- number
- title
- state
- head SHA
- problem intent
- solution shape
- refactor needed
- recommendation
- cluster key
- reviewer candidates
- updated at

## Why not spreadsheet as source-of-truth
A spreadsheet does not provide:
- webhook-safe idempotency
- typed relationships
- efficient search
- transactional updates
- durable job state
- item/head SHA identity

Use CSV or sheet export for sorting and human review only.

---

## Failure handling and observability

## Idempotency
- webhook dedupe on delivery id
- analysis dedupe on item + head SHA + analyzer + schema
- job dedupe on job type + item identity + head SHA + status window

## Retries
- exponential backoff for GitHub hydration failures
- capped retries for OpenClaw dispatch failures
- dead-letter state in `jobs`

## Metrics
Track:
- webhook ingest latency
- normalize latency
- hydration success rate
- analysis success rate
- duplicate analysis skips
- backfill progress
- related-intent query latency

## Logs
Each request and job should include:
- request/job id
- repo
- item kind
- item number
- head SHA
- analyzer id
- delivery id where relevant

---

## Testing strategy

## Go server
- unit tests for auth, webhook verification, normalization, storage, and job dedupe
- integration tests with fixture webhook payloads and SQLite temp DBs
- API contract tests for auth, changed feeds, and analysis ingest

## TypeScript client
- tests for API-backed data-source adapters
- tests for CLI auth command flows using mocked server responses
- regression tests that local-only flows still work when no API config exists

## OpenClaw skill artifacts
- prompt snapshot tests or golden files for generated analysis payload shape
- fixture-driven tests for context-bundle parsing if helper scripts exist

---

## Phase plan

### Phase 0
Land OpenSpec files and directory scaffolding.

### Phase 1
Implement:
- `/server` module
- config loading
- SQLite schema
- `/webhooks/github`
- raw-event storage
- normalized summary upserts
- hydrate/analyze job tables

### Phase 2
Implement:
- auth device-flow broker
- refresh/logout
- repo change feeds
- hydrated item endpoints
- review-fact ingest

### Phase 3
Implement:
- OpenClaw dispatch client
- `maintainer-triage` skill
- context endpoints
- analysis ingest
- latest-analysis lookup

### Phase 4
Implement:
- backfill coordinator
- resumable cursors
- operator-triggered backfill endpoints
- skip rules for already-analyzed head SHAs

### Phase 5
Implement:
- candidate-search endpoint
- relationship persistence
- cluster tables
- related-intent endpoint
- reviewer hints

### Phase 6
Implement:
- API-backed data sources in TypeScript
- CLI auth/config
- optional TUI central mode
- per-user attention state sync

### Phase 7
Implement:
- CSV exports
- metrics/logging polish
- docs and rollout guide

---

## Appendix: draft OpenClaw skill skeletons

## `openclaw/skills/maintainer-triage/SKILL.md`

```md
---
name: maintainer_triage
description: Recover plain-language intent, assign labels, make cluster decisions, and push structured maintainer analysis to the central API.
metadata:
  openclaw:
    requires:
      bins: ["curl"]
---

# Maintainer Triage

Use this skill when the hook message names a GitHub PR or issue that must be triaged.

## Rules

- Fetch context from the central API before reasoning.
- Always write both `problem_intent` and `solution_shape`.
- Do not run Codex review if human attention is required.
- When deciding relatedness, compare against API-provided candidates first.
- Submit a structured analysis payload back to the API.
- Keep comments plain-language and maintainer-facing.
```

## `openclaw/skills/historical-backfill/SKILL.md`

```md
---
name: historical_backfill
description: Process historical PR and issue analysis tasks supplied by the central API.
metadata:
  openclaw:
    requires:
      bins: ["curl"]
---

# Historical Backfill

Use this skill only for backfill-issued tasks.

## Rules

- Treat the item exactly like real-time triage.
- Use the same analysis contract and schema version as real-time triage.
- Respect job ids and return results only for the requested item.
- Do not enumerate GitHub history yourself; the server owns enumeration and cursoring.
```

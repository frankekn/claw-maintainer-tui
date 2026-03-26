# Tasks: Add central coordination API

## Phase 0 — OpenSpec and repo scaffolding

- [ ] Add `openspec/config.yaml`.
- [ ] Add the `add-central-coordination-api` change folder with proposal, design, tasks, and delta specs.
- [ ] Add placeholder repo directories:
  - [ ] `/server/cmd/clawlensd`
  - [ ] `/server/internal`
  - [ ] `/src/api`
  - [ ] `/openclaw/skills`
- [ ] Add a top-level architecture note explaining that the repo is now a TS client + Go server monorepo.
- [ ] Add feature flags/config placeholders for future API mode without changing current defaults.

### Verification
- [ ] The repo tree contains the new directories without breaking current local-first commands.
- [ ] The OpenSpec artifacts are internally consistent.

## Phase 1 — Go server skeleton, storage, and GitHub webhook ingest

- [ ] Create `/server/go.mod`.
- [ ] Add `cmd/clawlensd/main.go` with config loading, HTTP server boot, and graceful shutdown.
- [ ] Add SQLite connection management in WAL mode.
- [ ] Implement schema creation for:
  - [ ] repos
  - [ ] github_webhook_events
  - [ ] pull_requests
  - [ ] issues
  - [ ] item_comments
  - [ ] linked_issues
  - [ ] changed_files
  - [ ] changed_file_terms
  - [ ] pr_review_facts
  - [ ] maintainer_analyses
  - [ ] analysis_relationships
  - [ ] clusters
  - [ ] cluster_members
  - [ ] user_item_state
  - [ ] jobs
  - [ ] backfill_runs
- [ ] Implement GitHub webhook signature verification.
- [ ] Implement `POST /webhooks/github`.
- [ ] Store raw webhook deliveries idempotently by `delivery_id`.
- [ ] Normalize PR and issue summary data from webhook payloads.
- [ ] Enqueue hydrate and analyze jobs instead of doing heavy work inline.
- [ ] Add unit tests for:
  - [ ] webhook signature verification
  - [ ] duplicate webhook delivery handling
  - [ ] PR summary normalization
  - [ ] issue summary normalization
  - [ ] job dedupe

### Verification
- [ ] Fixture webhook payloads can be ingested into a temp SQLite DB.
- [ ] Replaying the same webhook does not create duplicate rows or duplicate jobs.
- [ ] The server starts and exposes a health endpoint.

## Phase 2 — GitHub App auth broker and JSON API

- [ ] Add server config for GitHub App id, client id, client secret, private key, webhook secret, and allowed orgs.
- [ ] Implement device-flow broker endpoints:
  - [ ] `POST /v1/auth/device/start`
  - [ ] `POST /v1/auth/device/poll`
  - [ ] `POST /v1/auth/refresh`
  - [ ] `POST /v1/auth/logout`
- [ ] Implement org membership checks before issuing a server session.
- [ ] Add session tables and token signing / persistence.
- [ ] Implement repo and item endpoints:
  - [ ] `GET /v1/repos/{owner}/{repo}/pulls/changed`
  - [ ] `GET /v1/repos/{owner}/{repo}/pulls/{number}`
  - [ ] `GET /v1/repos/{owner}/{repo}/issues/changed`
  - [ ] `GET /v1/repos/{owner}/{repo}/issues/{number}`
- [ ] Implement `POST /v1/review-facts`.
- [ ] Add integration tests for the auth broker with mocked GitHub responses.
- [ ] Add integration tests for changed-feed watermarks and hydrated detail endpoints.

### Verification
- [ ] A mocked device-flow login results in a server-issued access token.
- [ ] A non-member login is rejected.
- [ ] Changed-feed endpoints only return rows updated after the watermark.
- [ ] Review-fact ingest accepts the current JSON shape.

## Phase 3 — OpenClaw triage dispatch and maintainer-analysis ingest

- [ ] Add server support for dispatching jobs to OpenClaw hook ingress.
- [ ] Add config for:
  - [ ] OpenClaw base URL
  - [ ] hook token
  - [ ] allowed agent id
  - [ ] default model
  - [ ] timeout
- [ ] Implement context endpoints:
  - [ ] `GET /v1/context/pulls/{owner}/{repo}/{number}`
  - [ ] `GET /v1/context/issues/{owner}/{repo}/{number}`
- [ ] Implement `POST /v1/analyses`.
- [ ] Implement `GET /v1/analyses/latest`.
- [ ] Add validation for maintainer-analysis payload schema.
- [ ] Persist analysis relationships.
- [ ] Create draft skill files:
  - [ ] `/openclaw/skills/maintainer-triage/SKILL.md`
  - [ ] `/openclaw/skills/historical-backfill/SKILL.md`
- [ ] Add example OpenClaw hook config under `/openclaw/examples/`.
- [ ] Add tests for:
  - [ ] context endpoint shape
  - [ ] analysis payload validation
  - [ ] dedupe by item/head/analyzer/schema

### Verification
- [ ] A queued analyze job can dispatch to a mocked OpenClaw endpoint.
- [ ] A valid analysis payload is accepted and queryable via latest-analysis lookup.
- [ ] An invalid or duplicate analysis payload is rejected or safely ignored.

## Phase 4 — Historical backfill

- [ ] Add backfill endpoints:
  - [ ] `POST /v1/backfill/runs`
  - [ ] `GET /v1/backfill/runs/{id}`
  - [ ] `POST /v1/backfill/runs/{id}/cancel`
- [ ] Implement the server-side backfill coordinator.
- [ ] Support backfill scopes:
  - [ ] open PRs
  - [ ] open issues
  - [ ] merged PRs in a configurable recent window
  - [ ] explicit closed-issues backfill
- [ ] Persist backfill cursors in `backfill_runs`.
- [ ] Reuse hydrate + analyze jobs instead of a separate pipeline.
- [ ] Add skip logic for already-analyzed head SHAs.
- [ ] Add tests for:
  - [ ] resumable cursors
  - [ ] cancellation
  - [ ] skip rules
  - [ ] prioritization order

### Verification
- [ ] A backfill run can stop and resume without losing progress.
- [ ] Existing analyzed items are skipped unless force-recompute is set.
- [ ] Open PRs and open issues are processed before historical closed items.

## Phase 5 — Candidate generation, clustering, and reviewer hints

- [ ] Implement deterministic candidate generation using:
  - [ ] linked issue overlap
  - [ ] changed-file-term overlap
  - [ ] FTS over PRs/issues/comments and stored `problem_intent`
  - [ ] label overlap
  - [ ] recency
- [ ] Implement `POST /v1/analyses/candidate-search`.
- [ ] Implement cluster tables and membership updates.
- [ ] Implement `GET /v1/related-intents`.
- [ ] Implement reviewer hint generation as a non-blocking suggestion.
- [ ] Keep vector rerank behind a feature flag and off by default.
- [ ] Add tests for:
  - [ ] cluster member insertion
  - [ ] relationship semantics
  - [ ] related-intent query ordering
  - [ ] reviewer suggestion ordering

### Verification
- [ ] The API returns candidate related-intent items before vector search is enabled.
- [ ] Distinct solution variants for the same problem can coexist in one cluster.
- [ ] Reviewer hints are returned as suggestions, not required assignees.

## Phase 6 — TypeScript API client, CLI auth, and TUI integration

- [ ] Add `/src/api/types.ts` for shared wire types.
- [ ] Add `/src/api/client.ts`.
- [ ] Add `/src/api/auth.ts`.
- [ ] Implement `ApiPullRequestDataSource`.
- [ ] Implement `ApiIssueDataSource`.
- [ ] Update CLI with:
  - [ ] `auth login`
  - [ ] `auth status`
  - [ ] `auth logout`
  - [ ] API-aware `sync`
  - [ ] API-aware `sync-issues`
- [ ] Add config storage for API URL and session tokens with 0600 permissions.
- [ ] Update TUI bootstrap to choose `gh` or API source based on config.
- [ ] Mirror per-user attention state between API and local store when API mode is enabled.
- [ ] Add tests for:
  - [ ] API data-source changed feed behavior
  - [ ] login/logout status flows
  - [ ] central attention-state writes
  - [ ] fallback to local-only mode when no API config is present

### Verification
- [ ] The current TUI can run with API-backed sync without changing its main screens.
- [ ] The existing local-only mode still works with no API config.
- [ ] Attention-state updates in API mode are per-user and survive restart.

## Phase 7 — Exports, metrics, hardening, and rollout

- [ ] Implement CSV export endpoints:
  - [ ] `/v1/exports/triage.csv`
  - [ ] `/v1/exports/clusters.csv`
  - [ ] `/v1/exports/review-facts.csv`
- [ ] Add structured logs and request/job ids.
- [ ] Add metrics for webhook latency, dispatch success, backfill progress, and duplicate-analysis skips.
- [ ] Add retry and dead-letter handling for failed OpenClaw dispatches.
- [ ] Add backup and restore notes for SQLite.
- [ ] Add rollout docs:
  - [ ] local development
  - [ ] GitHub App setup
  - [ ] OpenClaw hook setup
  - [ ] auth login
  - [ ] backfill operations
  - [ ] rollback to local-only mode
- [ ] Update README and operator docs.
- [ ] Add end-to-end fixture tests covering:
  - [ ] webhook ingest
  - [ ] analysis dispatch
  - [ ] analysis ingest
  - [ ] client sync

### Verification
- [ ] CSV exports contain operator-friendly columns and do not mutate server data.
- [ ] Dead-lettered dispatch jobs are inspectable.
- [ ] Operators can run the full flow from a clean environment using the docs.

## Implementation guardrails for Codex CLI

- [ ] Do not rewrite the existing local store before API-backed adapters exist.
- [ ] Do not make spreadsheet output authoritative.
- [ ] Do not make attention state global.
- [ ] Do not make embeddings mandatory in the first cut.
- [ ] Do not auto-close or auto-merge based only on triage output.
- [ ] Keep all PR-derived facts and analyses tied to head SHA.
- [ ] Keep review-fact ingestion backward-compatible with the current JSON shape.

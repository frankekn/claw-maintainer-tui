# Proposal: Add central coordination API, OpenClaw triage agent, and historical backfill

## Why

The current repo is a strong local-first maintainer cockpit, but it has no shared memory between maintainers or clankers. That creates three expensive problems:

1. Every machine repeats the same intent recovery, labeling, and review preparation work.
2. Similar PRs and issues are discovered too late, so maintainers still do duplicate reasoning by hand.
3. Existing PR and issue knowledge is trapped in each operator’s local SQLite file.

The goal of this change is to keep the current repo and TUI, while adding a central coordination plane that stores shared maintainer intelligence and lets local OpenClaw and Codex runs coordinate through it.

## Why this belongs in this repo

This repo already contains the right seams for the migration:

- data-source interfaces for PRs and issues
- a local SQLite read model with linked issues, changed-file terms, and review facts
- sync workflows that already distinguish summary refresh from full hydration
- CLI affordances for importing structured review facts
- a TUI data-service layer that can be backed by another source

Adding the central coordination plane here avoids a rewrite, preserves the existing TUI, and makes the API-backed mode and local-first mode share one codebase.

## Goals

- Add a central server that ingests GitHub App webhooks in real time.
- Keep compute decentralized: OpenClaw and Codex can still run on local machines.
- Store shared triage results, intent, labels, cluster links, reviewer hints, and review facts centrally.
- Add GitHub-based user authentication, org membership checks, and server-issued API sessions.
- Add an OpenClaw triage agent for intent recovery, labeling, and cluster decisions.
- Add a historical backfill path for existing PRs and issues.
- Keep the existing CLI/TUI usable and migrate it by adding API-backed data-source adapters.
- Use SQLite as the initial authoritative server store and export spreadsheets only as views.

## Non-goals

- Replacing the existing TUI with a web UI.
- Rewriting the entire repo in Go.
- Making embeddings mandatory in the first rollout.
- Auto-closing PRs or auto-merging PRs without human review.
- Building a multi-tenant SaaS platform in the first iteration.
- Making spreadsheet edits authoritative.

## Key decisions

### 1. Central server language
Use Go for the server under `/server`, but keep the current TypeScript CLI/TUI and local store.

### 2. Authoritative store
Use SQLite in WAL mode as the authoritative coordination store in phases 1-6.
Spreadsheet output is export-only.

### 3. Agent topology
Use one reasoning contract for triage, not two different analysis prompts.
Use:
- one dedicated OpenClaw triage agent for real-time and backfill item analysis
- one non-LLM backfill coordinator job in the server to enumerate history and enqueue work

A separate backfill reasoning agent is not required.

### 4. Clustering strategy
Cluster by `problem_intent`, not only by diff similarity.
Store both:
- `problem_intent`: the human problem being solved
- `solution_shape`: what the current PR or issue proposal actually does

### 5. Migration shape
Do not replace the local read model first.
Add API-backed adapters that satisfy the existing interfaces, then let the current sync and TUI flows consume the server.

## Rollout phases

### Phase 0 — Planning and scaffolding
Add OpenSpec, finalize contracts, and land the file layout.

### Phase 1 — Server skeleton and normalized storage
Add the Go module, SQLite schema, GitHub App webhook ingest, normalization, and idempotent jobs.

### Phase 2 — Auth and API
Add GitHub-backed user auth, org membership checks, server-issued sessions, change feeds, detail endpoints, and analysis ingest endpoints.

### Phase 3 — OpenClaw triage agent
Add the dedicated hook agent, skill drafts, dispatch path, and structured maintainer-analysis payloads.

### Phase 4 — Historical backfill
Add resumable backfill jobs for existing open PRs, open issues, and recent merged PRs.

### Phase 5 — Dedupe, cluster linking, and reviewer hints
Add server-side candidate generation, agent-side cluster decisions, and related-intent endpoints.

### Phase 6 — Client integration
Add API-backed data-source adapters and optional auth-enabled central sync in the current CLI/TUI.

### Phase 7 — Hardening and operator views
Add export endpoints, CSV generation, observability, retries, rate-limit handling, and rollout docs.

## Success criteria

- A new PR or issue can produce a stored triage record without manual sync.
- The system can answer “show me related intent PRs/issues” from shared stored data.
- Existing open PRs and issues can be backfilled incrementally and resume after interruption.
- The current TUI can run against central data without losing the local-first mode.
- Two clankers analyzing the same unchanged head SHA do not both need to spend tokens if one valid analysis is already stored.
- Spreadsheet output exists for operator review, but central CRUD and search do not depend on it.

## Risks

- GitHub webhook bursts may create duplicate jobs without idempotency.
- Hook ingress into OpenClaw can widen blast radius without a dedicated agent, hook token, and sandbox.
- User login for CLI/TUI becomes awkward if client secrets are assumed to live on the client.
- Global triage state would be incorrect for multiple maintainers.
- Immediate vector search adds implementation risk before deterministic dedupe signals are proven.

## Rollback

If the central mode is unstable:

- disable webhook dispatch to OpenClaw
- keep storing normalized GitHub state and raw events
- keep the existing local `gh`-backed flows as the default
- disable API-backed sync paths behind a feature flag
- continue exporting data for manual inspection while fixing the server

## Open questions explicitly resolved here

### How should existing PRs and issues be handled?
Use a server-managed backfill coordinator job plus the same triage analysis contract used for real-time items. Do not create a separate reasoning prompt unless later evidence shows backfill needs different policy.

### Spreadsheet or SQLite?
SQLite is the authoritative store. CSV/spreadsheet exports are operator views only.

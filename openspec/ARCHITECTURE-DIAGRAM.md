# Central Coordination API — Architecture Diagram

## System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              GitHub                                         │
│                                                                             │
│   PRs / Issues / Comments / Reviews / Webhooks                              │
└──────────┬──────────────────────────────────────┬───────────────────────────┘
           │ Webhooks                              │ Installation Token API
           ▼                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                     Central Server (Go, /server)                            │
│                                                                             │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐                     │
│  │  POST        │   │  Auth        │   │  Backfill    │                     │
│  │  /webhooks/  │   │  Device Flow │   │  Coordinator │                     │
│  │  github      │   │  Sessions    │   │  Resumable   │                     │
│  └──────┬───────┘   └──────────────┘   └──────┬───────┘                     │
│         │                                      │                            │
│         ▼                                      ▼                            │
│  ┌─────────────────────────────────────────────────────┐                    │
│  │              Normalize & Upsert                      │                   │
│  │  PRs, Issues, Comments, Linked Issues,               │                   │
│  │  Changed Files, Terms, Labels, Review Facts          │                   │
│  └──────────────────────┬──────────────────────────────┘                    │
│                         │                                                   │
│                         ▼                                                   │
│  ┌─────────────────────────────────────────────────────┐                    │
│  │           SQLite (WAL) + FTS5                        │                   │
│  │                                                      │                   │
│  │  github_webhook_events  │  repos                     │                   │
│  │  pull_requests          │  issues                    │                   │
│  │  item_comments          │  linked_issues             │                   │
│  │  changed_files          │  changed_file_terms        │                   │
│  │  pr_review_facts        │  maintainer_analyses       │                   │
│  │  analysis_relationships │  clusters                  │                   │
│  │  cluster_members        │  user_item_state           │                   │
│  │  jobs                   │  backfill_runs             │                   │
│  └──────────────────────┬──────────────────────────────┘                    │
│                         │                                                   │
│         ┌───────────────┼───────────────┐                                   │
│         ▼               ▼               ▼                                   │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐                         │
│  │ Job Queue  │  │ REST API   │  │ CSV Exports    │                         │
│  │ hydrate    │  │ /v1/...    │  │ triage.csv     │                         │
│  │ analyze    │  │            │  │ clusters.csv   │                         │
│  │ backfill   │  │            │  │ review-facts   │                         │
│  └─────┬──────┘  └─────┬──────┘  └────────────────┘                         │
│        │               │                                                    │
└────────┼───────────────┼────────────────────────────────────────────────────┘
         │               │
         │               │
         ▼               ▼
┌──────────────┐  ┌─────────────────────────────────────────────────────────┐
│  OpenClaw    │  │           CLI / TUI (TypeScript, /src)                   │
│  Hook Agent  │  │                                                          │
│              │  │  ┌─────────────────────┐  ┌──────────────────────────┐   │
│  maintainer- │  │  │  ApiPullRequest     │  │  Local SQLite            │   │
│  triage      │  │  │  DataSource         │  │  Read Model              │   │
│  skill       │  │  │                     │  │  (existing, preserved)   │   │
│              │  │  │  ApiIssue           │  │                          │   │
│              │  │  │  DataSource         │  │                          │   │
│              │  │  └─────────┬───────────┘  └────────────┬─────────────┘   │
│              │  │            │    sync                    │                 │
│              │  │            └──────────────►─────────────┘                 │
│              │  │                                                          │
│              │  │  ┌─────────────────────────────────────────────────┐     │
│              │  │  │  TUI Data Service                               │     │
│              │  │  │  (local-first or API-backed, user choice)       │     │
│              │  │  └─────────────────────────────────────────────────┘     │
└──────┬───────┘  └─────────────────────────────────────────────────────────┘
       │
       │  fetches context, returns analysis
       │
       ▼
┌──────────────────────────────────────────┐
│  Triage Agent Workflow                    │
│                                           │
│  1. GET /v1/context/pulls/{owner}/{r}/{n} │
│  2. Recover problem_intent                │
│  3. Describe solution_shape               │
│  4. POST /v1/analyses/candidate-search    │
│  5. Decide cluster relationships          │
│  6. POST /v1/analyses  (structured)       │
└──────────────────────────────────────────┘
```

## Authentication Flow

```
CLI/TUI                        Server                         GitHub
  │                              │                               │
  │  POST /v1/auth/device/start  │                               │
  │─────────────────────────────►│  POST /login/device/code      │
  │                              │──────────────────────────────►│
  │  { user_code, verify_uri }   │  { device_code, user_code }  │
  │◄─────────────────────────────│◄──────────────────────────────│
  │                              │                               │
  │  User opens browser,         │                               │
  │  enters code                 │                               │
  │                              │                               │
  │  POST /v1/auth/device/poll   │                               │
  │─────────────────────────────►│  POST /login/oauth/access     │
  │                              │──────────────────────────────►│
  │                              │  { user_token }               │
  │                              │◄──────────────────────────────│
  │                              │                               │
  │                              │  Check org membership         │
  │                              │──────────────────────────────►│
  │                              │◄──────────────────────────────│
  │                              │                               │
  │  { access_token,             │  Mint server session          │
  │    refresh_token }           │                               │
  │◄─────────────────────────────│                               │
  │                              │                               │
  │  Store creds (0600)          │                               │
```

## Data Flow: New PR Arrives

```
GitHub ──webhook──► Server
                      │
                      ├─► Verify signature
                      ├─► Dedupe on delivery_id
                      ├─► Upsert PR summary (normalized)
                      ├─► Enqueue hydrate job
                      │
                      │   [hydrate worker]
                      ├─► Fetch full PR data (installation token)
                      ├─► Store comments, linked issues, changed files, terms
                      ├─► Enqueue analyze job
                      │
                      │   [dispatch worker]
                      └─► POST /hooks/agent ──► OpenClaw Hook Agent
                                                    │
                                                    ├─► GET /v1/context/pulls/...
                                                    ├─► Reason: intent, solution, labels
                                                    ├─► POST /v1/analyses/candidate-search
                                                    ├─► Decide relationships
                                                    └─► POST /v1/analyses (result)
                                                            │
                                                            ▼
                                                     Server stores in
                                                     maintainer_analyses +
                                                     analysis_relationships +
                                                     clusters
```

## Rollout Phases

```
Phase 0  Planning & scaffolding (openspec)
   │
Phase 1  Server skeleton: Go module, SQLite schema, webhook ingest, normalize
   │
Phase 2  Auth (device flow), REST API, change feeds, review-fact ingest
   │
Phase 3  OpenClaw dispatch, triage skill, context endpoints, analysis ingest
   │
Phase 4  Historical backfill: resumable coordinator, skip rules
   │
Phase 5  Dedupe & clustering: candidate search, relationships, reviewer hints
   │
Phase 6  Client integration: API data sources, CLI auth, TUI central mode
   │
Phase 7  Hardening: CSV exports, metrics, logging, rollout docs
```

## Clustering Model

```
                    ┌──────────────────────────┐
                    │  Cluster                  │
                    │  "Auth session persist"   │
                    │  basis: problem_intent    │
                    └────────────┬─────────────┘
                                 │
              ┌──────────────────┼──────────────────┐
              │                  │                   │
    ┌─────────▼────────┐ ┌──────▼───────┐ ┌────────▼─────────┐
    │ PR #42            │ │ Issue #56     │ │ PR #98            │
    │ duplicate         │ │ same_problem  │ │ same_problem      │
    │                   │ │ _variant      │ │ _variant          │
    │ solution: cookie  │ │ solution: n/a │ │ solution: token   │
    │ session fix       │ │ (bug report)  │ │ refresh rewrite   │
    └───────────────────┘ └──────────────┘ └───────────────────┘

    Signals used for candidate generation:
    ├── Linked issue overlap
    ├── Changed-file-term overlap
    ├── FTS5 (title/body/problem_intent)
    ├── Label overlap
    ├── Recency
    └── [Phase 5+] Optional vector rerank
```

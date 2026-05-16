# Product

## Register

product

## Users

Core OpenClaw maintainers who work from a terminal and need to move quickly through large PR and issue queues. They are already comfortable with keyboard-first tools, GitHub review context, local indexes, and dense maintainer workflows.

## Product Purpose

`clawlens` is a local-first maintainer cockpit for OpenClaw. It syncs PR and issue metadata into SQLite, ranks and clusters maintainer work, exposes merge-readiness context, and lets maintainers triage attention state without burning unnecessary GitHub quota.

Success means maintainers can scan current work, understand why an item matters, jump into related issues or clusters, and mark local state with minimal friction. The interface should reduce queue ambiguity, not become another dashboard to manage.

## Brand Personality

Dense, calm, exact, operator-grade.

The product should feel like a focused command cockpit for maintainers: fast to scan, quiet under pressure, precise about state, and respectful of terminal workflows. It should carry enough visual hierarchy to guide decisions without hiding the raw operational facts.

## Anti-references

Do not make the TUI feel like a raw log dump, plain database browser, or unshaped table of records. Avoid onboarding-heavy dashboards, decorative terminal effects, neon/glass styling, mascot energy, or visual flair that does not help maintainer triage.

## Design Principles

- **Actionable density.** Use the terminal space for scannable decisions, not blank space or decorative framing.
- **Truthful controls.** Every visible keybinding must match exactly what the action does in the current mode and row context.
- **Progressive context.** Show enough detail to decide, then reveal deeper issue, cluster, and review context through explicit actions.
- **Quota-aware confidence.** Sync state, freshness, and rate-limit status should explain data confidence without distracting from the queue.
- **Operator calm.** Selection, warnings, and errors must be obvious, but the default surface should remain restrained and steady.

## Accessibility & Inclusion

The baseline is keyboard-first operation with strong focus and selection contrast, low flicker, readable dense labels, and clear status language for asynchronous sync and error states. The TUI should remain usable at narrow terminal sizes such as 80x24 and should avoid relying on color alone when state can also be expressed through text.

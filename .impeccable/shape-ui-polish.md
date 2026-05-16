# Shape Brief: TUI Polish

Status: confirmed

## 1. Feature Summary

Polish the `clawlens` terminal UI into a production-ready maintainer cockpit for OpenClaw PR and issue triage. The work covers the primary TUI surface: queue scanning, detail inspection, footer actions, query behavior, and narrow terminal resilience.

## 2. Primary User Action

The maintainer should quickly decide which row needs attention next, understand why it matters, and invoke the exact visible keyboard action without second guessing.

## 3. Design Direction

Color strategy: Restrained. Use the existing dark console neutrals, reserve Focus Cyan for active keyboard attention, and reserve Command Amber for command and warning surfaces.

Theme scene: A maintainer is triaging a large OpenClaw queue in a terminal on a wide monitor during a focused evening review session, with low ambient light and no tolerance for decorative noise.

Anchor references:

- Raycast command surface for keyboard trust and compact command clarity.
- Linear list density for fast scan, strong selection, and restrained metadata.
- GitHub PR sidebar for factual review context and decision support.

Visual probes: skipped because this is refinement of an existing terminal TUI, not a net-new or directionally ambiguous surface.

## 4. Scope

Fidelity: production-ready.

Breadth: whole primary TUI surface, centered on the queue, detail pane, footer, and search or command rail.

Interactivity: shipped-quality terminal interaction using the existing blessed renderer, controller, and keymap.

Time intent: polish until local targeted tests, typecheck, format, and relevant TUI behavior checks pass.

## 5. Layout Strategy

Use the full terminal height for task content. Results remain the dominant surface, with adaptive row capacity and stable scroll behavior. The detail pane should open as decision context, not as a raw data dump.

The top rail carries global confidence: active mode, repo, sync freshness, quota, and active background jobs. The middle area carries work. The bottom rail carries immediate status and current actions. The query rail must become command/help language when search input is not active or not available.

Detail content should start with identity and decision summary, then disclose linked issues, related PRs, cluster context, maintainer state, and sparse extras. Empty or low-value sections should be collapsed or omitted by default.

## 6. Key States

- Default loaded queue: rows fill the available viewport, selection is obvious, and the visible action bar matches enabled commands.
- Loading: describe what is being assembled, not just "loading".
- Empty local index: teach the next useful command without looking like onboarding marketing.
- Empty filtered search: show query-specific no-results copy and recovery action.
- Stale or rate-limited data: show confidence and quota state without stealing the whole screen.
- Error: give the failing operation and next action, with dismiss behavior when available.
- Detail focus: make focus transfer visible while keeping the selected result understandable.
- Cluster workspace: preserve seed, best base, verification state, and excluded candidate access.
- Narrow terminal: preserve core scan and command paths at 80x24, reducing secondary metadata before primary identity.

## 7. Interaction Model

Keyboard behavior is the source of truth. Visible bindings must map to the exact current action:

- `m` loads one viewport worth of additional rows.
- `V` marks only the currently visible result rows as seen.
- `v`, `w`, `i`, and `u` affect the selected PR or visible local triage state only where enabled.
- `/` is shown only where query input is available.
- `Enter`, `Tab`, `Esc`, `z`, `x`, `c`, and `e` keep their current meanings, but labels should be mode-aware.

Actions should produce immediate status or banner feedback. Disabled actions should be absent or visibly inactive, never presented as live commands.

## 8. Content Requirements

Use short operational labels. Prefer "PRs loaded", "visible rows", "cluster", "linked issues", "quota", and "freshness" over vague UI terms.

Rows need stable fields: kind, id, score or state, freshness or age, compact context counts, and title. Detail sections need concise headers and should avoid repeating zero counts when they do not help a decision.

URLs and long metadata should be secondary. The first detail screen should prioritize review decision context over raw links.

## 9. Recommended References

- `spatial-design.md` for the pane hierarchy and terminal space usage.
- `typography.md` for dense monospace hierarchy.
- `interaction-design.md` for keyboard-state truthfulness.
- `ux-writing.md` for footer, empty, loading, and error copy.
- `color-and-contrast.md` for focus and semantic color discipline.
- `responsive-design.md` for narrow terminal behavior.
- `polish.md` for the final visual and interaction pass.

## 10. Open Questions

- Confirm whether empty detail sections may be omitted instead of showing `(none)`.
- Confirm whether the query rail may become a command rail outside search modes.
- Confirm whether narrow terminal mode may hide lower-priority metadata before truncating titles.

## 11. Follow-up Task List

- [x] Use viewport height for initial row loading and `m` pagination.
- [x] Make `V` mark only the currently visible result rows.
- [x] Split the bottom rail into command vs query state.
- [x] Omit empty low-value detail sections.
- [x] Distill the visible action rail so only primary enabled actions compete for attention.
- [x] Keep `Linked Issues` visible only when the selected row has linked issues.
- [x] Reorder PR detail so decision context appears before raw metadata.

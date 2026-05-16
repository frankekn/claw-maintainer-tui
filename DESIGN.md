---
name: clawlens
description: Local-first OpenClaw maintainer cockpit for terminal triage.
colors:
  screen-bg: "#071018"
  text: "#e7edf5"
  muted-text: "#9fb0c4"
  dim-text: "#73859b"
  header-bg: "#0d1823"
  panel-bg: "#0a121b"
  footer-bg: "#101923"
  footer-accent-bg: "#172433"
  command-bg: "#b88628"
  command-active-bg: "#dca13a"
  command-text: "#091018"
  border: "#293948"
  border-soft: "#1a2835"
  focus: "#63c8ff"
  ok: "#4fd1a1"
  warn: "#dca13a"
  error: "#ef6b73"
  neutral-badge: "#8ea2b8"
  modal-bg: "#12202b"
typography:
  body:
    fontFamily: "terminal monospace"
    fontWeight: 400
  label:
    fontFamily: "terminal monospace"
    fontWeight: 700
spacing:
  row: "1 terminal row"
  chrome: "1 terminal row"
  panel-padding-x: "1 terminal column"
rounded: {}
components:
  badge-focus:
    backgroundColor: "{colors.focus}"
    textColor: "{colors.command-text}"
  badge-warn:
    backgroundColor: "{colors.warn}"
    textColor: "{colors.command-text}"
  selected-row:
    backgroundColor: "{colors.focus}"
    textColor: "{colors.command-text}"
  panel:
    backgroundColor: "{colors.panel-bg}"
---

# Design System: clawlens

## 1. Overview

**Creative North Star: "Maintainer Flight Deck"**

`clawlens` is a dense terminal cockpit for maintainers who need to turn a large OpenClaw queue into ordered action. The design system favors operational trust: stable chrome, compact status language, strong selection, and progressively revealed detail.

The interface should not feel like a raw log dump or an unshaped SQLite table. It keeps terminal-native constraints, but adds just enough product hierarchy for maintainers to know what is selected, what is stale, what is actionable, and which key will move the workflow forward.

**Key Characteristics:**

- Dark, low-glare terminal surface for long maintainer sessions.
- Focus blue reserved for active mode, selected rows, and keyboard focus.
- Amber reserved for command surfaces, warnings, and sync attention.
- Green, red, and muted neutrals used only for status semantics.
- Dense monospace tables with explicit keyboard affordances.

## 2. Colors

The palette is restrained and state-rich: cool dark surfaces, one bright focus accent, one amber command/warning accent, and semantic success/error colors.

### Primary

- **Focus Cyan** (`#63c8ff`): Active mode, selected row, focused panel border, and current keyboard target.

### Secondary

- **Command Amber** (`#b88628` / `#dca13a`): Query bar, action labels, warnings, and sync attention states.

### Neutral

- **Deep Console Background** (`#071018`): Overall terminal backdrop.
- **Panel Navy** (`#0a121b`): Results and detail pane bodies.
- **Header Navy** (`#0d1823`): Top status rail.
- **Footer Navy** (`#101923`): Bottom status and action rail.
- **Primary Text** (`#e7edf5`): Main readable content.
- **Muted Text** (`#9fb0c4`): Secondary labels and inactive tab text.
- **Dim Text** (`#73859b`): Help text, examples, and lower-priority metadata.
- **Border Blue Gray** (`#293948`): Standard panel borders.
- **Soft Border Blue Gray** (`#1a2835`): Inactive panel borders and subdued row backgrounds.

### Named Rules

**The Focus Rarity Rule.** Focus Cyan appears only where keyboard attention is active or selection matters. Do not use it as decoration.

**The Amber Means Command Rule.** Amber is for command/query surfaces and warning-like status. Do not use it for inactive decoration.

**The No Raw Dump Rule.** Tables may be dense, but state must be grouped, labeled, and visually prioritized.

## 3. Typography

**Display Font:** terminal monospace
**Body Font:** terminal monospace
**Label/Mono Font:** terminal monospace

**Character:** Terminal-native, exact, and compact. Hierarchy comes from color, casing, badges, and row placement rather than font changes.

### Hierarchy

- **Title** (bold, uppercase in panel labels): Current pane or detail identity.
- **Body** (regular): PR titles, issue titles, summaries, and detail prose.
- **Label** (bold or muted): Column headers, section labels, key names, status prefixes.
- **Metadata** (muted or dim): Authors, timestamps, examples, counts, and low-priority hints.

### Named Rules

**The One Row Label Rule.** Chrome labels and action hints should fit in one terminal row. Long explanations belong in detail or help.

## 4. Elevation

`clawlens` uses tonal layering and borders, not shadows. Depth is conveyed through background steps, active border color, badge fills, and selected row fill.

### Named Rules

**The Flat Console Rule.** Panels are flat at rest. Focus and selection create depth through color changes, never through decorative effects.

## 5. Components

### Badges

- **Shape:** square terminal text chip with one leading and trailing space.
- **Primary:** Focus Cyan background with Command Text foreground for active mode.
- **Status:** Green for healthy/fresh state, Amber for warning/sync state, Red for errors, Neutral Badge for passive metadata.
- **Rule:** Badges must carry short state, not prose.

### Tabs

- **Style:** compact text chips in a single top row.
- **Active:** Amber or Focus Cyan depending on whether results focus is active.
- **Inactive:** Muted text over soft border background.

### Panels

- **Shape:** line border, no rounded corners.
- **Background:** Panel Navy.
- **Focus:** Focus Cyan border.
- **Inactive:** Border Blue Gray or Soft Border Blue Gray.
- **Internal Padding:** one terminal column left and right.

### Results Rows

- **Default:** two-column prefix plus fixed-width metadata and truncated title.
- **Selected:** Focus Cyan background with Command Text foreground.
- **Unfocused Selection:** Soft Border Blue Gray background with Primary Text foreground.
- **Rule:** Selection must remain obvious in screenshots and while detail focus is active.

### Detail Sections

- **Style:** Amber uppercase section labels.
- **Disclosure:** Empty or low-value sections should be collapsed or omitted by default.
- **Rule:** Detail starts with decision summary, then deeper context.

### Query And Command Rail

- **Search Modes:** Query rail is an input surface.
- **Browse Modes:** Query rail becomes command/help text, not a fake input.
- **Rule:** The bottom rail must never imply typing is available where `/` search is disabled.

## 6. Do's and Don'ts

### Do:

- **Do** use Focus Cyan only for active keyboard attention, selected rows, and focused panel borders.
- **Do** keep row density high when it improves maintainer scanning.
- **Do** make keybinding labels match the exact current action.
- **Do** hide, collapse, or de-emphasize zero-value detail sections.
- **Do** preserve readability at 80x24 and at wide desktop terminal sizes.

### Don't:

- **Don't** make the TUI feel like a raw log dump or plain database browser.
- **Don't** add decorative neon, glass, gradients, icons, mascots, or motion.
- **Don't** show a fake query prompt in browse-only modes.
- **Don't** let inactive actions visually compete with active actions.
- **Don't** use color alone when text can make state explicit.

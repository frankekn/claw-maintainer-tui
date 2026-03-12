export const TUI_THEME = {
  layout: {
    headerHeight: 1,
    footerHeight: 1,
    queryHeight: 1,
    navWidth: 14,
    resultsLeft: 14,
    resultsWidth: "42%",
    detailLeft: "52%",
    detailWidth: "48%",
  },
  colors: {
    screenBg: "#071018",
    text: "#e7edf5",
    mutedText: "#9fb0c4",
    dimText: "#73859b",
    headerBg: "#0d1823",
    panelBg: "#0a121b",
    footerBg: "#101923",
    footerAccentBg: "#172433",
    commandBg: "#b88628",
    commandActiveBg: "#dca13a",
    commandText: "#091018",
    border: "#293948",
    borderSoft: "#1a2835",
    focus: "#63c8ff",
    ok: "#4fd1a1",
    warn: "#dca13a",
    error: "#ef6b73",
    neutralBadge: "#8ea2b8",
    modalBg: "#12202b",
  },
} as const;

type BadgeTone = "neutral" | "ok" | "warn" | "error" | "focus";
type TextTone = "primary" | "muted" | "dim" | "accent" | "ok" | "warn" | "error";

function wrap(text: string, ...styles: string[]): string {
  return `${styles.map((style) => `{${style}}`).join("")}${text}{/}`;
}

function fg(tone: TextTone): string {
  switch (tone) {
    case "muted":
      return `${TUI_THEME.colors.mutedText}-fg`;
    case "dim":
      return `${TUI_THEME.colors.dimText}-fg`;
    case "accent":
      return `${TUI_THEME.colors.warn}-fg`;
    case "ok":
      return `${TUI_THEME.colors.ok}-fg`;
    case "warn":
      return `${TUI_THEME.colors.warn}-fg`;
    case "error":
      return `${TUI_THEME.colors.error}-fg`;
    default:
      return `${TUI_THEME.colors.text}-fg`;
  }
}

function badgeColors(tone: BadgeTone): { fg: string; bg: string } {
  switch (tone) {
    case "ok":
      return { fg: TUI_THEME.colors.commandText, bg: TUI_THEME.colors.ok };
    case "warn":
      return { fg: TUI_THEME.colors.commandText, bg: TUI_THEME.colors.warn };
    case "error":
      return { fg: TUI_THEME.colors.text, bg: TUI_THEME.colors.error };
    case "focus":
      return { fg: TUI_THEME.colors.commandText, bg: TUI_THEME.colors.focus };
    default:
      return { fg: TUI_THEME.colors.commandText, bg: TUI_THEME.colors.neutralBadge };
  }
}

export function badge(text: string, tone: BadgeTone): string {
  const colors = badgeColors(tone);
  return wrap(` ${text} `, `${colors.fg}-fg`, `${colors.bg}-bg`, "bold");
}

export function text(textValue: string, tone: TextTone = "primary"): string {
  return wrap(textValue, fg(tone));
}

export function section(textValue: string): string {
  return wrap(textValue.toUpperCase(), fg("accent"), "bold");
}

export function keyLabel(textValue: string): string {
  return wrap(textValue, fg("accent"), "bold");
}

export function panelLabel(textValue: string, active = false): string {
  if (active) {
    return wrap(
      ` ${textValue} `,
      `${TUI_THEME.colors.commandText}-fg`,
      `${TUI_THEME.colors.focus}-bg`,
      "bold",
    );
  }
  return wrap(` ${textValue} `, fg("muted"));
}

export function selectedLine(textValue: string, active = true): string {
  if (active) {
    return wrap(
      textValue,
      `${TUI_THEME.colors.commandText}-fg`,
      `${TUI_THEME.colors.focus}-bg`,
      "bold",
    );
  }
  return wrap(textValue, `${TUI_THEME.colors.focus}-fg`, "bold");
}

export function valueTone(textValue: string, tone: "ok" | "warn" | "error" | "muted"): string {
  return text(textValue, tone === "muted" ? "muted" : tone);
}

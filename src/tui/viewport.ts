import { TUI_THEME } from "./theme.js";

export const MIN_RESULT_VIEWPORT_ROWS = 20;

const PANEL_BORDER_ROWS = 2;
const TABLE_HEADER_ROWS = 1;

export function calculateResultViewportRows(screenRows: number): number {
  const bodyRows =
    screenRows -
    TUI_THEME.layout.headerHeight -
    TUI_THEME.layout.tabsHeight -
    TUI_THEME.layout.footerHeight -
    TUI_THEME.layout.queryHeight;
  const dataRows = bodyRows - PANEL_BORDER_ROWS - TABLE_HEADER_ROWS;
  return Math.max(MIN_RESULT_VIEWPORT_ROWS, Math.floor(dataRows));
}

export function visibleRowRange(params: {
  rowCount: number;
  selectedIndex: number;
  viewportRows: number;
}): { start: number; end: number } {
  const { rowCount, selectedIndex, viewportRows } = params;
  if (rowCount <= 0) {
    return { start: 0, end: 0 };
  }
  const visibleRows = Math.max(1, viewportRows);
  const maxStart = Math.max(0, rowCount - visibleRows);
  const start = Math.min(maxStart, Math.max(0, selectedIndex - 4));
  return { start, end: Math.min(rowCount, start + visibleRows) };
}

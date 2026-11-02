// The Flow Board's sizes (1100 px and wider; owner's report on 0.26.0, 2026-11-02): the chart
// board's width beside the code board, and the output's width when it stands beside the code
// inside the code board. Pure arithmetic, in CSS pixels of the boards' row (the canvas less its
// 16 px edges); layout.ts measures and applies it.
//
// The code keeps CODE_MIN (its head, the tabs and about 50 columns of code at 14 px) and the chart
// CHART_MIN (a decision with both branches at full size). The output beside the code keeps
// CONSOLE_MIN (a line of output and the console's tabs and tools); when the code board can't keep
// the code and the output side by side, the output goes back below the code.
export const CODE_MIN = 420;
export const CHART_MIN = 320;
export const CONSOLE_MIN = 320;
/** The canvas between the two boards: the board splitter's column. */
export const BOARD_GAP = 16;
/** The board's ground between the code and the output beside it: the output splitter's column. */
export const CONSOLE_GAP = 8;

/** What the code board keeps at the least: the code, or the code and the output beside it. */
export const codeKeep = (beside: boolean): number => (beside ? CODE_MIN + CONSOLE_GAP + CONSOLE_MIN : CODE_MIN);

/** Two equal boards in a row `boards` px wide. */
export const chartDefault = (boards: number): number => Math.round((boards - BOARD_GAP) / 2);

/** The widest chart board that leaves the code board its least. */
export const chartMax = (boards: number, beside: boolean): number => boards - BOARD_GAP - codeKeep(beside);

/**
 * Whether the output stands beside the code: asked for, and room for it with the chart board (when
 * shown) at its least.
 */
export function besideNow(wanted: boolean, boards: number, chartShown: boolean): boolean {
  if (!wanted) return false;
  const code = chartShown ? boards - BOARD_GAP - CHART_MIN : boards;
  return code >= codeKeep(true);
}

/** The widest output beside the code in a code board `code` px wide. */
export const consoleMax = (code: number): number => code - CONSOLE_GAP - CODE_MIN;

/** The output's first width beside the code: 40 percent of the code board, never under its least. */
export const consoleDefault = (code: number): number => Math.max(CONSOLE_MIN, Math.round((code - CONSOLE_GAP) * 0.4));

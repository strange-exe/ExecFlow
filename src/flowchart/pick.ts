// The chart a page asks for: a function named with its occurrence, since C++ overloads and Python
// redefinitions share a name (attack pass, milestone 5). Shared by the adapters (which chart only
// the picked function) and the worker's layout step (picked.ts).

/** The nth chart (from 0) whose function has this name. */
export type Pick = { name: string; nth: number };

/** The chart a pick names; the entry point (0) when there is no pick or the function is gone. */
export function pickIndex(charts: readonly { name: string }[], pick: Pick | null): number {
  if (!pick) return 0;
  let seen = 0;
  for (const [i, c] of charts.entries()) {
    if (c.name !== pick.name) continue;
    if (seen === pick.nth) return i;
    seen++;
  }
  return 0;
}

/** The pick that names chart `index`. */
export function pickOf(charts: readonly { name: string }[], index: number): Pick {
  const name = charts[index].name;
  return { name, nth: charts.slice(0, index).filter((c) => c.name === name).length };
}

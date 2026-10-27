// The picked chart's layout, made in the flowchart worker, not on the page: a long ladder of breaks
// and continues can take most of a second to route (attack pass, milestone 5), and the page redraws
// 300 ms after every pause in typing. Only the picked function is charted (pick.ts).
import { layoutChart, type Layout } from "./layout";
import { TooBig, type ChartResult, type FlowFile } from "./model";
import { pickIndex, type Pick } from "./pick";

export { pickIndex, pickOf, type Pick } from "./pick";

/** Lays out the picked chart. Past the layout's budget or `deadline` (performance.now() ms) that chart becomes "too big". */
export function layOutPicked(file: FlowFile, pick: Pick | null, deadline = Infinity): { file: FlowFile; picked: number; layout: Layout | null } {
  const picked = pickIndex(file.charts, pick);
  const chart = file.charts[picked];
  if (!chart?.ok) return { file, picked, layout: null };
  try {
    return { file, picked, layout: layoutChart(chart, { deadline }) };
  } catch (e) {
    if (!(e instanceof TooBig)) throw e;
    const tooBig: ChartResult = { ok: false, name: chart.name, from: chart.from, to: chart.to, tooBig: e.message };
    return { file: { ...file, charts: file.charts.map((c, i) => (i === picked ? tooBig : c)) }, picked, layout: null };
  }
}

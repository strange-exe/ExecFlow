// The panel's height when the Flowchart tab opens (owner, 2026-10-26): grown to CHART_PANEL percent
// if it is shorter, never shrunk, and never so tall that the editor's row loses its EDITOR_KEEP px.
import { describe, expect, it } from "vitest";
import { CHART_PANEL, chartPanelSize, EDITOR_KEEP } from "./panel-size";

describe("chartPanelSize", () => {
  it("grows a small panel to CHART_PANEL percent", () => {
    expect(CHART_PANEL).toBe(55);
    expect(chartPanelSize(35, 800)).toBe(55);
    expect(chartPanelSize(15, 800)).toBe(55);
  });

  it("changes nothing at or above the threshold, and never shrinks", () => {
    expect(chartPanelSize(55, 800)).toBeNull();
    expect(chartPanelSize(70, 800)).toBeNull();
    expect(chartPanelSize(80, 800)).toBeNull();
  });

  it("keeps the editor's row at least EDITOR_KEEP px in a short column", () => {
    // 360 px: 55% would leave the editor 162 px; it grows only as far as leaves it 220 (38%).
    expect(chartPanelSize(35, 360)).toBe(Math.floor(((360 - EDITOR_KEEP) / 360) * 100));
    expect(chartPanelSize(35, 360)).toBe(38);
    // So short that even the current size leaves less: nothing changes (never shrinks).
    expect(chartPanelSize(35, 300)).toBeNull();
  });

  it("an unmeasured column (0 px, not laid out yet) uses the plain threshold", () => {
    expect(chartPanelSize(35, 0)).toBe(55);
  });
});

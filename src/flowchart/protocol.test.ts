import { describe, expect, it } from "vitest";
import { isRequest } from "./protocol";

describe("flowchart worker requests", () => {
  it("accepts a chart request for C, C++ or Python, with or without a picked function", () => {
    for (const language of ["c", "cpp", "python"]) expect(isRequest({ type: "chart", id: 1, language, source: "x", pick: null })).toBe(true);
    expect(isRequest({ type: "chart", id: 1, language: "cpp", source: "x", pick: { name: "f", nth: 1 } })).toBe(true);
  });

  it("refuses anything else", () => {
    const bad = [
      null,
      "chart",
      { type: "chart", id: 1, language: "javascript", source: "x", pick: null },
      { type: "chart", id: 1, language: "__proto__", source: "x", pick: null },
      { type: "chart", id: 1, language: "toString", source: "x", pick: null },
      { type: "chart", id: "1", language: "c", source: "x", pick: null },
      { type: "chart", id: 1.5, language: "c", source: "x", pick: null },
      { type: "chart", id: 1, language: "c", source: 42, pick: null },
      { type: "run", id: 1, language: "c", source: "x", pick: null },
      // The pick: present, null or a name with its occurrence.
      { type: "chart", id: 1, language: "c", source: "x" },
      { type: "chart", id: 1, language: "c", source: "x", pick: "main" },
      { type: "chart", id: 1, language: "c", source: "x", pick: { name: 1, nth: 0 } },
      { type: "chart", id: 1, language: "c", source: "x", pick: { name: "f", nth: -1 } },
      { type: "chart", id: 1, language: "c", source: "x", pick: { name: "f", nth: 0.5 } },
    ];
    for (const msg of bad) expect(isRequest(msg), JSON.stringify(msg)).toBe(false);
  });
});

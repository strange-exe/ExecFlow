import { describe, expect, it } from "vitest";
import { isRequest } from "./protocol";

describe("flowchart worker requests", () => {
  it("accepts a chart request for C, C++ or Python", () => {
    for (const language of ["c", "cpp", "python"]) expect(isRequest({ type: "chart", id: 1, language, source: "x" })).toBe(true);
  });

  it("refuses anything else", () => {
    const bad = [
      null,
      "chart",
      { type: "chart", id: 1, language: "javascript", source: "x" },
      { type: "chart", id: 1, language: "__proto__", source: "x" },
      { type: "chart", id: 1, language: "toString", source: "x" },
      { type: "chart", id: "1", language: "c", source: "x" },
      { type: "chart", id: 1.5, language: "c", source: "x" },
      { type: "chart", id: 1, language: "c", source: 42 },
      { type: "run", id: 1, language: "c", source: "x" },
    ];
    for (const msg of bad) expect(isRequest(msg), JSON.stringify(msg)).toBe(false);
  });
});

// The About page's hero program (redesign 9, "Living Graph"): sum_evens in Python, C and C++, its
// flowchart's nodes, and the trace of one run that drives every count and animation on the page.
import { describe, expect, it } from "vitest";
import { EDGES, LANGS, LANG_ORDER, LAST, NODES, OUTPUT, STATES, TRACE, labelsOf, nodeOfLine, readout, runLabel, sourceOf, springStep, stepFor, tabFor } from "./living-graph";

const BS = String.fromCharCode(92);

describe("the trace of one run", () => {
  it("visits the nodes in the brief's order: 20 visits, 19 steps", () => {
    expect(TRACE.map((v) => v.id)).toEqual([
      "start", "init",
      "loop", "test",
      "loop", "test", "add",
      "loop", "test",
      "loop", "test", "add",
      "loop", "test",
      "loop", "test", "add",
      "loop", "out", "end",
    ]);
    expect(LAST).toBe(19);
  });

  it("ends with the pass counts start 1, init 1, loop 7, test 6, add 3, out 1, end 1", () => {
    expect(STATES[LAST].counts).toEqual({ start: 1, init: 1, loop: 7, test: 6, add: 3, out: 1, end: 1 });
    expect(NODES.map((id) => STATES[LAST].counts[id])).toEqual([1, 1, 7, 6, 3, 1, 1]);
  });

  it("takes test>add 3 times, test>loop 3 times and loop>out once; every edge of the chart is taken by the end", () => {
    const edges = STATES[LAST].edges;
    expect(edges["test>add"]).toBe(3);
    expect(edges["test>loop"]).toBe(3);
    expect(edges["loop>out"]).toBe(1);
    expect(Object.keys(edges).sort()).toEqual([...EDGES].sort());
    expect(Object.values(edges).reduce((a, b) => a + b, 0)).toBe(LAST);
  });

  it("prints 12, and only once the program reaches print(total)", () => {
    expect(OUTPUT).toBe("12");
    expect(STATES.map((s) => s.printed)).toEqual(TRACE.map((_, k) => k >= LAST - 1));
    expect(TRACE[LAST - 1]).toMatchObject({ id: "out", total: 12 });
  });

  it("keeps total and n step by step: total 2, 6, then 12; n unset before the loop", () => {
    expect(STATES[0]).toMatchObject({ n: null, total: 0, cur: "start", last: null });
    expect(TRACE.filter((v) => v.id === "add").map((v) => v.total)).toEqual([2, 6, 12]);
    expect(STATES[6]).toMatchObject({ cur: "add", n: 2, total: 2, last: "test>add" });
  });

  it("step 0 is the first visit: Start has run once, nothing else has, and no edge is taken", () => {
    expect(STATES[0].counts).toEqual({ start: 1 });
    expect(STATES[0].edges).toEqual({});
    expect(STATES[0].printed).toBe(false);
    // Each step adds one visit: the counts at step k add up to k + 1.
    STATES.forEach((st, k) => expect(Object.values(st.counts).reduce((a, b) => a + (b ?? 0), 0)).toBe(k + 1));
  });

  it("reads out the step as 00/19 at the start and 19/19 at the end", () => {
    expect(readout(0)).toEqual({ step: "00", of: "19", n: "not set", total: "0" });
    expect(readout(LAST)).toEqual({ step: "19", of: "19", n: "6", total: "12" });
  });
});

describe("the stepper's keys", () => {
  it("ArrowRight and ArrowLeft step one, Home and End jump to the ends", () => {
    expect(stepFor("ArrowRight", 0)).toBe(1);
    expect(stepFor("ArrowLeft", 5)).toBe(4);
    expect(stepFor("Home", 7)).toBe(0);
    expect(stepFor("End", 7)).toBe(LAST);
  });

  it("does nothing past either end or for other keys", () => {
    expect(stepFor("ArrowRight", LAST)).toBeNull();
    expect(stepFor("ArrowLeft", 0)).toBeNull();
    expect(stepFor("Home", 0)).toBeNull();
    expect(stepFor("End", LAST)).toBeNull();
    expect(stepFor("Enter", 3)).toBeNull();
    expect(stepFor("a", 3)).toBeNull();
  });

  it("the Run button names what a press does", () => {
    expect(runLabel(true, 4)).toBe("Pause");
    expect(runLabel(false, 0)).toBe("Run");
    expect(runLabel(false, 4)).toBe("Resume");
    expect(runLabel(false, LAST)).toBe("Run again");
  });
});

describe("the 01 / 03 switcher", () => {
  it("lists Python, C and C++ in that order, numbered 01 to 03", () => {
    expect(LANG_ORDER.map((id) => [LANGS[id].idx, LANGS[id].name, LANGS[id].file])).toEqual([
      ["01", "Python", "sum_evens.py"],
      ["02", "C", "sum_evens.c"],
      ["03", "C++", "sum_evens.cpp"],
    ]);
  });

  it("arrow keys move round the tabs; Home and End go to the first and last", () => {
    expect(tabFor("ArrowRight", 0, 3)).toBe(1);
    expect(tabFor("ArrowRight", 2, 3)).toBe(0);
    expect(tabFor("ArrowLeft", 0, 3)).toBe(2);
    expect(tabFor("Home", 2, 3)).toBe(0);
    expect(tabFor("End", 0, 3)).toBe(2);
    expect(tabFor("Enter", 1, 3)).toBeNull();
  });

  it("the Python source is the brief's program, exactly", () => {
    expect(sourceOf(LANGS.py)).toBe(["total = 0", "for n in range(1, 7):", "    if n % 2 == 0:", "        total += n", "print(total)", ""].join("\n"));
  });

  it("the C source is a real C program printing the total with printf", () => {
    expect(sourceOf(LANGS.c)).toBe(
      [
        "#include <stdio.h>",
        "",
        "int main(void) {",
        "    int total = 0;",
        "    for (int n = 1; n < 7; n++)",
        "        if (n % 2 == 0)",
        "            total += n;",
        `    printf("%d${BS}n", total);`,
        "    return 0;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("the C++ source prints with std::cout", () => {
    expect(sourceOf(LANGS.cpp)).toBe(
      [
        "#include <iostream>",
        "",
        "int main() {",
        "    int total = 0;",
        "    for (int n = 1; n < 7; n++)",
        "        if (n % 2 == 0)",
        "            total += n;",
        `    std::cout << total << '${BS}n';`,
        "    return 0;",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("each node's label is the code of its line, and its line maps back to the node", () => {
    expect(labelsOf(LANGS.py)).toEqual({ start: "Start", init: "total = 0", loop: "for n in range(1, 7)", test: "n % 2 == 0", add: "total += n", out: "print(total)", end: "End" });
    expect(labelsOf(LANGS.c)).toMatchObject({ init: "int total = 0;", loop: "for (int n = 1; n < 7; n++)", test: "n % 2 == 0", add: "total += n;", out: `printf("%d${BS}n", total);` });
    expect(labelsOf(LANGS.cpp)).toMatchObject({ out: `std::cout << total << '${BS}n';` });
    for (const id of LANG_ORDER) {
      const L = LANGS[id];
      for (const [node, line] of Object.entries(L.map)) expect(nodeOfLine(L, line), `${id} line ${line}`).toBe(node);
      expect(nodeOfLine(L, 1 + L.lines.length)).toBeNull();
    }
    // Python: init=line 1, loop=2, test=3, add=4, out=5 (the brief).
    expect(LANGS.py.map).toEqual({ init: 1, loop: 2, test: 3, add: 4, out: 5 });
  });
});

describe("a nudged node's spring", () => {
  const nudged = () => ({ x: 18, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 });
  const settle = (frame: number) => {
    const o = nudged();
    let t = 0;
    while (!springStep(o, frame) && t < 5) t += frame;
    return { o, t };
  };

  it("comes home in the same time, at rest, whatever the frame rate (a slow page doesn't slow it)", () => {
    const smooth = settle(1 / 60);
    const janky = settle(0.25);
    expect(smooth.o).toEqual({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 });
    expect(janky.o).toEqual({ x: 0, y: 0, vx: 0, vy: 0, tx: 0, ty: 0 });
    expect(smooth.t).toBeLessThan(1);
    expect(janky.t).toBeLessThanOrEqual(smooth.t + 0.25);
  });

  it("one long frame does not throw the node off: it stays within its reach", () => {
    const o = nudged();
    springStep(o, 0.5);
    expect(Math.abs(o.x)).toBeLessThanOrEqual(18);
  });

  it("a frame stamped before the last one changes nothing", () => {
    const o = nudged();
    expect(springStep(o, -0.01)).toBe(false);
    expect(o).toEqual(nudged());
  });
});

/// <reference types="node" />
// The adapters on fixtures (src/flowchart/fixtures/), parsed by the real tree-sitter runtime and
// grammars: each chart is compared box by box and edge by edge, then checked against the model's
// invariants. Box ids follow reading order.
import { describe, expect, it } from "vitest";
import { ONE_STEP } from "./model";
import { chartFile, edgesOf, expectInvariants, fixture, nodesOf, ok, withPack } from "./fixtures/harness";
import type { FlowLanguage } from "./pack";

const test = withPack ? it : it.skip;

async function charts(language: FlowLanguage, name: string) {
  const file = await chartFile(language, fixture(name));
  for (const c of file.charts) if (c.ok) expectInvariants(c);
  return file;
}

describe("C adapter", () => {
  test("merges up to three simple statements into one box, each line still mapped", async () => {
    const file = await charts("c", "sequence.c");
    expect(file.syntaxError).toBeUndefined();
    const main = ok(file.charts[0]);
    expect(main.name).toBe("main");
    expect(nodesOf(main)).toEqual([
      "0 start Start",
      "1 process int a = 1; int b = 2; int c = a + b",
      "2 process int d = c * 2",
      '3 io printf("%d", d)',
      "4 end return 0",
    ]);
    expect(edgesOf(main)).toEqual(["0->1", "1->2", "2->3", "3->4"]);
    expect(main.nodes[1].parts.map((p) => [p.from, p.to])).toEqual([[3, 3], [4, 4], [5, 5]]);
    expect(main.nodes[1].label).toEqual(["int a = 1", "int b = 2", "int c = a + b"]);
    expect([main.nodes[1].from, main.nodes[1].to]).toEqual([3, 5]);
  });

  test("if / else if / else", async () => {
    const main = ok((await charts("c", "else-if.c")).charts[0]);
    expect(nodesOf(main)).toEqual([
      "0 start Start",
      "1 process int n",
      '2 io scanf("%d", &n)',
      "3 decision n > 0 ?",
      '4 io printf("positive")',
      "5 decision n < 0 ?",
      '6 io printf("negative")',
      '7 io printf("zero")',
      "8 end return 0",
    ]);
    expect(edgesOf(main)).toEqual(["0->1", "1->2", "2->3", "3->4 Yes", "3->5 No", "4->8", "5->6 Yes", "5->7 No", "6->8", "7->8"].sort());
  });

  test("nested loops: for's init, test and update are their own boxes", async () => {
    const main = ok((await charts("c", "nested-loops.c")).charts[0]);
    expect(nodesOf(main)).toEqual([
      "0 start Start",
      "1 process int total = 0",
      "2 process int i = 0",
      "3 decision i < 3 ?",
      "4 process int j = 0",
      "5 decision j < i ?",
      "6 process total += j; j++",
      "7 process i++",
      "8 end return total",
    ]);
    expect(edgesOf(main)).toEqual(
      ["0->1", "1->2", "2->3", "3->4 Yes", "4->5", "5->6 Yes", "6->5 (back)", "5->7 No", "7->3 (back)", "3->8 No"].sort(),
    );
  });

  test("do-while and for (;;) with a break", async () => {
    const main = ok((await charts("c", "do-forever.c")).charts[0]);
    expect(nodesOf(main)).toEqual(["0 start Start", "1 process int n = 5", "2 process n--", "3 decision n > 0 ?", "4 process n++", "5 decision n == 3 ?", "6 end return 0"]);
    expect(edgesOf(main)).toEqual(["0->1", "1->2", "2->3", "3->2 Yes (back)", "3->4 No", "4->5", "5->4 No (back)", "5->6 Yes (jump)"].sort());
  });

  test("switch: stacked cases, fall-through and default", async () => {
    const main = ok((await charts("c", "switch.c")).charts[0]);
    expect(nodesOf(main)).toEqual([
      "0 start Start",
      "1 process int day = 2",
      "2 decision day ?",
      '3 io printf("weekend")',
      '4 io printf("monday")',
      '5 io printf("work")',
      '6 io printf("other")',
      "7 end return 0",
    ]);
    expect(edgesOf(main)).toEqual(["0->1", "1->2", "2->3 1, 7", "2->4 2", "2->5 3", "4->5", "2->6 default", "3->7", "5->7", "6->7"].sort());
  });

  test("a switch without default gets an implicit default edge", async () => {
    const src = "int main(void) {\n  int x = 1;\n  switch (x) {\n  case 1:\n    x = 2;\n    break;\n  }\n  return x;\n}\n";
    const main = ok((await chartFile("c", src)).charts[0]);
    expectInvariants(main);
    expect(edgesOf(main)).toEqual(["0->1", "1->2", "2->3 1", "2->4 default", "3->4"].sort());
  });

  test("break and continue in nested loops", async () => {
    const main = ok((await charts("c", "break-continue.c")).charts[0]);
    expect(nodesOf(main)).toEqual([
      "0 start Start",
      "1 process int count = 0",
      "2 process int i = 0",
      "3 decision i < 5 ?",
      "4 decision i == 1 ?",
      "5 process int j = 0",
      "6 decision j < 5 ?",
      "7 decision j > i ?",
      "8 process count++",
      "9 process j++",
      "10 process i++",
      "11 end return count",
    ]);
    expect(edgesOf(main)).toEqual(
      [
        "0->1", "1->2", "2->3", "3->4 Yes", "4->10 Yes (jump)", "4->5 No", "5->6", "6->7 Yes", "7->10 Yes (jump)", "7->8 No",
        "8->9", "9->6 (back)", "6->10 No", "10->3 (back)", "3->11 No",
      ].sort(),
    );
  });

  test("early return; a call to a function in the same file; code after return is reported unreachable", async () => {
    const file = await charts("c", "early-return.c");
    expect(file.charts.map((c) => c.name)).toEqual(["main", "find"]);
    const main = ok(file.charts[0]);
    expect(nodesOf(main)).toEqual([
      "0 start Start",
      "1 process int a[3] = {1, 2, 3}",
      "2 call int at = find(a, 3, 2) -> find",
      "3 end return at",
      "4 process at = 0",
      "5 end End",
    ]);
    expect(main.unreachable).toEqual([4, 5]);
    const find = ok(file.charts[1]);
    expect(nodesOf(find)).toEqual(["0 start Start", "1 process int i = 0", "2 decision i < n ?", "3 decision a[i] == x ?", "4 end return i", "5 process i++", "6 end return -1"]);
    expect(edgesOf(find)).toEqual(["0->1", "1->2", "2->3 Yes", "3->4 Yes", "3->5 No", "5->2 (back)", "2->6 No"].sort());
    expect([find.from, find.to]).toEqual([1, 8]);
  });

  test("goto: connectors with the label's name", async () => {
    const main = ok((await charts("c", "goto.c")).charts[0]);
    expect(nodesOf(main)).toEqual([
      "0 start Start",
      "1 process int i = 0",
      "2 connector again",
      "3 process i++",
      "4 decision i < 3 ?",
      "5 connector again",
      '6 io printf("%d", i)',
      "7 end return 0",
    ]);
    expect(edgesOf(main)).toEqual(["0->1", "1->2", "2->3", "3->4", "4->5 Yes", "5->2 (link)", "4->6 No", "6->7"].sort());
  });

  test("a syntax mistake: the chart is drawn for what parses and the first error's line comes back", async () => {
    const file = await chartFile("c", fixture("syntax-error.c"));
    expect(file.syntaxError).toBe(4);
    const main = ok(file.charts[0]);
    expectInvariants(main);
    expect(main.nodes.some((n) => n.kind === "io" && n.text === 'printf("big")')).toBe(true);
    expect(main.nodes.at(-1)!.text).toBe("return 0");
  });
});

describe("C edge cases keep the invariants", () => {
  const main = async (body: string) => {
    const chart = ok((await chartFile("c", `int main(void) {\n${body}\n}\n`)).charts[0]);
    expectInvariants(chart);
    return chart;
  };

  test("an if with two empty branches still has a Yes and a No", async () => {
    const c = await main("  int x = 1;\n  if (x) {} else {}\n  return x;");
    expect(edgesOf(c)).toEqual(["0->1", "1->2", "2->3 Yes", "2->3 No"].sort());
  });

  test("an empty for (;;) loops on a 'loop' connector", async () => {
    const c = await main("  for (;;) {}");
    expect(nodesOf(c)).toEqual(["0 start Start", "1 connector loop"]);
    expect(edgesOf(c)).toEqual(["0->1", "1->1 (back)"]);
  });

  test("do { continue; } while (x) goes straight to the test", async () => {
    const c = await main("  int x = 3;\n  do { continue; } while (x--);");
    expect(edgesOf(c)).toEqual(["0->1", "1->2 (jump)", "2->2 Yes (jump)", "2->3 No"].sort());
  });

  test("a goto to a label that doesn't exist carries on, with a note", async () => {
    const c = await main("  goto nowhere;\n  return 0;");
    expect(nodesOf(c)).toEqual(["0 start Start", "1 connector nowhere [no such label]", "2 end return 0"]);
  });

  test("a 60-step else-if ladder is not 'nesting' (it reads as one chain)", async () => {
    const ladder = Array.from({ length: 60 }, (_, i) => `${i ? "else " : ""}if (x == ${i}) y = ${i};`).join("\n  ");
    const c = await main(`  int x = 5, y = 0;\n  ${ladder}\n  return y;`);
    expect(c.nodes.filter((n) => n.kind === "decision").length).toBe(60);
  });

  test("a loop with no way out leaves End unreachable but every box still has a way on", async () => {
    const c = await main("  int x = 0;\n  for (;;) { x++; }\n  return x;");
    expect(nodesOf(c)).toEqual(["0 start Start", "1 process int x = 0", "2 process x++", "3 end return x"]);
    expect(c.unreachable).toEqual([3]);
  });
});

describe("text from the code is shown(), capped, never raw", () => {
  const cp = (...points: number[]) => String.fromCodePoint(...points);
  const raw = (s: string) => [...s].filter((c) => [0x202e, 0x2066, 0x200b].includes(c.codePointAt(0)!));

  test("case values on switch edges", async () => {
    const src = `int main(void) {\n  char c = 'a';\n  switch (c) {\n  case '${cp(0x202e)}': c = 1; break;\n  case 'x': break;\n  }\n  return 0;\n}\n`;
    const main = ok((await chartFile("c", src)).charts[0]);
    const labels = main.edges.map((e) => e.label ?? "");
    expect(labels.flatMap(raw)).toEqual([]);
    expect(labels).toContain("'[U+202E]'");
  });

  test("a long case value is cut", async () => {
    const long = "A_VERY_LONG_ENUM_CONSTANT_NAME_THAT_GOES_ON";
    const src = `int main(void) {\n  int c = 1;\n  switch (c) {\n  case ${long}: c = 2; break;\n  }\n  return 0;\n}\n`;
    const main = ok((await chartFile("c", src)).charts[0]);
    const label = main.edges.find((e) => e.label?.startsWith("A_VERY"))!.label!;
    expect([...label].length).toBeLessThanOrEqual(20);
  });

  test("function names (chart names and callees)", async () => {
    // U+3164 HANGUL FILLER is a letter (so a valid name) that draws as nothing.
    const name = `ma${cp(0x3164)}x`;
    const src = `def ${name}(a):\n    return a\n\nprint(${name}(1))\n`;
    const file = await chartFile("python", src);
    expect(file.charts.map((c) => c.name)).toEqual(["Program", "ma[U+3164]x"]);
    const program = ok(file.charts[0]);
    expect(program.nodes.find((n) => n.kind === "call")!.callee).toBe("ma[U+3164]x");
  });

  test("deeply nested expressions are read without recursion and come back quickly", async () => {
    const deep = `${"(".repeat(5000)}1${")".repeat(5000)}`;
    const t = performance.now();
    const c = await chartFile("c", `int main(void) {\n  int x = ${deep};\n  if (${deep}) x++;\n  return x;\n}\n`);
    const py = await chartFile("python", `x = ${deep}\nif ${deep}:\n    print(x)\n`);
    expect(performance.now() - t).toBeLessThan(2000);
    for (const f of [c, py]) for (const chart of f.charts) if (chart.ok) expectInvariants(chart);
  });

  test("a file with 2000 small functions is charted quickly", async () => {
    const fns = Array.from({ length: 2000 }, (_, i) => `int f${i}(int x) {\n  if (x) return ${i};\n  return x;\n}`).join("\n");
    const t = performance.now();
    const file = await chartFile("c", `${fns}\nint main(void) { return f1(2); }\n`);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(file.charts.length).toBe(2001);
    expect(file.charts[0].name).toBe("main");
  });
});

describe("C++ adapter", () => {
  test("AI-style code: comments, includes, using namespace std, cout/cin, a helper, range for", async () => {
    const file = await charts("cpp", "ai-style.cpp");
    expect(file.syntaxError).toBeUndefined();
    expect(file.charts.map((c) => c.name)).toEqual(["main", "grade"]);
    const main = ok(file.charts[0]);
    expect(nodesOf(main)).toEqual([
      "0 start Start",
      "1 process int n",
      '2 io cout << "How many? "',
      "3 io cin >> n",
      "4 process vector<int> scores(n)",
      "5 decision for (int &s : scores) ?",
      "6 io cin >> s",
      "7 decision for (int s : scores) ?",
      "8 call std::cout << grade(s) << endl -> grade",
      "9 end return 0",
    ]);
    expect(edgesOf(main)).toEqual(["0->1", "1->2", "2->3", "3->4", "4->5", "5->6 Yes", "6->5 (back)", "5->7 No", "7->8 Yes", "8->7 (back)", "7->9 No"].sort());
    const grade = ok(file.charts[1]);
    expect(nodesOf(grade)).toEqual(["0 start Start", "1 decision score >= 90 ?", "2 end return 'A'", "3 decision score >= 75 ?", "4 end return 'B'", "5 end return 'C'"]);
    expect(edgesOf(grade)).toEqual(["0->1", "1->2 Yes", "1->3 No", "3->4 Yes", "3->5 No"].sort());
  });

  test("cout without `using namespace std` is not output (it could be anything)", async () => {
    const src = "int main() {\n  int cout = 1;\n  cout << 2;\n  std::cout << 3;\n  return 0;\n}\n";
    const main = ok((await chartFile("cpp", src)).charts[0]);
    expect(nodesOf(main)).toEqual(["0 start Start", "1 process int cout = 1; cout << 2", "2 io std::cout << 3", "3 end return 0"]);
  });

  test("lambdas and try/catch are one step each; a template function gets its own chart", async () => {
    const file = await charts("cpp", "one-step.cpp");
    expect(file.charts.map((c) => c.name)).toEqual(["main", "twice"]);
    const main = ok(file.charts[0]);
    expect(nodesOf(main)).toEqual([
      "0 start Start",
      `1 process auto sq = [](int v) { return v * v; } [${ONE_STEP}]`,
      `2 process try { [${ONE_STEP}]`,
      "3 call std::cout << twice(3) << sq(2) -> twice",
      "4 end return 0",
    ]);
    expect([main.nodes[2].from, main.nodes[2].to]).toEqual([8, 12]);
    expect(nodesOf(ok(file.charts[1]))).toEqual(["0 start Start", "1 end return x * 2"]);
  });
});

describe("Python adapter", () => {
  test("the module body is the first chart; elif chains; for-else with break", async () => {
    const file = await charts("python", "elif-for-else.py");
    expect(file.charts.map((c) => c.name)).toEqual(["Program", "is_prime"]);
    const program = ok(file.charts[0]);
    expect(nodesOf(program)).toEqual([
      "0 start Start",
      '1 io n = int(input("Number: "))',
      "2 decision n < 0 ?",
      '3 io print("negative")',
      "4 decision is_prime(n) ?",
      '5 io print("prime")',
      "6 decision n % 2 == 0 ?",
      '7 io print("even")',
      '8 io print("odd")',
      "9 end End",
    ]);
    expect(edgesOf(program)).toEqual(["0->1", "1->2", "2->3 Yes", "2->4 No", "4->5 Yes", "4->6 No", "6->7 Yes", "6->8 No", "3->9", "5->9", "7->9", "8->9"].sort());
    const prime = ok(file.charts[1]);
    expect(nodesOf(prime)).toEqual([
      "0 start Start",
      "1 decision n < 2 ?",
      "2 end return False",
      "3 decision for d in range(2, n) ?",
      "4 decision n % d == 0 ?",
      "5 end return True",
      "6 end return False",
    ]);
    expect(edgesOf(prime)).toEqual(["0->1", "1->2 Yes", "1->3 No", "3->4 Yes", "4->3 No (back)", "3->5 No", "4->6 Yes (jump)"].sort());
  });

  test("while-else, continue, while True with break; a docstring is not a step", async () => {
    const program = ok((await charts("python", "while-loops.py")).charts[0]);
    expect(nodesOf(program)).toEqual([
      "0 start Start",
      "1 process n = 3",
      "2 decision n > 0 ?",
      "3 process n -= 1",
      "4 decision n == 1 ?",
      "5 io print(n)",
      '6 io print("done")',
      "7 decision True ?",
      "8 process n += 1",
      "9 decision n > 5 ?",
      "10 end End",
    ]);
    expect(edgesOf(program)).toEqual(
      ["0->1", "1->2", "2->3 Yes", "3->4", "4->2 Yes (jump)", "4->5 No", "5->2 (back)", "2->6 No", "6->7", "7->8 Yes", "8->9", "9->10 Yes (jump)", "9->7 No (back)", "7->10 No"].sort(),
    );
  });

  test("try, with and lambda are one step each; methods get their own chart", async () => {
    const file = await charts("python", "one-step.py");
    expect(file.charts.map((c) => c.name)).toEqual(["Program", "Counter.add"]);
    expect(nodesOf(ok(file.charts[0]))).toEqual([
      "0 start Start",
      `1 process sq = lambda v: v * v [${ONE_STEP}]`,
      `2 process try: [${ONE_STEP}]`,
      `3 process with open("data.txt") as f: [${ONE_STEP}]`,
      "4 io print(sq(x))",
      "5 end End",
    ]);
    expect(nodesOf(ok(file.charts[1]))).toEqual(["0 start Start", "1 process self.total += k", "2 end End"]);
  });

  test("a syntax mistake reports its line", async () => {
    const file = await chartFile("python", fixture("syntax-error.py"));
    expect(file.syntaxError).toBe(2);
    expectInvariants(ok(file.charts[0]));
  });
});

import { expect, importFiles, installCpp, openApp, openFromTree, run, setCode, showView, test, treeItem } from "./helpers";

test.use({ serviceWorkers: "block" });

const MAIN_C = `#include <stdio.h>
#include "util.h"

int main(void) {
    int n;
    printf("How many? ");
    if (scanf("%d", &n) != 1) return 2;
    printf("square = %d\\n", square(n));
    FILE *in = fopen("input.txt", "r");
    char word[32] = "";
    if (in && fscanf(in, "%31s", word) == 1) printf("file says %s\\n", word);
    if (in) fclose(in);
    FILE *out = fopen("out.txt", "w");
    fprintf(out, "%d\\n", square(n));
    fclose(out);
    return 0;
}
`;

test("C and C++ need a one-time download, offered where the output appears", async ({ page }) => {
  await openApp(page);
  await page.locator('.starter[data-language="c"]').click();
  const runtime = page.locator("#status-runtime");
  await expect(runtime).toHaveAttribute("data-runtime", "cpp");
  await expect(runtime).not.toHaveAttribute("data-state", /^(not-loaded|checking)$/, { timeout: 30_000 });
  test.skip((await runtime.getAttribute("data-state")) !== "absent", "the pack is already installed in this browser profile");
  await page.locator("#run-button").click();
  await showView(page, "output");
  await expect(page.locator("#pack-download")).toBeFocused();
  await expect(page.locator("#pack-download")).toHaveText(/Download C\/C\+\+ \(\d+\.\d MB\)/);
  await expect(page.locator(".notice")).toHaveAttribute("data-tone", "info");
});

test("multi-file C with a header, live scanf input, fopen of a data file, and the written file saved", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  await importFiles(page, [
    { name: "main.c", text: MAIN_C },
    { name: "util.h", text: "#ifndef UTIL_H\n#define UTIL_H\nint square(int x);\n#endif\n" },
    { name: "util.c", text: '#include "util.h"\nint square(int x) { return x * x; }\n' },
    { name: "input.txt", text: "hello\n" },
  ]);
  await openFromTree(page, "main.c");
  await installCpp(page);

  const ok = await run(page, { input: ["7"], timeout: 120_000 });
  expect(ok.status, ok.output).toBe("ok");
  expect(ok.output).toContain("How many? 7\nsquare = 49\nfile says hello\n");
  // The file it wrote is saved to the workspace by itself, without a question.
  await expect(treeItem(page, "out.txt")).toBeVisible();
  await expect(page.locator('#console [data-stream="note"]')).toContainText("Saved out.txt to your files.");
  await expect(page.locator(".notice").getByRole("button")).toHaveCount(0);

  // A compile error in the header is marked in the header.
  await openFromTree(page, "util.h");
  await setCode(page, "#ifndef UTIL_H\n#define UTIL_H\nint square(int x)\n#endif\n");
  await openFromTree(page, "main.c");
  const broken = await run(page, { timeout: 120_000 });
  expect(broken.status).toBe("build-failed");
  await expect(page.locator("[data-announcer]")).toHaveText(/^Build failed: \d+ errors? in .*util\.h/);
  await expect(page.locator("#console .err").first()).toContainText("util.h:");
  await page.locator("#ptab-problems").click();
  const problem = page.locator('.problem[data-path="util.h"]').first();
  await expect(problem).toBeVisible();
  await problem.click();
  await showView(page, "code");
  await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", "util.h");
  await expect(page.locator(".cm-lint-marker-error").first()).toBeVisible();
});

test("the Stop button ends a C program that never finishes", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  await importFiles(page, [{ name: "spin.c", text: "int main(void) {\n    volatile unsigned long n = 0;\n    for (;;) n++;\n}\n" }]);
  await openFromTree(page, "spin.c");
  await installCpp(page);
  const runs = Number((await page.locator("#app").getAttribute("data-runs")) ?? 0);
  await page.locator("#run-button").click();
  await expect(page.locator("#run-status")).toHaveAttribute("data-phase", "running", { timeout: 120_000 });
  await expect(page.locator("#run-button")).toHaveAccessibleName(/Stop/);
  await page.locator("#run-button").click();
  await expect(page.locator("#app")).toHaveAttribute("data-runs", String(runs + 1), { timeout: 30_000 });
  await expect(page.locator("#receipt")).toHaveAttribute("data-status", "stopped");
  await expect(page.locator("#run-button")).toHaveAttribute("data-running", "false");
});

test("C++ with several files in its own folder, and a sibling with its own main() is skipped", async ({ page }) => {
  test.setTimeout(240_000);
  await openApp(page);
  const create = async (path: string, text: string) => {
    await page.locator(".tree-host").click({ position: { x: 20, y: 500 } });
    await page.locator("#new-file").click();
    const field = page.getByRole("textbox", { name: /Name of the new file/ });
    await field.fill(path);
    await field.press("Enter");
    await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", path);
    await setCode(page, text);
    await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
  };
  await create("shapes/shape.hpp", "#pragma once\nstruct Square { int side; int area() const; };\n");
  await create("shapes/shape.cpp", '#include "shape.hpp"\nint Square::area() const { return side * side; }\n');
  await create("shapes/other.cpp", "int main() { return 3; }\n");
  await create("shapes/main.cpp", '#include <iostream>\n#include "shape.hpp"\nint main() {\n    Square s{6};\n    std::cout << s.area() << std::endl;\n}\n');
  await installCpp(page);
  const r = await run(page, { timeout: 150_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("36");
  await expect(page.locator("#console .note")).toContainText("other.cpp");
});

// The header lifts a failed build's first error; the one line the log draws in the danger colour
// must be that same error, not the compiler's last one (review B, 2026-10-18).
test("a C build with two errors lifts the first, and the log's danger line is that same error", async ({ page }, info) => {
  test.skip(info.project.name !== "chromium", "the log's text is the same in every engine: one compiler download is enough");
  test.setTimeout(240_000);
  await openApp(page);
  await importFiles(page, [{ name: "two.c", text: '#include <stdio.h>\nint main(void) {\n    int a = 1, b = 2;\n    printf("%d\\n", a + b)\n    return x;\n}\n' }]);
  await openFromTree(page, "two.c");
  await installCpp(page);
  const r = await run(page, { timeout: 120_000 });
  expect(r.status, r.output).toBe("build-failed");
  await expect(page.locator("#run-exception .exc-where")).toHaveText("two.c, line 4");
  const last = page.locator("#console .err-last");
  await expect(last).toHaveCount(1);
  await expect(last).toHaveText(/^two\.c:4:\d+: error: /);
  // Every error stays in the log, in order: the second is there, in the log's own colour.
  await expect(page.locator("#console")).toContainText("two.c:5:");
});

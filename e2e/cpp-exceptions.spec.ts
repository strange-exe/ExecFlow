// C++ exceptions and the other things 0.17.0's toolchain (LLVM 22, wasi-sdk-33) changed: throw and
// catch work, an uncaught exception is named as one, a quoted include's "../" goes up one folder, a
// program with no main says so, and a browser without WebAssembly's exception
// instructions is told to update instead of being offered a download it can't use.
import { expect, importFiles, installCpp, openApp, openFromTree, run, setCode, showView, test } from "./helpers";

test.use({ serviceWorkers: "block" });
test.setTimeout(240_000);

test("throw and catch work, and an exception nobody catches stops the program with its help", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{
    name: "safe.cpp",
    text: '#include <iostream>\n#include <stdexcept>\nint divide(int a, int b) {\n    if (b == 0) throw std::invalid_argument("division by zero");\n    return a / b;\n}\nint main() {\n    try {\n        std::cout << divide(8, 2) << "\\n";\n        std::cout << divide(1, 0) << "\\n";\n    } catch (const std::exception& e) {\n        std::cout << "caught: " << e.what() << "\\n";\n    }\n    std::cout << divide(9, 0) << "\\n";\n}\n',
  }]);
  await openFromTree(page, "safe.cpp");
  await installCpp(page);
  const r = await run(page, { timeout: 150_000 });
  expect(r.output).toContain("4\ncaught: division by zero\n");
  expect(r.status, r.output).toBe("crashed");
  await expect(page.locator("#runlog > #run-help")).toHaveAttribute("data-help", "crash-uncaught");
  await expect(page.locator("#console")).toContainText("The program threw an exception and no catch caught it.");
});

// A run gets the files of the program's own folder (workspace.ts loadRunFiles), so "../" climbs
// within it: here from inc/ back to the folder, where a ".." taken as a no-op would find the decoy.
test('a header in a sub-folder that includes "../lib/twice.h" gets that file, not inc/lib/twice.h', async ({ page }) => {
  await openApp(page);
  const create = async (path: string, text: string) => {
    await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
    await page.locator("#new-file").click();
    const field = page.getByRole("textbox", { name: "Name of the new file at the top level" });
    await field.fill(path);
    await field.press("Enter");
    await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", path);
    await setCode(page, text);
    await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
  };
  await create("lab/lib/twice.h", "#pragma once\nstatic inline int twice(int x) { return 2 * x; }\n");
  await create("lab/inc/lib/twice.h", "#pragma once\nstatic inline int twice(int x) { return 3 * x; }\n");
  await create("lab/inc/outer.h", '#pragma once\n#include "../lib/twice.h"\n');
  await create("lab/main.c", '#include <stdio.h>\n#include "inc/outer.h"\nint main(void) {\n    printf("%d\\n", twice(21));\n    return 0;\n}\n');
  await installCpp(page);
  const r = await run(page, { timeout: 150_000 });
  expect(r.status, r.output).toBe("ok");
  expect(r.output).toContain("42\n");
  expect(r.output).not.toContain("63");
});

// Security review of 0.17.0 (2026-10-30): "__proto__/remove" in the compiler's file tree wrote onto
// Object.prototype, and every later build in that worker failed. Names like that are ordinary files.
test('a header in "__proto__/remove/" builds like any other, and the next build still works', async ({ page }) => {
  await openApp(page);
  const create = async (path: string, text: string) => {
    await page.locator(".tree-host").click({ position: { x: 20, y: 400 } });
    await page.locator("#new-file").click();
    const field = page.getByRole("textbox", { name: "Name of the new file at the top level" });
    await field.fill(path);
    await field.press("Enter");
    await expect(page.locator('.tabs [role=tab][aria-selected="true"]')).toHaveAttribute("title", path);
    await setCode(page, text);
    await expect(page.locator('.tab[data-active="true"]')).toHaveAttribute("data-dirty", "false");
  };
  // Before the fix, the folder "__proto__/remove" became Object.prototype.remove in the compiler worker.
  await create("lab/__proto__/remove/seven.h", "#pragma once\nstatic inline int seven(void) { return 7; }\n");
  await create("lab/main.c", '#include <stdio.h>\n#include "__proto__/remove/seven.h"\nint main(void) {\n    printf("%d\\n", seven() * 6);\n    return 0;\n}\n');
  await installCpp(page);
  const first = await run(page, { timeout: 150_000 });
  expect(first.status, first.output).toBe("ok");
  expect(first.output).toContain("42\n");
  await setCode(page, '#include <stdio.h>\n#include "__proto__/remove/seven.h"\nint main(void) {\n    printf("%d\\n", seven() + 1);\n    return 0;\n}\n');
  const second = await run(page, { timeout: 150_000 });
  expect(second.status, second.output).toBe("ok");
  expect(second.output).toContain("8\n");
});

test("a C program without main() fails to build, and says it needs one", async ({ page }) => {
  await openApp(page);
  await importFiles(page, [{ name: "helper.c", text: "int square(int x) {\n    return x * x;\n}\n" }]);
  await openFromTree(page, "helper.c");
  await installCpp(page);
  const r = await run(page, { timeout: 150_000 });
  expect(r.status, r.output).toBe("build-failed");
  expect(r.output).toContain("the program needs an int main() function");
});

test.describe("a browser without WebAssembly's exception instructions", () => {
  test.beforeEach(async ({ page }) => {
    // Such a browser rejects any module that uses try_table (opcode 0x1f): wasm-features.ts asks with one.
    await page.addInitScript(() => {
      const validate = WebAssembly.validate.bind(WebAssembly);
      WebAssembly.validate = (bytes: BufferSource) => {
        const b = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array((bytes as ArrayBufferView).buffer);
        for (let i = 0; i + 1 < b.length; i++) if (b[i] === 0x1f && b[i + 1] === 0x40) return false;
        return validate(bytes);
      };
    });
  });

  test("is told to update, with no download offered, and Python still runs", async ({ page }) => {
    await openApp(page);
    await importFiles(page, [
      { name: "hi.c", text: '#include <stdio.h>\nint main(void) { puts("hi"); return 0; }\n' },
      { name: "hi.py", text: 'print("still here")\n' },
    ]);
    await openFromTree(page, "hi.c");
    const runtime = page.locator("#status-runtime");
    await expect(runtime).toHaveAttribute("data-state", "unsupported", { timeout: 30_000 });
    await expect(runtime).toContainText("C/C++ needs a newer browser");
    await page.locator("#run-button").click();
    await showView(page, "output");
    await expect(page.locator("#receipt")).toHaveAttribute("data-status", "unavailable", { timeout: 30_000 });
    await expect(page.locator("#console")).toContainText("C and C++ need a newer browser: Chrome or Edge 137, Firefox 131, or Safari 18.4");
    await expect(page.locator("#pack-download")).toBeHidden();
    await openFromTree(page, "hi.py");
    const py = await run(page, { timeout: 150_000 });
    expect(py.status, py.output).toBe("ok");
    expect(py.output).toContain("still here");
  });
});

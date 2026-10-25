// The phone top bar (polish audit, 2026-10-24): at 390 px the file name was cut to "main." and the
// sync words to "Not co" (each with an ellipsis), and still at 412 and 430 px. Below 480 px the
// sync status is its icon (its words stay its accessible name and tooltip), and a file name cut
// short keeps its extension.
import { expect, importFiles, openApp, openFromTree, test } from "./helpers";

test.use({ serviceWorkers: "block" });

const ASKS = { name: "main.py", text: 'name = input("Name: ")\nprint("Hello,", name)\n' };
const LONG = { name: "finding_the_largest_value_in_a_list.py", text: "print(max([3, 1, 2]))\n" };

for (const width of [320, 360, 390, 430]) {
  test(`(${width} px) the file name keeps its extension when cut, and the sync status is its icon, its words in its name and tooltip`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openApp(page);
    await importFiles(page, [ASKS, LONG]);
    for (const name of [ASKS.name, LONG.name]) {
      await openFromTree(page, name);
      const file = page.locator(".topbar .crumb-file");
      await expect(file).toHaveText(name);
      const shown = await file.evaluate((li) => {
        const text = li.querySelector<HTMLElement>(".crumb-text")!;
        const ext = li.querySelector<HTMLElement>(".crumb-ext");
        const t = text.getBoundingClientRect();
        const e = ext?.getBoundingClientRect();
        return {
          ext: ext?.textContent ?? null,
          // The extension is drawn whole, inside the name's box (not cut by its ellipsis).
          extWhole: Boolean(ext && e && e.width > 0 && ext.scrollWidth <= ext.clientWidth + 1 && e.right <= t.right + 0.5 && e.left >= t.left - 0.5),
        };
      });
      expect(shown, `${name} at ${width} px`).toEqual({ ext: ".py", extWhole: true });
      // No control lies over another (at 320 px with a long name, the 44 px sync button spilled 18 px
      // under Run, because its slot could shrink to nothing: the lead's screenshot review, 2026-10-25).
      const overlaps = await page.evaluate(() => {
        const ids = [".topbar .drawer-toggle", ".topbar .crumb-file", "#palette-button", "#sync-status", "#run-button", "#settings-button"];
        const boxes = ids.map((s) => [s, document.querySelector(s)?.getBoundingClientRect()] as const).filter(([, r]) => r && r.width > 0);
        const out: string[] = [];
        for (let i = 0; i < boxes.length; i++)
          for (let j = i + 1; j < boxes.length; j++) {
            const [a, ra] = boxes[i];
            const [b, rb] = boxes[j];
            if (ra!.right > rb!.left + 0.5 && rb!.right > ra!.left + 0.5) out.push(`${a} / ${b}`);
          }
        return out;
      });
      expect(overlaps, `${name} at ${width} px: controls on top of each other`).toEqual([]);
    }
    // The short name fits whole from 360 px (at 320 five 44 px controls and Run leave it about 58 px,
    // one short of main.py: it is cut there, keeping its extension, as checked above).
    await openFromTree(page, ASKS.name);
    if (width >= 360) {
      const stemCut = await page.locator(".topbar .crumb-file .crumb-stem").evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(stemCut, "main.py is shown whole").toBe(false);
    }

    // The sync status: the icon only (no word cut in the middle), a 44 px target, and its words
    // are still its accessible name and tooltip.
    const sync = page.locator("#sync-status");
    await expect(sync.locator(".sync-words")).toBeHidden();
    await expect(sync).toHaveAccessibleName(/^Not connected\. /);
    await expect(sync).toHaveAttribute("title", /^Not connected\. /);
    const b = (await sync.boundingBox())!;
    expect(Math.round(b.width), "sync status width").toBeGreaterThanOrEqual(44);
    expect(Math.round(b.height), "sync status height").toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no sideways scroll").toBe(true);
  });
}

test("from 480 px the sync status shows its words again, whole", async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 844 });
  await openApp(page);
  await importFiles(page, [ASKS]);
  await openFromTree(page, ASKS.name);
  const words = page.locator("#sync-status .sync-words");
  await expect(words).toBeVisible();
  await expect(words).toHaveText("Not connected");
  expect(await words.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "the words are whole").toBe(true);
});

// The Licences page's script (licenses.html). The page reads fully without it: every licence is
// a native <details> in the static HTML the build wrote. This adds the find box (it filters the
// list by package or licence and says how many match) and opens the licence a #lic-<n> link names.
// html[data-licences="ready"] marks it wired (e2e/legal.spec.ts).

function openFromHash(): void {
  const id = location.hash.slice(1);
  if (!/^lic-\d+$/.test(id)) return;
  const item = document.getElementById(id);
  const details = item?.querySelector("details");
  if (!item || !details) return;
  details.open = true;
  item.scrollIntoView({ block: "start" });
}

function find(): void {
  const box = document.querySelector<HTMLElement>(".lic-find");
  const input = document.querySelector<HTMLInputElement>("#lic-q");
  const count = document.querySelector<HTMLElement>("#lic-count");
  const none = document.querySelector<HTMLElement>(".lic-none");
  const items = [...document.querySelectorAll<HTMLLIElement>(".lic")];
  if (!box || !input || !count || !none || !items.length) return;
  const say = (shown: number) => {
    count.textContent = shown === items.length ? `${items.length} licences` : `${shown} of ${items.length} licences`;
  };
  input.addEventListener("input", () => {
    const words = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    let shown = 0;
    for (const item of items) {
      const filter = item.dataset.filter ?? "";
      const hit = words.every((w) => filter.includes(w));
      item.hidden = !hit;
      if (hit) shown++;
    }
    none.hidden = shown > 0;
    say(shown);
  });
  say(items.length);
  box.hidden = false;
}

find();
openFromHash();
addEventListener("hashchange", openFromHash);
document.documentElement.dataset.licences = "ready";

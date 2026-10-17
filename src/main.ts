// Entry point. public/theme-boot.js already painted the saved theme before this module loaded;
// applyTheme() re-applies it with full validation and "match device" keeps following the system.
import "./styles/app.css";
import { registerSW } from "virtual:pwa-register";
import { state as pythonState, onState as onPythonState } from "./runner/python-runner";
import { applyTheme, chosenTheme, followDevice } from "./theme/themes";
import { startWorkbench } from "./ui/workbench";

applyTheme(chosenTheme());
followDevice();

const root = document.getElementById("app");
if (root) await startWorkbench(root);

// Offline support. The service worker precaches the Python runtime (several MB), so it registers
// once Python is up (its install then reuses what the page just downloaded) or after a quiet
// minute when Python isn't used, never in the middle of the first load (Pocket Run measurement).
// Updates wait for the user: an editor tab can hold unsaved text.
let registered = false;
function register() {
  if (registered || !("serviceWorker" in navigator)) return;
  registered = true;
  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      document.dispatchEvent(new CustomEvent("codeeditor:update-ready", { detail: () => void update(true) }));
    },
  });
}
// The C/C++ pack download starts (workbench.ts): register now. Measured in Playwright's WebKit: the
// pack's Cache Storage entries were dropped on reload unless a service worker was active.
document.addEventListener("codeeditor:offline-wanted", register, { once: true });
if (navigator.serviceWorker?.controller) register();
else {
  const settled = () => pythonState() === "ready" || pythonState() === "failed";
  if (settled()) register();
  else {
    const off = onPythonState(() => {
      if (settled()) {
        off();
        register();
      }
    });
    setTimeout(register, 60_000);
  }
}

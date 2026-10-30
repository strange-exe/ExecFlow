// Not type-checked by either tsconfig (src/workers is worker-only, tests are excluded there); Vitest runs it.
import { describe, expect, it } from "vitest";
import { BLOCKED_GLOBALS, BLOCKED_NAVIGATOR, lockDown } from "./lockdown";

/** A scope shaped like a worker's: Web IDL members on prototypes, own properties on the instance. */
function fakeScope() {
  const navProto = Object.create(null);
  for (const name of [...BLOCKED_NAVIGATOR, "userAgent"]) {
    Object.defineProperty(navProto, name, { get: () => ({ name }), configurable: true });
  }
  const navigator = Object.create(navProto);
  const workerProto = Object.create(null);
  const globalProto = Object.create(workerProto);
  for (const name of BLOCKED_GLOBALS) {
    Object.defineProperty(name.length % 2 ? workerProto : globalProto, name, { value: () => name, configurable: true, writable: true });
  }
  Object.defineProperty(workerProto, "navigator", { get: () => navigator, configurable: true });
  const scope = Object.create(globalProto);
  scope.fetch = () => "own copy"; // also on the instance itself
  scope.postMessage = () => "own copy";
  scope.onmessage = null;
  return { scope, navProto };
}

describe("lockDown", () => {
  it("removes every blocked API along the prototype chain and reports none reachable", () => {
    const { scope } = fakeScope();
    expect(lockDown(scope)).toEqual([]);
    for (const name of BLOCKED_GLOBALS) expect(Reflect.has(scope, name), name).toBe(false);
    for (const name of BLOCKED_NAVIGATOR) expect(Reflect.has(scope.navigator, name), `navigator.${name}`).toBe(false);
    expect("onmessage" in scope).toBe(true); // what the worker needs stays
    expect(scope.navigator.userAgent).toEqual({ name: "userAgent" });
  });

  it("takes postMessage away: a program can't forge the worker's messages (a 'done' that outlives Stop)", () => {
    const { scope } = fakeScope();
    const bound = scope.postMessage.bind(scope); // what python.worker.ts keeps before the lockdown
    expect(lockDown(scope)).toEqual([]);
    expect(Reflect.has(scope, "postMessage")).toBe(false);
    expect(bound()).toBe("own copy");
  });

  it("includes the cross-tab, storage-bucket, font and messaging APIs ExecFlow added", () => {
    expect(BLOCKED_GLOBALS).toEqual(expect.arrayContaining(["indexedDB", "caches", "fetch", "BroadcastChannel", "FontFace", "fonts", "Notification", "postMessage"]));
    expect(BLOCKED_NAVIGATOR).toEqual(expect.arrayContaining(["locks", "storage", "storageBuckets", "serviceWorker"]));
  });

  it("fails closed: an API that can't be deleted is reported", () => {
    const { scope, navProto } = fakeScope();
    Object.defineProperty(scope, "indexedDB", { value: {}, configurable: false });
    Object.defineProperty(navProto, "locks", { get: () => ({}), configurable: false });
    expect(lockDown(scope)).toEqual(["indexedDB", "navigator.locks"]);
  });
});

import { describe, expect, it } from "vitest";
// The lock file of the pinned Pyodide (the same file copy-pyodide.mjs serves).
import lockText from "pyodide/pyodide-lock.json?raw";
import { canonicalName, importIndex, missingPackages, nextPackageSet, packageClosure, PYTHON_PACKAGES, type LockFile } from "./python-packages";

const lock = JSON.parse(lockText) as LockFile;

describe("packages from the real pyodide-lock.json", () => {
  it("numpy and pandas bring exactly their dependencies, dependencies first", () => {
    const closure = packageClosure(lock, PYTHON_PACKAGES);
    expect([...closure].sort()).toEqual(["numpy", "pandas", "python-dateutil", "pytz", "six"]);
    for (const [i, name] of closure.entries()) {
      for (const dep of lock.packages[name].depends) expect(closure.indexOf(canonicalName(dep)), `${dep} before ${name}`).toBeLessThan(i);
    }
  });

  it("every package has a plain wheel file name and a sha256", () => {
    for (const name of packageClosure(lock, PYTHON_PACKAGES)) {
      expect(lock.packages[name].file_name).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.+-]*\.whl$/);
      expect(lock.packages[name].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("maps import names to packages, including ones that differ (dateutil)", () => {
    const index = importIndex(lock, packageClosure(lock, PYTHON_PACKAGES));
    expect(index.get("numpy")).toBe("numpy");
    expect(index.get("pandas")).toBe("pandas");
    expect(index.get("dateutil")).toBe("python-dateutil");
    expect(index.has("scipy")).toBe(false); // in Pyodide, but not something ExecFlow serves
  });
});

describe("packageClosure", () => {
  const fake: LockFile = {
    packages: {
      a: { name: "A", version: "1", file_name: "a.whl", sha256: "", depends: ["B_c"], imports: ["a"] },
      "b-c": { name: "b_c", version: "1", file_name: "b.whl", sha256: "", depends: [], imports: ["bc", "bc.sub"] },
      loop1: { name: "loop1", version: "1", file_name: "l.whl", sha256: "", depends: ["loop2"], imports: [] },
      loop2: { name: "loop2", version: "1", file_name: "l.whl", sha256: "", depends: ["loop1"], imports: [] },
    },
  };
  it("matches names the PEP 503 way", () => {
    expect(packageClosure(fake, ["a"])).toEqual(["b-c", "a"]);
    expect(packageClosure(fake, ["B.C"])).toEqual(["b-c"]);
  });
  it("refuses unknown packages and cycles", () => {
    expect(() => packageClosure(fake, ["nope"])).toThrow(/no package "nope"/);
    expect(() => packageClosure(fake, ["loop1"])).toThrow(/cycle/);
  });
  it("indexes only top-level import names", () => {
    expect([...importIndex(fake, ["b-c"]).entries()]).toEqual([["bc", "b-c"]]);
  });
});

describe("missingPackages", () => {
  const index = new Map([["numpy", "numpy"], ["pandas", "pandas"], ["dateutil", "python-dateutil"]]);
  it("lists supported imports that aren't loaded, sorted, once each", () => {
    expect(missingPackages(["pandas", "numpy", "requests", "pandas"], index, [])).toEqual(["numpy", "pandas"]);
  });
  it("ignores loaded packages, in any spelling", () => {
    expect(missingPackages(["numpy", "dateutil"], index, ["numpy", "python_dateutil"])).toEqual([]);
  });
  it("doesn't ask again for packages that failed to load", () => {
    expect(missingPackages(["numpy", "pandas"], index, [], ["pandas"])).toEqual(["numpy"]);
  });
  it("is empty for standard-library-only programs", () => {
    expect(missingPackages([], index, [])).toEqual([]);
  });
});

describe("nextPackageSet", () => {
  const available = ["numpy", "six", "python-dateutil", "pytz", "pandas"];
  it("adds what is missing to what the worker has", () => {
    expect(nextPackageSet(["numpy"], ["pandas"], available)).toEqual(["numpy", "pandas"]);
    expect(nextPackageSet([], ["pandas", "numpy"], available)).toEqual(["numpy", "pandas"]);
  });
  it("returns null when nothing would change (so a run can't loop on restarts)", () => {
    expect(nextPackageSet(["numpy"], ["numpy"], available)).toBeNull();
    expect(nextPackageSet(["numpy"], [], available)).toBeNull();
  });
  it("never adds a package the build can't load (a forged need-packages message)", () => {
    expect(nextPackageSet([], ["evil-package", "../x"], available)).toBeNull();
    expect(nextPackageSet(["numpy"], ["numpy", "scipy"], available)).toBeNull();
  });
});

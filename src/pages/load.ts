/// <reference types="node" />
// Reads the guide pages' data from the repo (build time and tests only, never in a browser): each
// example's source and typed input, captured.json, and the exported flowcharts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXAMPLES, extOf } from "./examples";
import type { Captured, GuideData } from "./render";

/** `root` is the project root. Files are read as LF text (the repo keeps LF; a CRLF checkout is normalised). */
export function loadGuideData(root: string): GuideData {
  const dir = join(root, "src/pages");
  const read = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  const sources: GuideData["sources"] = {};
  const charts: GuideData["charts"] = {};
  for (const [id, ex] of Object.entries(EXAMPLES)) {
    const stdinFile = join(dir, "examples", `${id}.stdin`);
    sources[id] = {
      name: ex.name,
      code: read(join(dir, "examples", `${id}${extOf(id)}`)),
      stdin: existsSync(stdinFile) ? read(stdinFile).replace(/\n$/, "").split("\n") : [],
    };
    if (ex.chart) charts[id] = read(join(dir, "flowcharts", `${id}.svg`));
  }
  const captured = JSON.parse(read(join(dir, "captured.json"))) as Captured;
  return { sources, captured, charts };
}

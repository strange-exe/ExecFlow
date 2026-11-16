// Tags every release on the current branch: each commit whose subject is "X.Y.Z: what changed" and
// whose package.json says version X.Y.Z gets an annotated tag vX.Y.Z ("ExecFlow X.Y.Z: What changed"),
// as the earlier releases were tagged by hand. Tags already there are never moved. Local only:
// pushing them (`git push origin --tags`) is a separate, deliberate step.
//
//   node scripts/tag-releases.mjs          tags what is missing
//   node scripts/tag-releases.mjs --check  lists what is missing, changes nothing (exit 1 if any)
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const check = process.argv.includes("--check");

const releases = git("log", "--format=%H%x09%s", "--", "package.json")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [sha, subject] = line.split("\t");
    const m = /^(\d+\.\d+\.\d+): (.+)$/.exec(subject);
    return m && { sha, version: m[1], title: m[2] };
  })
  .filter(Boolean)
  .reverse();

const existing = new Map(
  git("tag", "-l", "v*", "--format=%(refname:short)%09%(*objectname)%09%(objectname)")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, peeled, object] = line.split("\t");
      return [name, peeled || object];
    }),
);

let missing = 0;
for (const { sha, version, title } of releases) {
  const tag = `v${version}`;
  // Some early tags were put on the fix that shipped after the release commit: they stay there.
  if (existing.has(tag)) continue;
  const declared = JSON.parse(git("show", `${sha}:package.json`)).version;
  if (declared !== version) {
    console.error(`${sha.slice(0, 7)} says ${version} but its package.json says ${declared}: not tagged.`);
    continue;
  }
  missing++;
  const message = `ExecFlow ${version}: ${title.charAt(0).toUpperCase()}${title.slice(1)}`;
  if (check) console.log(`missing ${tag} (${sha.slice(0, 7)}) ${message}`);
  else {
    git("tag", "-a", tag, sha, "-m", message);
    console.log(`tagged ${tag} ${sha.slice(0, 7)} ${message}`);
  }
}
if (!missing) console.log("Every release is tagged.");
process.exitCode = check && missing ? 1 : 0;

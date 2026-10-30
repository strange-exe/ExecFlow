// For unit tests (imported for its effect): every language's chunk (language-support.ts) is loaded
// before the file's tests run, as in the app once a file of each language has opened. Tests of the
// time before a chunk arrives (language-arrival.test.ts) leave this out.
import { beforeAll } from "vitest";
import { loadLanguage } from "./language-support";

beforeAll(async () => {
  await Promise.all([loadLanguage("python"), loadLanguage("c"), loadLanguage("cpp")]);
});

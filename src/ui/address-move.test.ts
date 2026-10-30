import { describe, expect, it } from "vitest";
import { ZIP_LIMITS } from "../storage/zip";
import { MOVE_MAX_ZIP_BYTES } from "./address-move";

describe("the move's size limit", () => {
  it("is the zip import's own total, so the move takes what an import of the same zip would", () => {
    expect(MOVE_MAX_ZIP_BYTES).toBe(ZIP_LIMITS.maxTotalBytes);
  });
});

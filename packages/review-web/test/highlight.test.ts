import { describe, expect, it } from "vitest";
import { highlightBlocks } from "../src/lib/highlight";

describe("highlightBlocks", () => {
  it("doesn't carry an open comment from one hunk into the next", async () => {
    // Hunk 1 ends inside a block comment that closes in the hidden lines after it.
    const hunk1 = ["const a = 1;", "/**", " * Explains b"];
    const hunk2 = ["const b = 2;"];
    const [, second] = await highlightBlocks([hunk1, hunk2], "typescript");
    const [alone] = await highlightBlocks([hunk2], "typescript");
    // `const` in hunk 2 colors as code, exactly as it would on its own.
    expect(second?.[0][0]).toEqual(alone?.[0][0]);
    const [joined] = await highlightBlocks([[...hunk1, ...hunk2]], "typescript");
    expect(joined?.[3][0]).not.toEqual(alone?.[0][0]);
  });
});

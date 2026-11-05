import { describe, expect, it } from "vitest";
import { isCI } from "../src/utils/output.js";

// Must match Ink's is-in-ci: if pile thinks it's interactive while Ink thinks it's in
// CI, Ink never draws the prompt and the command waits for input forever.
describe("isCI", () => {
  it.each([
    [{}, false],
    [{ CI: "true" }, true],
    [{ CI: "1" }, true],
    [{ CI: "" }, true],
    [{ CI: "0" }, false],
    [{ CI: "false" }, false],
    [{ CONTINUOUS_INTEGRATION: "" }, true],
    [{ CI_COMMIT_SHA: "abc" }, true],
    [{ CI: "false", CI_JOB_ID: "1" }, false],
  ])("%j -> %s", (env, expected) => {
    expect(isCI(env as NodeJS.ProcessEnv)).toBe(expected);
  });
});

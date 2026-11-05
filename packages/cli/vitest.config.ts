import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Each test spawns the built CLI against temporary git repos.
    testTimeout: 60_000,
  },
});

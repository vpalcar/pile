import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin/pile.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  noExternal: ["@pile/core", "@pile/github", "@pile/review-web"],
  external: [
    "commander",
    "ink",
    "ink-spinner",
    "react",
    "react/jsx-runtime",
    "simple-git",
    "zod",
    "@octokit/rest",
  ],
});

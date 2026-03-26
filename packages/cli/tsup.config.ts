import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin/pile.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  external: [
    "@pile/core",
    "@pile/github",
    "commander",
    "ink",
    "ink-spinner",
    "react",
    "react/jsx-runtime",
  ],
});

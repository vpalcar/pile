// Bundles the review app into dist/: index.html, app.js (+ lazily loaded chunks for
// syntax highlighting grammars), app.css and the two variable fonts.
import { build, context } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
const require = createRequire(import.meta.url);
const watch = process.argv.includes("--watch");

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, "fonts"), { recursive: true });

for (const [pkg, file, name] of [
  ["@fontsource-variable/geist", "geist-latin-wght-normal.woff2", "geist.woff2"],
  ["@fontsource-variable/geist-mono", "geist-mono-latin-wght-normal.woff2", "geist-mono.woff2"],
]) {
  copyFileSync(join(dirname(require.resolve(`${pkg}/package.json`)), "files", file), join(dist, "fonts", name));
}

writeFileSync(
  join(dist, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="dark light">
    <title>pile review</title>
    <link rel="preload" href="/fonts/geist.woff2" as="font" type="font/woff2" crossorigin>
    <link rel="stylesheet" href="/app.css">
    <link rel="icon" href="data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#111"/><rect x="9" y="19" width="14" height="4" rx="2" fill="#fff"/><rect x="9" y="13" width="14" height="4" rx="2" fill="#fff" opacity=".7"/><rect x="9" y="7" width="14" height="4" rx="2" fill="#fff" opacity=".4"/></svg>',
    )}">
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/app.js"></script>
  </body>
</html>
`,
);

const options = {
  entryPoints: { app: join(root, "src/main.tsx") },
  outdir: dist,
  bundle: true,
  format: "esm",
  splitting: true,
  minify: !watch,
  sourcemap: watch ? "inline" : false,
  target: ["chrome120", "safari17", "firefox120"],
  jsx: "automatic",
  loader: { ".woff2": "file" },
  external: ["/fonts/*"],
  chunkNames: "chunks/[name]-[hash]",
  define: { "process.env.NODE_ENV": JSON.stringify(watch ? "development" : "production") },
  logLevel: "info",
};

// Tailwind compiles src/styles.css (and the classes used in src/) into app.css.
const tailwind = join(root, "node_modules/.bin/tailwindcss");
const css = ["-i", join(root, "src/styles.css"), "-o", join(dist, "app.css")];

if (watch) {
  spawn(tailwind, [...css, "--watch"], { stdio: "inherit" });
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
  execFileSync(tailwind, [...css, "--minify"], { stdio: "inherit" });
}

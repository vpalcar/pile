// Ships the built review app inside the CLI package (dist/review-web).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "..", "review-web", "dist");
const target = join(root, "dist", "review-web");
if (!existsSync(join(source, "index.html"))) {
  console.error("review-web is not built; run `pnpm build` from the repo root.");
  process.exit(1);
}
rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });

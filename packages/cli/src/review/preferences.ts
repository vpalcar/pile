import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Preferences } from "@pile/review-web/api";

/**
 * The review app's personal settings (theme, diff layout) live with the user, not
 * the repo, so they carry across repos and runs: $XDG_CONFIG_HOME/pile/review.json,
 * by default ~/.config/pile/review.json.
 */
export function preferencesPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "pile", "review.json");
}

const RULES: { [K in keyof Preferences]-?: (value: unknown) => value is Preferences[K] } = {
  theme: (v): v is Preferences["theme"] => v === "system" || v === "light" || v === "dark",
  diffMode: (v): v is Preferences["diffMode"] => v === "split" || v === "unified",
  diffWrap: (v): v is boolean => typeof v === "boolean",
  treeOpen: (v): v is boolean => typeof v === "boolean",
};

/** Only known keys with valid values; anything else in the file is ignored. */
function clean(input: unknown): Preferences {
  const out: Preferences = {};
  if (!input || typeof input !== "object") return out;
  for (const [key, valid] of Object.entries(RULES) as Array<[keyof Preferences, (v: unknown) => boolean]>) {
    const value = (input as Record<string, unknown>)[key];
    if (valid(value)) (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export function readPreferences(path = preferencesPath()): Preferences {
  try {
    return clean(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/** Merges `change` into the file (written atomically) and returns the result. */
export function writePreferences(change: unknown, path = preferencesPath()): Preferences {
  const next = { ...readPreferences(path), ...clean(change) };
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(temp, path);
  return next;
}

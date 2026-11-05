import type { HighlighterCore, ThemedToken } from "shiki/core";

/**
 * Syntax highlighting with Shiki's JavaScript regex engine (no WASM). Grammars load
 * on first use, each as its own chunk.
 */

const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("@shikijs/langs/typescript"),
  tsx: () => import("@shikijs/langs/tsx"),
  javascript: () => import("@shikijs/langs/javascript"),
  jsx: () => import("@shikijs/langs/jsx"),
  json: () => import("@shikijs/langs/json"),
  jsonc: () => import("@shikijs/langs/jsonc"),
  json5: () => import("@shikijs/langs/json5"),
  css: () => import("@shikijs/langs/css"),
  scss: () => import("@shikijs/langs/scss"),
  less: () => import("@shikijs/langs/less"),
  html: () => import("@shikijs/langs/html"),
  vue: () => import("@shikijs/langs/vue"),
  svelte: () => import("@shikijs/langs/svelte"),
  markdown: () => import("@shikijs/langs/markdown"),
  mdx: () => import("@shikijs/langs/mdx"),
  yaml: () => import("@shikijs/langs/yaml"),
  toml: () => import("@shikijs/langs/toml"),
  ini: () => import("@shikijs/langs/ini"),
  shellscript: () => import("@shikijs/langs/shellscript"),
  python: () => import("@shikijs/langs/python"),
  ruby: () => import("@shikijs/langs/ruby"),
  go: () => import("@shikijs/langs/go"),
  rust: () => import("@shikijs/langs/rust"),
  java: () => import("@shikijs/langs/java"),
  kotlin: () => import("@shikijs/langs/kotlin"),
  swift: () => import("@shikijs/langs/swift"),
  c: () => import("@shikijs/langs/c"),
  cpp: () => import("@shikijs/langs/cpp"),
  csharp: () => import("@shikijs/langs/csharp"),
  php: () => import("@shikijs/langs/php"),
  sql: () => import("@shikijs/langs/sql"),
  graphql: () => import("@shikijs/langs/graphql"),
  prisma: () => import("@shikijs/langs/prisma"),
  xml: () => import("@shikijs/langs/xml"),
  hcl: () => import("@shikijs/langs/hcl"),
  lua: () => import("@shikijs/langs/lua"),
  elixir: () => import("@shikijs/langs/elixir"),
  dart: () => import("@shikijs/langs/dart"),
  scala: () => import("@shikijs/langs/scala"),
  dockerfile: () => import("@shikijs/langs/dockerfile"),
  makefile: () => import("@shikijs/langs/makefile"),
};

export const THEMES = { dark: "pile-dark", light: "pile-light" } as const;

let highlighter: Promise<HighlighterCore> | null = null;
const loaded = new Map<string, Promise<boolean>>();

function getHighlighter(): Promise<HighlighterCore> {
  // Shiki itself loads on first use, so it never delays the first paint.
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("@shikijs/themes/one-dark-pro"),
    import("@shikijs/themes/one-light"),
  ]).then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, dark, light]) =>
    createHighlighterCore({
      themes: [
        // Keep the grammar colors, drop the theme background so the diff colors show.
        { ...dark.default, name: THEMES.dark, bg: "transparent" },
        { ...light.default, name: THEMES.light, bg: "transparent" },
      ],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    }),
  );
  return highlighter;
}

async function ensureLanguage(lang: string): Promise<boolean> {
  if (!LANGS[lang]) return false;
  if (!loaded.has(lang)) {
    loaded.set(
      lang,
      Promise.all([getHighlighter(), LANGS[lang]()])
        .then(async ([h, mod]) => {
          await h.loadLanguage((mod as { default: Parameters<HighlighterCore["loadLanguage"]>[0] }).default);
          return true;
        })
        .catch(() => false),
    );
  }
  return loaded.get(lang)!;
}

export type Token = { content: string; dark?: string; light?: string };

/**
 * Tokens per line for a block of code. Lines are highlighted together so multi-line
 * constructs (strings, comments) color correctly. Returns null for plain text.
 */
export async function highlightLines(lines: string[], lang: string | null): Promise<Token[][] | null> {
  if (!lang || lines.length === 0 || !(await ensureLanguage(lang))) return null;
  const h = await getHighlighter();
  try {
    const result = h.codeToTokens(lines.join("\n"), {
      lang,
      themes: { dark: THEMES.dark, light: THEMES.light },
      defaultColor: false,
    });
    return result.tokens.map((line: ThemedToken[]) =>
      line.map((token) => ({
        content: token.content,
        dark: token.htmlStyle?.["--shiki-dark"] ?? token.color,
        light: token.htmlStyle?.["--shiki-light"],
      })),
    );
  } catch {
    return null;
  }
}

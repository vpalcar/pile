/**
 * Errors with a stable `code` that commands can surface in JSON output, plus a
 * human hint for what to do next.
 */
export class PileGitHubError extends Error {
  readonly code: string;
  readonly hint?: string;

  constructor(code: string, message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "PileGitHubError";
    this.code = code;
    this.hint = hint;
  }
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status: unknown }).status)
    : undefined;
}

/**
 * Some environments (for example Claude Code cloud sessions) proxy GitHub and
 * reject every GraphQL request with a 403, whatever the token.
 */
export function isGraphQLUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return errorStatus(error) === 403 && /graphql/i.test(message);
}

/**
 * Pile only uses GraphQL where GitHub has no REST equivalent (draft <-> ready).
 * Wraps such a call so a blocked endpoint becomes an actionable error.
 */
export async function withGraphQL<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (isGraphQLUnavailable(error)) {
      throw new PileGitHubError(
        "GRAPHQL_UNAVAILABLE",
        `${operation} needs GitHub's GraphQL API, which is blocked in this environment.`,
        "GitHub has no REST endpoint for this. Change it in the GitHub web UI, or run pile from an environment with GraphQL access.",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Parses a PR reference: `42`, `#42`, or a GitHub pull request URL. Returns null for anything else. */
export function parsePRNumber(target: string): number | null {
  const trimmed = target.trim();
  const plain = trimmed.match(/^#?(\d+)$/);
  if (plain) return parseInt(plain[1], 10);
  const url = trimmed.match(/^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/);
  return url ? parseInt(url[1], 10) : null;
}

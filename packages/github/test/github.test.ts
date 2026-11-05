import { describe, expect, it } from "vitest";
import { Octokit } from "@octokit/rest";
import { createGitHubClient, parseGitRemote } from "../src/client.js";
import { PROperations } from "../src/pr.js";
import { PileGitHubError, isGraphQLUnavailable, parsePRNumber } from "../src/errors.js";

type Handler = (url: URL, init: RequestInit) => { status?: number; body: unknown } | undefined;

/** PROperations backed by a fake fetch. Records every request as "METHOD /path". */
function fakeGitHub(handler: Handler) {
  const requests: string[] = [];
  const octokit = new Octokit({
    auth: "token",
    request: {
      fetch: async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        requests.push(`${init.method ?? "GET"} ${url.pathname}`);
        const response = handler(url, init) ?? { status: 404, body: { message: "Not Found" } };
        return new Response(JSON.stringify(response.body), {
          status: response.status ?? 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  });
  const client = createGitHubClient({ token: "token", owner: "o", repo: "r", octokit });
  return { prs: new PROperations(client), requests };
}

const rawPR = (number: number, ref = `branch-${number}`) => ({
  number,
  node_id: `PR_${number}`,
  title: `PR ${number}`,
  body: null,
  state: "open",
  draft: false,
  head: { ref, sha: `sha${number}` },
  base: { ref: "main", sha: "base" },
  html_url: `https://github.com/o/r/pull/${number}`,
  merged_at: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  user: { login: "me" },
});

describe("parseGitRemote", () => {
  it.each([
    ["git@github.com:owner/repo.git", "owner", "repo"],
    ["git@github.com:owner/repo", "owner", "repo"],
    ["https://github.com/owner/repo.git", "owner", "repo"],
    ["https://github.com/owner/repo", "owner", "repo"],
    ["https://user@github.com/owner/repo.git", "owner", "repo"],
    ["ssh://git@github.com/owner/repo.git", "owner", "repo"],
    ["ssh://git@github.com:22/owner/repo.git", "owner", "repo"],
    ["https://github.com/owner/repo.with.dots.git\n", "owner", "repo.with.dots"],
  ])("parses %s", (url, owner, repo) => {
    expect(parseGitRemote(url)).toEqual({ owner, repo });
  });

  it("rejects non-GitHub remotes", () => {
    expect(parseGitRemote("git@gitlab.com:owner/repo.git")).toBeNull();
    expect(parseGitRemote("/tmp/repo.git")).toBeNull();
  });
});

describe("parsePRNumber", () => {
  it("accepts numbers, #numbers and PR URLs", () => {
    expect(parsePRNumber("42")).toBe(42);
    expect(parsePRNumber("#42")).toBe(42);
    expect(parsePRNumber("https://github.com/o/r/pull/42")).toBe(42);
    expect(parsePRNumber("https://github.com/o/r/pull/42/files")).toBe(42);
  });

  it("treats anything else as a branch name", () => {
    expect(parsePRNumber("feature/42")).toBeNull();
    expect(parsePRNumber("42-fix")).toBeNull();
  });
});

describe("PROperations", () => {
  it("fetches reviews, check runs and commit statuses in parallel and combines them", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { prs } = fakeGitHub((url) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => inFlight--, 0);
      if (url.pathname === "/repos/o/r/pulls/7") return { body: rawPR(7) };
      if (url.pathname === "/repos/o/r/pulls/7/reviews") {
        return { body: [{ id: 1, user: { login: "rev" }, state: "APPROVED", submitted_at: "2026-01-02T00:00:00Z" }] };
      }
      if (url.pathname === "/repos/o/r/commits/sha7/check-runs") {
        return {
          body: {
            total_count: 3,
            check_runs: [
              { status: "completed", conclusion: "success" },
              { status: "completed", conclusion: "skipped" },
              { status: "in_progress", conclusion: null },
            ],
          },
        };
      }
      if (url.pathname === "/repos/o/r/commits/sha7/status") {
        return { body: { state: "failure", statuses: [{ state: "failure" }] } };
      }
      return undefined;
    });

    const pr = await prs.getEnriched(7);
    expect(pr.reviews.map((r) => r.state)).toEqual(["APPROVED"]);
    expect(pr.checks).toEqual({ state: "pending", total: 4, passed: 2, failed: 1, pending: 1 });
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
  });

  it("resolves numbers, URLs and branches to a PR", async () => {
    const { prs, requests } = fakeGitHub((url) => {
      if (url.pathname === "/repos/o/r/pulls/5") return { body: rawPR(5) };
      if (url.pathname === "/repos/o/r/pulls" && url.searchParams.get("head") === "o:feature") {
        return { body: url.searchParams.get("state") === "open" ? [] : [rawPR(9, "feature")] };
      }
      return undefined;
    });

    expect((await prs.resolve("#5")).number).toBe(5);
    expect((await prs.resolve("https://github.com/o/r/pull/5")).number).toBe(5);
    expect((await prs.resolve("feature")).number).toBe(9);
    expect(requests.filter((r) => r === "GET /repos/o/r/pulls")).toHaveLength(2);
  });

  it("reports a missing PR with a stable code", async () => {
    const { prs } = fakeGitHub((url) => (url.pathname === "/repos/o/r/pulls" ? { body: [] } : undefined));
    await expect(prs.resolve("nope")).rejects.toMatchObject({ code: "PR_NOT_FOUND" });
  });

  it("maps a blocked GraphQL endpoint to GRAPHQL_UNAVAILABLE", async () => {
    const { prs } = fakeGitHub((url) => {
      if (url.pathname === "/repos/o/r/pulls/3") return { body: rawPR(3) };
      if (url.pathname === "/graphql") {
        return {
          status: 403,
          body: { message: "GitHub GraphQL is not available from Claude Code sessions. Use gh api repos/{owner}/{repo}/..." },
        };
      }
      return undefined;
    });

    const error = await prs.convertToDraft(3).catch((e) => e);
    expect(error).toBeInstanceOf(PileGitHubError);
    expect(error).toMatchObject({ code: "GRAPHQL_UNAVAILABLE" });
    expect(isGraphQLUnavailable(error.cause)).toBe(true);
  });

  it("uses REST only for everyday reads", async () => {
    const { prs, requests } = fakeGitHub((url) => {
      if (url.pathname === "/repos/o/r/pulls") return { body: [rawPR(1), rawPR(2)] };
      if (url.pathname.endsWith("/reviews")) return { body: [] };
      if (url.pathname.endsWith("/check-runs")) return { body: { total_count: 0, check_runs: [] } };
      if (url.pathname.endsWith("/status")) return { body: { state: "pending", statuses: [] } };
      return undefined;
    });

    await prs.listOpenEnriched();
    expect(requests.some((r) => r.includes("graphql"))).toBe(false);
  });
});

import type { PileInstance } from "@pile/core";
import type { GitHubInstance, PullRequest, StackLink } from "@pile/github";

/** What this run already knows about a branch's PR: submitted, merged, or queued offline. */
export type KnownPR = { number: number; stack?: PullRequest["stack"] | null } | "merged" | "queued";

/**
 * The open PRs from the trunk up to `branch`, bottom first, for registering a GitHub
 * stack, or why there can't be one (named, so it's never skipped silently). Branches
 * this run didn't submit are found by their recorded PR number, or by branch when pile
 * has none (a PR opened with gh or on the website); numbers found are recorded.
 */
export async function stackChain(
  pile: PileInstance,
  github: GitHubInstance,
  branch: string,
  known: Map<string, KnownPR>,
): Promise<{ chain: StackLink[] } | { blocked: string }> {
  const chain: StackLink[] = [];
  for (const name of pile.stack.getAncestry(branch)) {
    const here = known.get(name);
    if (here === "merged") continue;
    if (here === "queued") return { blocked: `${name} is queued until you're online` };
    if (here) {
      chain.push({ number: here.number, branch: name, stack: here.stack ?? null });
      continue;
    }
    const recorded = pile.state.getBranchRelationship(name)?.prNumber;
    let pr = recorded ? await github.prs.get(recorded).catch(() => null) : null;
    // No number, or the recorded PR was closed: look the branch up on GitHub.
    if (!pr || (pr.state !== "open" && !pr.merged)) pr = await github.prs.findByBranchAnyState(name).catch(() => null);
    if (pr?.merged) continue;
    if (!pr || pr.state !== "open") return { blocked: `${name} has no open pull request (\`pile submit -s\` opens one)` };
    if (pr.number !== recorded) pile.stack.setPRInfo(name, pr.number, pr.html_url);
    chain.push({ number: pr.number, branch: name, stack: pr.stack ?? null });
  }
  return { chain };
}

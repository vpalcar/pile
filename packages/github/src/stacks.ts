import type { PROperations } from "./pr.js";
import type { PRStackInfo } from "./types.js";

/** One open PR of the chain being submitted, bottom first. */
export interface StackLink {
  number: number;
  branch: string;
  /** Its native stack, as GitHub reported it (null or missing: none). */
  stack?: PRStackInfo | null;
}

export type StackSyncResult =
  | { action: "created" | "extended" | "rebuilt" | "unchanged"; stackNumber: number; prs: number[] }
  /** A sibling branch already holds the native stack here; GitHub stacks can't branch. */
  | { action: "diverged"; stackNumber: number; outside: number[] }
  | { action: "skipped"; reason: string };

/**
 * Makes GitHub's native stack match `chain` (open PRs, bottom first, each based on the
 * one below): a new stack, PRs added on top of the existing one, or, when the order
 * changed (branches moved), the stack rebuilt. Native stacks are linear, so when the
 * chain parts from the stack at a branch that is still a sibling in pile's tree
 * (`isSibling`), the existing stack is left alone.
 */
export async function syncStack(
  prs: PROperations,
  chain: StackLink[],
  { isSibling = () => false }: { isSibling?: (branch: string, parent: string) => boolean } = {},
): Promise<StackSyncResult> {
  const numbers = chain.map((l) => l.number);
  if (chain.length < 2) return { action: "skipped", reason: "a single pull request isn't a stack" };
  try {
    const existing = [...new Set(chain.flatMap((l) => (l.stack ? [l.stack.number] : [])))];
    if (existing.length === 0) {
      const created = await prs.createStack(numbers);
      return { action: "created", stackNumber: created.number, prs: numbers };
    }
    if (existing.length === 1) {
      const stack = await prs.getStack(existing[0]);
      const open = stack.pullRequests.filter((p) => !p.merged);
      const same = (i: number) => open[i]?.number === numbers[i];
      let k = 0;
      while (k < Math.min(open.length, numbers.length) && same(k)) k++;
      // The chain is the stack, or its lower part (submitted from a branch below the top).
      if (k === numbers.length) return { action: "unchanged", stackNumber: stack.number, prs: open.map((p) => p.number) };
      // The stack is the chain's lower part: put the rest on top.
      if (k === open.length) {
        await prs.addToStack(stack.number, numbers.slice(k));
        return { action: "extended", stackNumber: stack.number, prs: numbers };
      }
      // They part at k: a sibling branch keeps the stack; anything else is out of date.
      if (k > 0 && isSibling(open[k].branch, chain[k - 1].branch)) {
        return { action: "diverged", stackNumber: stack.number, outside: numbers.slice(k) };
      }
    }
    for (const n of existing) await prs.unstack(n);
    const created = await prs.createStack(numbers);
    return { action: "rebuilt", stackNumber: created.number, prs: numbers };
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = (error as Error).message?.replace(/ - https:.*$/, "") ?? String(error);
    if (status === 404) return { action: "skipped", reason: "GitHub stacks aren't available for this repository" };
    return { action: "skipped", reason: `GitHub refused the stack: ${message}` };
  }
}

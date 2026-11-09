import type { PileInstance } from "@pile/core";
import type { GitHubInstance } from "@pile/github";

/**
 * After a branch's PR merged: its children move onto its parent (locally, and their
 * PRs on GitHub unless a native stack already did that), pile stops tracking it, and
 * the local branch is deleted unless it's checked out. Used by `pile merge` and by
 * merges from the review app.
 */
export async function cleanupMergedBranch(
  pile: PileInstance,
  github: GitHubInstance,
  branch: string,
  trunk: string,
  retargetPRs = true,
): Promise<void> {
  // Get children before cleaning up
  const children = pile.state.getChildren(branch);
  const parent = pile.state.getParent(branch);
  const newParent = parent ?? trunk;

  // Update children's parent and PR bases
  for (const child of children) {
    const childRel = pile.state.getBranchRelationship(child);
    if (childRel) {
      pile.state.setBranchRelationship(child, {
        ...childRel,
        parent: newParent,
      });

      // Update the child's PR base on GitHub (native stacks do this themselves). Pile may
      // not know the PR's number (opened outside pile): look it up by branch.
      const prNumber = retargetPRs ? (childRel.prNumber ?? (await github.prs.findByBranch(child).catch(() => null))?.number) : undefined;
      if (prNumber) {
        try {
          await github.prs.update({
            number: prNumber,
            base: newParent,
          });
        } catch {
          // If retargeting to parent fails, try retargeting to trunk as fallback
          if (newParent !== trunk) {
            try {
              await github.prs.update({
                number: prNumber,
                base: trunk,
              });
              pile.state.setBranchRelationship(child, {
                ...childRel,
                parent: trunk,
              });
            } catch {
              // PR update failed entirely, will need manual fix
            }
          }
        }
      }
    }
  }

  // Remove tracking
  pile.state.removeBranchRelationship(branch);

  // Delete the local branch (if not currently on it)
  try {
    const current = await pile.git.getCurrentBranch();
    if (current !== branch) {
      await pile.git.deleteBranch(branch, true);
    }
  } catch {
    // Branch might not exist or other issue
  }
}

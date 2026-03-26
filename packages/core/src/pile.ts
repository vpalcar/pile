import { GitOperations, createGitOperations } from "./git.js";
import { StateManager, createStateManager } from "./state.js";
import { StackManager, createStackManager } from "./stack.js";

export interface PileInstance {
  git: GitOperations;
  state: StateManager;
  stack: StackManager;
}

export async function createPile(repoPath?: string): Promise<PileInstance> {
  const git = createGitOperations(repoPath);
  const repoRoot = await git.getRepoRoot();
  const state = createStateManager(repoRoot);
  const stack = createStackManager(git, state);

  return { git, state, stack };
}

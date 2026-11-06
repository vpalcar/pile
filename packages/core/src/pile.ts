import { GitOperations, createGitOperations } from "./git.js";
import { StateManager, createStateManager } from "./state.js";
import { StackManager, createStackManager } from "./stack.js";
import { createNotesStore, type NotesStore } from "./notes.js";

export interface PileInstance {
  git: GitOperations;
  state: StateManager;
  stack: StackManager;
  /** Review notes for the agent working on a branch (.pile/notes.json). */
  notes: NotesStore;
}

export async function createPile(repoPath?: string): Promise<PileInstance> {
  const git = createGitOperations(repoPath);
  const repoRoot = await git.getRepoRoot();
  const state = createStateManager(repoRoot);
  const stack = createStackManager(git, state);

  // Branch deletes and renames rewrite `branch.<name>.*` config behind the cache.
  git.onConfigChanged = () => state.invalidate();
  const remote = state.getConfig()?.remote;
  if (remote) git.setRemoteName(remote);

  return { git, state, stack, notes: createNotesStore(repoRoot) };
}

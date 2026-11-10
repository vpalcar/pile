// Schemas and types
export {
  CommitSchema,
  BranchSchema,
  StackSchema,
  RepoConfigSchema,
  BranchRelationshipSchema,
  StacksStateSchema,
  PendingOperationSchema,
  PendingOpsSchema,
  type Commit,
  type Branch,
  type Stack,
  type RepoConfig,
  type BranchRelationship,
  type StacksState,
  type PendingOperation,
  type PendingOps,
  type SyncStatus,
  type PRStatus,
  type StackNode,
  type StackStatusOutput,
  type CommandResult,
} from "./schemas.js";

// Git operations
export { GitOperations, createGitOperations, type CommitOptions, type RefSnapshot, type RebaseResult } from "./git.js";

// State management
export { StateManager, createStateManager, type RestackState } from "./state.js";

// Stack management
export {
  StackManager,
  createStackManager,
  type RestackResult,
  type NavigationDirection,
  type NavigationPlan,
} from "./stack.js";

// Process execution
export { runGit, runGitSync, GitError, getGitCallCount, mapLimit } from "./exec.js";

// Review notes
export { NotesStore, createNotesStore, formatNotes, type Note, type NewNote, type NoteFilter } from "./notes.js";

// Pile instance
export { createPile, type PileInstance } from "./pile.js";

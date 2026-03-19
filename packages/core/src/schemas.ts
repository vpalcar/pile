import { z } from "zod";

// Sync status for branches
export type SyncStatus = "synced" | "pending" | "conflict" | "ahead" | "behind";

// Commit schema
export const CommitSchema = z.object({
  hash: z.string(),
  message: z.string(),
  author: z.string(),
  date: z.string(),
});
export type Commit = z.infer<typeof CommitSchema>;

// Branch schema
export const BranchSchema = z.object({
  name: z.string(),
  parent: z.string().nullable(),
  commits: z.array(CommitSchema),
  prNumber: z.number().optional(),
  prUrl: z.string().optional(),
  syncStatus: z.enum(["synced", "pending", "conflict", "ahead", "behind"]),
  tracked: z.boolean().default(true),
});
export type Branch = z.infer<typeof BranchSchema>;

// Stack schema
export const StackSchema = z.object({
  id: z.string(),
  branches: z.array(BranchSchema),
  trunk: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Stack = z.infer<typeof StackSchema>;

// Repository configuration
export const RepoConfigSchema = z.object({
  trunk: z.string(),
  remote: z.string().default("origin"),
  initialized: z.boolean().default(false),
});
export type RepoConfig = z.infer<typeof RepoConfigSchema>;

// Branch relationship (stored in stacks.json)
export const BranchRelationshipSchema = z.object({
  name: z.string(),
  parent: z.string().nullable(),
  prNumber: z.number().optional(),
  prUrl: z.string().optional(),
});
export type BranchRelationship = z.infer<typeof BranchRelationshipSchema>;

// Stacks state (stored in stacks.json)
export const StacksStateSchema = z.object({
  branches: z.record(z.string(), BranchRelationshipSchema),
});
export type StacksState = z.infer<typeof StacksStateSchema>;

// Pending operation types for offline queue
export const PendingOperationSchema = z.object({
  id: z.string(),
  type: z.enum(["create_pr", "update_pr", "submit_review", "push", "merge"]),
  payload: z.unknown(),
  createdAt: z.string(),
  retries: z.number().default(0),
});
export type PendingOperation = z.infer<typeof PendingOperationSchema>;

// Pending operations queue
export const PendingOpsSchema = z.object({
  operations: z.array(PendingOperationSchema),
});
export type PendingOps = z.infer<typeof PendingOpsSchema>;

// PR status type
export type PRStatus =
  | "draft"
  | "open"
  | "approved"
  | "changes_requested"
  | "merged"
  | "closed";

// Stack node for tree representation
export interface StackNode {
  branch: Branch;
  children: StackNode[];
  depth: number;
  isCurrentBranch: boolean;
}

// Stack status output for JSON mode
export interface StackStatusOutput {
  branches: Array<{
    name: string;
    parent: string | null;
    pr: number | null;
    prUrl: string | null;
    status: PRStatus | null;
    reviews: number;
    isCurrent: boolean;
  }>;
  currentBranch: string;
  trunk: string;
  hasConflicts: boolean;
  pendingOperations: number;
  isOffline: boolean;
}

// Generic command result
export interface CommandResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
}

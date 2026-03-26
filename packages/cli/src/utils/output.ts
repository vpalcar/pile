import { Stack, StackStatusOutput, CommandResult } from "@pile/core";

export interface OutputOptions {
  json: boolean;
}

export function formatJson<T>(data: T): string {
  return JSON.stringify(data, null, 2);
}

export function stackToJson(
  stack: Stack | null,
  currentBranch: string,
  pendingOps: number,
  isOnline = true
): StackStatusOutput {
  if (!stack) {
    return {
      branches: [],
      currentBranch,
      trunk: "main",
      hasConflicts: false,
      pendingOperations: pendingOps,
      isOffline: !isOnline,
    };
  }

  return {
    branches: stack.branches.map((b) => ({
      name: b.name,
      parent: b.parent,
      pr: b.prNumber ?? null,
      prUrl: b.prUrl ?? null,
      status: null, // Would be populated from GitHub API
      reviews: 0, // Would be populated from GitHub API
      isCurrent: b.name === currentBranch,
    })),
    currentBranch,
    trunk: stack.trunk,
    hasConflicts: stack.branches.some((b) => b.syncStatus === "conflict"),
    pendingOperations: pendingOps,
    isOffline: !isOnline,
  };
}

export function createResult<T>(
  success: boolean,
  data?: T,
  error?: string,
  message?: string
): CommandResult<T> {
  return {
    success,
    data,
    error,
    message,
  };
}

export function outputResult<T>(
  result: CommandResult<T>,
  options: OutputOptions
): void {
  if (options.json) {
    console.log(formatJson(result));
  }
}

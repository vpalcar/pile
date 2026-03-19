import { PendingOps, PendingOperation } from "@pile/core";
import { PROperations } from "./pr.js";
import { PRCacheManager } from "./cache.js";

export interface QueueProcessorConfig {
  prs: PROperations;
  cache: PRCacheManager;
  maxRetries: number;
}

export interface ProcessResult {
  processed: number;
  failed: number;
  results: Array<{
    operation: PendingOperation;
    success: boolean;
    error?: string;
  }>;
}

export class OfflineQueueProcessor {
  private prs: PROperations;
  private cache: PRCacheManager;
  private maxRetries: number;

  constructor(config: QueueProcessorConfig) {
    this.prs = config.prs;
    this.cache = config.cache;
    this.maxRetries = config.maxRetries;
  }

  async process(
    ops: PendingOps,
    onOperationComplete: (id: string, success: boolean) => void,
    onOperationRetry: (id: string) => void
  ): Promise<ProcessResult> {
    const results: ProcessResult["results"] = [];
    let processed = 0;
    let failed = 0;

    for (const op of ops.operations) {
      if (op.retries >= this.maxRetries) {
        failed++;
        results.push({
          operation: op,
          success: false,
          error: "Max retries exceeded",
        });
        continue;
      }

      try {
        await this.processOperation(op);
        processed++;
        results.push({ operation: op, success: true });
        onOperationComplete(op.id, true);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        if (this.isRetryableError(error)) {
          onOperationRetry(op.id);
          results.push({
            operation: op,
            success: false,
            error: `Will retry: ${errorMessage}`,
          });
        } else {
          failed++;
          results.push({
            operation: op,
            success: false,
            error: errorMessage,
          });
          onOperationComplete(op.id, false);
        }
      }
    }

    return { processed, failed, results };
  }

  private async processOperation(op: PendingOperation): Promise<void> {
    const payload = op.payload as Record<string, unknown>;

    switch (op.type) {
      case "create_pr":
        await this.processCreatePR(payload);
        break;
      case "update_pr":
        await this.processUpdatePR(payload);
        break;
      case "push":
        // Push operations are handled by git, not here
        break;
      case "merge":
        await this.prs.merge(
          payload.prNumber as number,
          (payload.method as "merge" | "squash" | "rebase") ?? "squash"
        );
        break;
      case "submit_review":
        // Review submission would go here
        break;
      default:
        throw new Error(`Unknown operation type: ${op.type}`);
    }
  }

  private async processCreatePR(payload: Record<string, unknown>): Promise<void> {
    const pr = await this.prs.create({
      title: payload.title as string,
      body: payload.body as string | undefined,
      head: payload.branch as string,
      base: payload.base as string,
      draft: payload.draft as boolean | undefined,
    });

    this.cache.cachePR(pr);

    if (payload.reviewers && Array.isArray(payload.reviewers)) {
      await this.prs.requestReviewers(pr.number, payload.reviewers as string[]);
    }
  }

  private async processUpdatePR(payload: Record<string, unknown>): Promise<void> {
    const pr = await this.prs.update({
      number: payload.prNumber as number,
      title: payload.title as string | undefined,
      body: payload.body as string | undefined,
      base: payload.base as string | undefined,
    });

    this.cache.cachePR(pr);
  }

  private isRetryableError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;

    const message = error.message.toLowerCase();
    return (
      message.includes("network") ||
      message.includes("enotfound") ||
      message.includes("econnrefused") ||
      message.includes("timeout") ||
      message.includes("socket") ||
      message.includes("unable to resolve") ||
      message.includes("rate limit")
    );
  }
}

export function createQueueProcessor(config: QueueProcessorConfig): OfflineQueueProcessor {
  return new OfflineQueueProcessor(config);
}

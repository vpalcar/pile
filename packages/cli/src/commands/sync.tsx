import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import { createPile } from "@pile/core";
import { createGitHub, createQueueProcessor } from "@pile/github";
import { Spinner } from "../components/Spinner.js";
import {
  SuccessMessage,
  ErrorMessage,
  WarningMessage,
} from "../components/Message.js";
import { OutputOptions, formatJson, createResult } from "../utils/output.js";

export interface SyncCommandProps {
  options: OutputOptions;
}

interface RestackResult {
  branch: string;
  success: boolean;
  conflicts: boolean;
}

interface QueueResult {
  processed: number;
  failed: number;
}

type State =
  | "checking"
  | "processing_queue"
  | "fetching"
  | "updating_trunk"
  | "restacking"
  | "refreshing_prs"
  | "success"
  | "conflict"
  | "not_initialized"
  | "error";

export function SyncCommand({ options }: SyncCommandProps): React.ReactElement {
  const [state, setState] = useState<State>("checking");
  const [error, setError] = useState<string | null>(null);
  const [restackResults, setRestackResults] = useState<RestackResult[]>([]);
  const [conflictBranch, setConflictBranch] = useState<string | null>(null);
  const [queueResult, setQueueResult] = useState<QueueResult | null>(null);

  useEffect(() => {
    async function sync() {
      try {
        const pile = await createPile();

        if (!pile.state.isInitialized()) {
          if (options.json) {
            console.log(
              formatJson(createResult(false, null, "Pile not initialized"))
            );
            process.exit(1);
          }
          setState("not_initialized");
          return;
        }

        const repoRoot = await pile.git.getRepoRoot();
        const github = await createGitHub(`${repoRoot}/.pile`);

        // Process pending operations if GitHub is available
        if (github && pile.state.hasPendingOperations()) {
          setState("processing_queue");
          const pendingOps = pile.state.getPendingOps();
          const processor = createQueueProcessor({
            prs: github.prs,
            cache: github.cache,
            maxRetries: 3,
          });

          const queueProcessResult = await processor.process(
            pendingOps,
            (id, success) => {
              if (success) {
                pile.state.removeOperation(id);
              }
            },
            (id) => {
              pile.state.incrementOperationRetry(id);
            }
          );

          setQueueResult({
            processed: queueProcessResult.processed,
            failed: queueProcessResult.failed,
          });
        }

        setState("fetching");
        const result = await pile.stack.syncStack();

        if (result.error) {
          throw new Error(result.error);
        }

        setRestackResults(result.restacked);

        // Check for conflicts
        const conflictResult = result.restacked.find((r) => r.conflicts);
        if (conflictResult) {
          setConflictBranch(conflictResult.branch);
          if (options.json) {
            console.log(
              formatJson(
                createResult(
                  false,
                  { restacked: result.restacked, queue: queueResult },
                  `Conflict in ${conflictResult.branch}`
                )
              )
            );
            process.exit(1);
          }
          setState("conflict");
          return;
        }

        // Refresh PR cache
        setState("refreshing_prs");
        if (github) {
          const trackedBranches = pile.stack.getAllTrackedBranches();
          for (const branch of trackedBranches) {
            try {
              const pr = await github.prs.findByBranch(branch);
              if (pr) {
                github.cache.cachePR(pr);
              }
            } catch {
              // Ignore errors when refreshing individual PRs
            }
          }
        }

        if (options.json) {
          console.log(
            formatJson(
              createResult(true, {
                restacked: result.restacked,
                queue: queueResult,
              })
            )
          );
          process.exit(0);
        }

        setState("success");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (options.json) {
          console.log(formatJson(createResult(false, null, message)));
          process.exit(1);
        }
        setError(message);
        setState("error");
      }
    }

    sync();
  }, [options.json]);

  if (options.json) {
    return <></>;
  }

  switch (state) {
    case "checking":
      return <Spinner label="Checking repository state..." />;
    case "processing_queue":
      return <Spinner label="Processing pending operations..." />;
    case "fetching":
      return <Spinner label="Fetching from remote..." />;
    case "updating_trunk":
      return <Spinner label="Updating trunk branch..." />;
    case "restacking":
      return <Spinner label="Restacking branches..." />;
    case "refreshing_prs":
      return <Spinner label="Refreshing PR statuses..." />;
    case "success":
      return (
        <Box flexDirection="column">
          <SuccessMessage>Sync complete</SuccessMessage>
          {queueResult &&
            (queueResult.processed > 0 || queueResult.failed > 0) && (
              <Box flexDirection="column" marginTop={1}>
                <Text color="gray">Pending operations:</Text>
                <Text color="green">
                  {"  "}✓ {queueResult.processed} processed
                </Text>
                {queueResult.failed > 0 && (
                  <Text color="red">
                    {"  "}✗ {queueResult.failed} failed
                  </Text>
                )}
              </Box>
            )}
          {restackResults.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Restacked branches:</Text>
              {restackResults.map((result) => (
                <Text
                  key={result.branch}
                  color={result.success ? "green" : "red"}
                >
                  {"  "}
                  {result.success ? "✓" : "✗"} {result.branch}
                </Text>
              ))}
            </Box>
          )}
          {restackResults.length === 0 && (
            <Text color="gray">No branches to restack.</Text>
          )}
        </Box>
      );
    case "conflict":
      return (
        <Box flexDirection="column">
          <WarningMessage>Rebase conflict in {conflictBranch}</WarningMessage>
          <Text color="gray">
            Resolve the conflict and run `git rebase --continue`, then run `pile
            sync` again.
          </Text>
          {restackResults.filter((r) => r.success).length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text color="gray">Successfully restacked before conflict:</Text>
              {restackResults
                .filter((r) => r.success)
                .map((result) => (
                  <Text key={result.branch} color="green">
                    {"  "}✓ {result.branch}
                  </Text>
                ))}
            </Box>
          )}
        </Box>
      );
    case "not_initialized":
      return (
        <ErrorMessage>Pile not initialized. Run `pile init` first.</ErrorMessage>
      );
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
    default:
      return <></>;
  }
}

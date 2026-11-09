import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { createPile } from "@pile/core";
import { createGitHub, parsePRNumber } from "@pile/github";
import type { ItemRef } from "@pile/review-web/api";
import { Spinner } from "../components/Spinner.js";
import { Link } from "../components/Link.js";
import { ErrorMessage, SuccessMessage } from "../components/Message.js";
import { OutputOptions, exitWithError, formatJson, toCommandError } from "../utils/output.js";
import { useFailureExitCode } from "../utils/exit-code.js";
import { openUrl } from "../utils/browser.js";
import { ReviewService } from "../review/service.js";
import { startReviewServer, type ReviewServer } from "../review/server.js";

export interface ReviewWebCommandProps {
  target?: string;
  port?: number;
  open: boolean;
  options: OutputOptions;
}

type State = "starting" | "running" | "error";

/** `pile review`: serves the review app on localhost until stopped. */
export function ReviewWebCommand({ target, port, open, options }: ReviewWebCommandProps): React.ReactElement {
  const { exit } = useApp();
  const [state, setState] = useState<State>("starting");
  const [server, setServer] = useState<ReviewServer | null>(null);
  const [repo, setRepo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFailureExitCode(state, ["error"]);

  useEffect(() => {
    let running: ReviewServer | null = null;
    const stop = () => {
      running?.close().finally(() => process.exit(0));
    };

    (async () => {
      try {
        const pile = await createPile();
        const github = await createGitHub(pile);
        const service = new ReviewService(pile, github);
        const initial = await resolveTarget(pile, target);
        const root = (await pile.git.run(["rev-parse", "--show-toplevel"]).catch(() => process.cwd())).trim();
        running = await startReviewServer({ service, initial, port, preferredPort: portFor(root) });
        // Fetch ahead while the browser opens; errors surface on the actual request.
        service.warm(initial).catch(() => {});
        setServer(running);
        setRepo(github ? `${github.client.repoOwner}/${github.client.repoName}` : null);

        if (options.json) {
          console.log(formatJson({ success: true, data: { url: running.url, port: running.port, github: !!github } }));
        } else if (!options.interactive) {
          console.log(running.url);
        }
        if (open) openUrl(running.url);
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        setState("running");
      } catch (err) {
        if (!options.interactive) exitWithError(options, toCommandError(err));
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    })();

    return () => {
      running?.close();
    };
  }, []);

  useInput(
    (input, key) => {
      if (input === "q" || key.escape) {
        server?.close().finally(() => {
          exit();
          process.exit(0);
        });
      }
      if (input === "o" && server) openUrl(server.url);
    },
    { isActive: options.interactive === true && state === "running" },
  );

  if (!options.interactive) return <></>;

  switch (state) {
    case "starting":
      return <Spinner label="Starting the review app..." />;
    case "running":
      return (
        <Box flexDirection="column">
          <SuccessMessage>
            Reviewing {repo ?? "local branches"} at <Link url={server!.url}>{`http://127.0.0.1:${server!.port}`}</Link>
          </SuccessMessage>
          <Text color="gray">  {open ? "Opened in your browser. " : ""}Press o to open again, q to stop.</Text>
        </Box>
      );
    case "error":
      return <ErrorMessage>{error}</ErrorMessage>;
  }
}

/** A PR number, #number or PR URL, or a branch (its PR when pile knows one). */
async function resolveTarget(pile: Awaited<ReturnType<typeof createPile>>, target: string | undefined): Promise<ItemRef | null> {
  if (!target) return null;
  const number = parsePRNumber(target);
  if (number !== null) return { kind: "pr", number };
  const stored = pile.state.getBranchRelationship(target)?.prNumber;
  if (stored) return { kind: "pr", number: stored };
  if (await pile.git.branchExists(target)) return { kind: "branch", name: target };
  throw new Error(`No pull request or local branch named "${target}"`);
}

/**
 * The same port for the same repo on every run (4100-4899), so the browser keeps its
 * per-page state (viewed files, unsent comments) between runs.
 */
export function portFor(repoRoot: string): number {
  let hash = 0;
  for (const char of repoRoot) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return 4100 + (hash % 800);
}

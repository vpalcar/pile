import { useEffect } from "react";

/**
 * In a terminal, commands render their outcome instead of exiting early, so the
 * exit code has to follow the rendered state. Without this, `pile x && pile y`
 * keeps going after a failure that was only shown on screen.
 */
export function useFailureExitCode<S extends string>(state: S, failures: readonly S[]): void {
  useEffect(() => {
    if (failures.includes(state)) {
      process.exitCode = 1;
    }
  }, [state]);
}

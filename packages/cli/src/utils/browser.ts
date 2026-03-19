import { exec } from "child_process";

/**
 * Opens a URL in the default browser.
 * Works cross-platform (macOS, Windows, Linux).
 */
export function openUrl(url: string): void {
  const platform = process.platform;
  let command: string;

  if (platform === "darwin") {
    command = `open "${url}"`;
  } else if (platform === "win32") {
    command = `start "" "${url}"`;
  } else {
    // Linux and other Unix-like systems
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    // Silently fail - the link is still clickable in the terminal
    if (error) {
      // Could log to debug, but don't interrupt the user
    }
  });
}

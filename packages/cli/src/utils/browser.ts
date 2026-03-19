import { exec } from "child_process";

export function openUrl(url: string): void {
  const platform = process.platform;

  let command: string;
  if (platform === "darwin") {
    command = `open "${url}"`;
  } else if (platform === "win32") {
    command = `start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      // Silently fail - the link is still clickable in the terminal
    }
  });
}

import React from "react";
import { Text } from "ink";

export interface LinkProps {
  url: string;
  children?: React.ReactNode;
}

/**
 * Renders a clickable hyperlink using OSC 8 escape sequences.
 * Supported in modern terminals like iTerm2, VS Code terminal, etc.
 */
export function Link({ url, children }: LinkProps): React.ReactElement {
  // OSC 8 escape sequence format: ESC ] 8 ; ; URL ST text ESC ] 8 ; ; ST
  // ST (String Terminator) can be ESC \ or BEL (\x07)
  const link = `\x1b]8;;${url}\x07${children ?? url}\x1b]8;;\x07`;
  return <Text>{link}</Text>;
}

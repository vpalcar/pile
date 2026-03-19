import React from "react";
import { Text } from "ink";

export interface LinkProps {
  url: string;
  children?: React.ReactNode;
}

export function Link({ url, children }: LinkProps): React.ReactElement {
  // OSC 8 hyperlink format: \x1b]8;;URL\x07TEXT\x1b]8;;\x07
  const link = `\x1b]8;;${url}\x07${children ?? url}\x1b]8;;\x07`;
  return <Text>{link}</Text>;
}

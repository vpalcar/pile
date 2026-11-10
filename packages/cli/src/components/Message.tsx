import React from "react";
import { Box, Text } from "ink";

const COLORS = {
  success: "green",
  error: "red",
  warning: "yellow",
  info: "blue",
} as const;

const ICONS = {
  success: "✓",
  error: "✗",
  warning: "⚠",
  info: "ℹ",
} as const;

export interface MessageProps {
  type: "success" | "error" | "warning" | "info";
  children: React.ReactNode;
}

export function Message({ type, children }: MessageProps): React.ReactElement {
  return (
    <Box>
      <Text color={COLORS[type]}>
        {ICONS[type]}{" "}
      </Text>
      <Text>{children}</Text>
    </Box>
  );
}

export function SuccessMessage({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <Message type="success">{children}</Message>;
}

export function ErrorMessage({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <Message type="error">{children}</Message>;
}

export function WarningMessage({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <Message type="warning">{children}</Message>;
}

export function InfoMessage({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return <Message type="info">{children}</Message>;
}

/** What the commit hooks printed (pile quiets git itself), so it's clear they ran. */
export function HookOutput({ output }: { output: string }): React.ReactElement | null {
  // Steps with nothing to do (lefthook's "(skip)" lines) say nothing useful.
  const lines = output.split("\n").filter((line) => line.trim() && !/\(skip\)|no matching (staged )?files/i.test(line));
  if (lines.length === 0) return null;
  const shown = lines.slice(-20);
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">  Hooks:</Text>
      {lines.length > shown.length && <Text color="gray">    … {lines.length - shown.length} more lines</Text>}
      {shown.map((line, i) => (
        <Text key={i} color="gray">
          {"    "}
          {line}
        </Text>
      ))}
    </Box>
  );
}


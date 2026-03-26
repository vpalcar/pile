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

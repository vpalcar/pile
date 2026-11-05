import React from "react";
import { Box, Text } from "ink";
import InkSpinner from "ink-spinner";

export interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps): React.ReactElement | null {
  // Animation frames are noise when output is piped or captured.
  if (!process.stdout.isTTY) return null;
  return (
    <Box>
      <Text color="cyan">
        <InkSpinner type="dots" />
      </Text>
      {label && <Text> {label}</Text>}
    </Box>
  );
}

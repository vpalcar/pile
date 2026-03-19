import React from "react";
import { Box, Text } from "ink";

export interface SyncStatusProps {
  isOnline: boolean;
  pendingOps: number;
}

export function SyncStatus({
  isOnline,
  pendingOps,
}: SyncStatusProps): React.ReactElement {
  return (
    <Box>
      <Text color={isOnline ? "green" : "yellow"}>
        {isOnline ? "● Online" : "○ Offline"}
      </Text>
      {pendingOps > 0 && (
        <Text color="yellow"> ({pendingOps} pending)</Text>
      )}
    </Box>
  );
}

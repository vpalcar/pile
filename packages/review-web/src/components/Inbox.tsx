import type { Inbox, InboxItem } from "../api";

/** Every inbox item in display order, for stepping with [ and ]. */
export function flatItems(inbox: Inbox | undefined): InboxItem[] {
  return inbox?.groups.flatMap((g) => g.items) ?? [];
}

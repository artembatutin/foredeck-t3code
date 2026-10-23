import { WorkItemId, type WorkSourceKind } from "@t3tools/contracts/fd/work-management";

/**
 * The one spelling of an item id that locks, caches and link rows key on. Trackers accept
 * several spellings of one item: GitHub reads `01` as issue 1 and Jira keys are
 * case-insensitive. Markdown ids are matched exactly, as the task files spell them.
 */
export const canonicalItemId = (kind: WorkSourceKind, itemId: WorkItemId): WorkItemId => {
  switch (kind) {
    case "github":
      return /^\d+$/.test(itemId) ? WorkItemId.make(itemId.replace(/^0+(?=\d)/, "")) : itemId;
    case "jira":
      return WorkItemId.make(itemId.toUpperCase());
    case "markdown":
      return itemId;
  }
};

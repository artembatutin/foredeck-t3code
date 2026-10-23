import { workSupport } from "@t3tools/client-runtime/fd/work-management";
import type { EnvironmentId, ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import { LinkIcon, ListChecksIcon } from "lucide-react";

import type { CommandPaletteActionItem } from "../../components/CommandPalette.logic";
import { ITEM_ICON_CLASS } from "../../components/CommandPalette.logic";
import { openLinkWorkItemDialog } from "./LinkWorkItemDialog";

/**
 * The palette's Work actions: open the page from anywhere, and link an item to the active
 * thread when its environment offers Work.
 */
export function workPaletteActions(input: {
  /** The palette's own environments; their server configs say who offers Work. */
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly serverConfig?: Pick<ServerConfig, "environment"> | null | undefined;
  }>;
  readonly activeThread: ScopedThreadRef | null;
  readonly openWork: () => Promise<void>;
}): ReadonlyArray<CommandPaletteActionItem> {
  const support = new Map(
    input.environments.flatMap((environment) => {
      const offered = workSupport(environment.serverConfig);
      return offered === undefined ? [] : [[environment.environmentId, offered] as const];
    }),
  );
  if (support.size === 0) return [];
  const actions: Array<CommandPaletteActionItem> = [
    {
      kind: "action",
      value: "action:work",
      searchTerms: ["work", "tasks", "issues", "jira", "github", "todo", "backlog"],
      title: "Open work",
      icon: <ListChecksIcon className={ITEM_ICON_CLASS} />,
      shortcutCommand: "work.open",
      run: input.openWork,
    },
  ];
  const thread = input.activeThread;
  if (thread !== null && support.get(thread.environmentId)?.features.has("links")) {
    actions.push({
      kind: "action",
      value: "action:link-work-item",
      searchTerms: ["link", "work", "task", "issue", "ticket", "attach"],
      title: "Link work item to thread",
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        openLinkWorkItemDialog(thread);
      },
    });
  }
  return actions;
}

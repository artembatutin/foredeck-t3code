import {
  isWorkNativeStatus,
  type WorkItemRef,
  type WorkNativeStatus,
  type WorkStartThreadInput,
  type WorkThreadMode,
} from "@t3tools/contracts/fd/work-management";

/**
 * Pure pieces of the mobile item actions. Native menus report the chosen action as one string id,
 * so status choices are encoded here and decoded back without trusting the id's shape.
 */

export const statusActionId = (
  choice: { readonly status: WorkNativeStatus } | { readonly transitionId: string },
): string => ("status" in choice ? `status:${choice.status}` : `transition:${choice.transitionId}`);

/** The status change a menu id names; transition ids may themselves contain colons. */
export const parseStatusActionId = (
  id: string,
): { readonly status: WorkNativeStatus } | { readonly transitionId: string } | null => {
  const at = id.indexOf(":");
  if (at <= 0) return null;
  const kind = id.slice(0, at);
  const value = id.slice(at + 1);
  if (value.length === 0) return null;
  if (kind === "transition") return { transitionId: value };
  if (kind === "status" && isWorkNativeStatus(value)) return { status: value };
  return null;
};

/** The start request a mobile thread launch sends. */
export const mobileStartInput = (input: {
  readonly ref: WorkItemRef;
  readonly mode: WorkThreadMode;
  readonly workspace: "root" | "worktree";
  readonly force: boolean;
}): WorkStartThreadInput => ({
  ref: input.ref,
  creationSource: "mobile",
  mode: input.mode,
  workspaceStrategy: input.workspace === "root" ? { type: "root" } : { type: "worktree" },
  force: input.force,
});

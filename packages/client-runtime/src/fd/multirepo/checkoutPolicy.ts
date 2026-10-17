export const MULTIREPO_CHECKOUT_NOTICE =
  "Multiple repositories use their existing shared checkouts. Worktrees and whole-turn undo are unavailable.";

export const usesSharedCheckouts = (
  workspace: { readonly repositories?: readonly unknown[] | undefined } | null | undefined,
) => (workspace?.repositories?.length ?? 0) > 1;

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { RunId, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type DiffPanelSelection =
  | { kind: "branch"; baseRef: string | null }
  | { kind: "unstaged" }
  | { kind: "thread" }
  | { kind: "turn"; turnId: RunId; filePath: string | null; revealRequestId: number };

// "branch" is the Changes view: everything this checkout changed since its base.
const DEFAULT_SELECTION: DiffPanelSelection = { kind: "branch", baseRef: null };

interface DiffPanelStoreState {
  byThreadKey: Record<string, DiffPanelSelection>;
  branchBaseRefByThreadKey: Record<string, string | null>;
  selectGitScope: (
    ref: ScopedThreadRef,
    scope: "branch" | "unstaged",
    repositoryId?: string,
  ) => void;
  selectThreadHistory: (ref: ScopedThreadRef, repositoryId?: string) => void;
  selectBranchBaseRef: (
    ref: ScopedThreadRef,
    baseRef: string | null,
    repositoryId?: string,
  ) => void;
  selectTurn: (
    ref: ScopedThreadRef,
    turnId: RunId,
    filePath?: string,
    repositoryId?: string,
  ) => void;
  reconcileTurnSelection: (
    ref: ScopedThreadRef,
    availableTurnIds: ReadonlyArray<RunId>,
    repositoryId?: string,
  ) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

function diffSelectionKey(ref: ScopedThreadRef, repositoryId?: string) {
  return repositoryId === undefined
    ? scopedThreadKey(ref)
    : `${scopedThreadKey(ref)}:repository:${repositoryId}`;
}

function normalizeBaseRef(baseRef: string | null): string | null {
  const normalized = baseRef?.trim();
  return normalized ? normalized : null;
}

export const useDiffPanelStore = create<DiffPanelStoreState>()(
  persist(
    (set) => ({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      selectGitScope: (ref, scope, repositoryId) =>
        set((state) => {
          const threadKey = diffSelectionKey(ref, repositoryId);
          const previous = state.byThreadKey[threadKey];
          const previousBaseRef =
            previous?.kind === "branch"
              ? previous.baseRef
              : (state.branchBaseRefByThreadKey[threadKey] ?? null);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]:
                scope === "branch"
                  ? { kind: "branch", baseRef: previousBaseRef }
                  : { kind: "unstaged" },
            },
            branchBaseRefByThreadKey:
              previous?.kind === "branch"
                ? { ...state.branchBaseRefByThreadKey, [threadKey]: previous.baseRef }
                : state.branchBaseRefByThreadKey,
          };
        }),
      selectThreadHistory: (ref, repositoryId) =>
        set((state) => ({
          byThreadKey: {
            ...state.byThreadKey,
            [diffSelectionKey(ref, repositoryId)]: { kind: "thread" },
          },
        })),
      selectBranchBaseRef: (ref, baseRef, repositoryId) =>
        set((state) => {
          const threadKey = diffSelectionKey(ref, repositoryId);
          const normalizedBaseRef = normalizeBaseRef(baseRef);
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { kind: "branch", baseRef: normalizedBaseRef },
            },
            branchBaseRefByThreadKey: {
              ...state.branchBaseRefByThreadKey,
              [threadKey]: normalizedBaseRef,
            },
          };
        }),
      selectTurn: (ref, turnId, filePath, repositoryId) =>
        set((state) => {
          const threadKey = diffSelectionKey(ref, repositoryId);
          const previous = state.byThreadKey[threadKey];
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: {
                kind: "turn",
                turnId,
                filePath: filePath?.trim() || null,
                revealRequestId: previous?.kind === "turn" ? previous.revealRequestId + 1 : 1,
              },
            },
          };
        }),
      reconcileTurnSelection: (ref, availableTurnIds, repositoryId) =>
        set((state) => {
          const threadKey = diffSelectionKey(ref, repositoryId);
          const previous = state.byThreadKey[threadKey];
          const latestTurnId = availableTurnIds[0];
          if (
            previous?.kind !== "turn" ||
            latestTurnId === undefined ||
            availableTurnIds.includes(previous.turnId)
          ) {
            return state;
          }
          return {
            byThreadKey: {
              ...state.byThreadKey,
              [threadKey]: { ...previous, turnId: latestTurnId },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const retain = ([key]: [string, unknown]) =>
            key !== threadKey && !key.startsWith(`${threadKey}:repository:`);
          const byThreadKey = Object.fromEntries(Object.entries(state.byThreadKey).filter(retain));
          const branchBaseRefByThreadKey = Object.fromEntries(
            Object.entries(state.branchBaseRefByThreadKey).filter(retain),
          );
          return { byThreadKey, branchBaseRefByThreadKey };
        }),
    }),
    {
      name: "t3code:diff-panel-state:v1",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: state.byThreadKey,
        branchBaseRefByThreadKey: state.branchBaseRefByThreadKey,
      }),
    },
  ),
);

export function selectThreadDiffPanelSelection(
  byThreadKey: Record<string, DiffPanelSelection>,
  ref: ScopedThreadRef | null | undefined,
  repositoryId?: string,
): DiffPanelSelection {
  if (!ref) return DEFAULT_SELECTION;
  return byThreadKey[diffSelectionKey(ref, repositoryId)] ?? DEFAULT_SELECTION;
}

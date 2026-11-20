import { useAtomValue } from "@effect/atom-react";
import { repositoryHistoryGroups } from "@t3tools/client-runtime/fd/multirepo";
import { resolveFilesystemReadAccess } from "@t3tools/client-runtime/state/filesystem";
import { Atom } from "effect/reactivity";
import { msg, useMessages } from "gt-react-native";

import { deriveThreadCheckpointSummaries } from "@t3tools/client-runtime/state/thread-checkpoints";
import type { EnvironmentId, ReviewDiffPreviewSource, ThreadId } from "@t3tools/contracts";

import { useCheckpointDiff } from "../../state/queries";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentPresentation } from "../../state/presentation";
import { lastReviewGitSectionsAtom, reviewEnvironment } from "../../state/review";
import { lastReviewTurnDiffsAtom } from "../../state/reviewTurnDiffs";
import { environmentSession } from "../../state/session";
import { useSelectedThreadProjection } from "../../state/use-thread-detail";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import {
  buildReviewSectionItems,
  getReadyReviewCheckpoints,
  getReviewSectionIdForCheckpoint,
  resolveReviewSelectedSectionId,
  reviewTurnDiffsBySectionId,
  type ReviewSectionItem,
} from "./reviewModel";
import { setReviewSelectedSectionId, type ReviewCacheForThread } from "./reviewState";

const NO_GIT_SECTIONS_ATOM = Atom.make<ReadonlyArray<ReviewDiffPreviewSource>>([]).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:git-sections:null"),
);
const NO_TURN_DIFFS_ATOM = Atom.make<Readonly<Record<number, string>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile:review:turn-diffs:null"),
);

export function useReviewSections(input: {
  readonly enabled?: boolean;
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
  readonly reviewCache: ReviewCacheForThread;
}) {
  const { environmentId, reviewCache, threadId } = input;
  const messages = useMessages();
  const enabled = input.enabled ?? true;
  const fileAccessSession = useEnvironmentQuery(
    environmentId === undefined ? null : environmentSession.sessionStateAtom(environmentId),
  );
  const fileEnvironment = useEnvironmentPresentation(environmentId ?? null);
  const fileAccess = resolveFilesystemReadAccess(
    {
      isCatalogReady: fileEnvironment.isReady,
      connection: fileEnvironment.presentation?.connection ?? null,
      session: fileAccessSession.data,
      sessionError: fileAccessSession.error,
    },
    messages,
  );
  const { canReadFiles } = fileAccess;
  const selectedThread = useSelectedThreadProjection();
  const { selectedThreadCwd, repositoryTarget, repositoryWorkspace } = useSelectedThreadWorktree();
  const repositoryId = repositoryWorkspace.isMultiRepository
    ? repositoryWorkspace.selected?.id
    : undefined;
  const history =
    repositoryWorkspace.isMultiRepository && selectedThread
      ? repositoryHistoryGroups(selectedThread.projection, null)
      : null;
  const diffPreview = useEnvironmentQuery(
    canReadFiles && enabled && environmentId !== undefined && selectedThreadCwd !== null
      ? reviewEnvironment.diffPreview({
          environmentId,
          input: { cwd: selectedThreadCwd, repositoryTarget },
        })
      : null,
  );
  const lastGitSections = useAtomValue(
    environmentId !== undefined && selectedThreadCwd !== null
      ? lastReviewGitSectionsAtom(environmentId, selectedThreadCwd)
      : NO_GIT_SECTIONS_ATOM,
  );

  // Remembered turn diffs are not repository-scoped, so multi-repository review reads turns live.
  const lastTurnDiffs = useAtomValue(
    environmentId !== undefined && threadId !== undefined && !repositoryWorkspace.isMultiRepository
      ? lastReviewTurnDiffsAtom(environmentId, threadId)
      : NO_TURN_DIFFS_ATOM,
  );

  const readyCheckpoints = getReadyReviewCheckpoints(
    selectedThread === null
      ? []
      : deriveThreadCheckpointSummaries(selectedThread.projection, repositoryId),
  );
  const checkpointBySectionId = new Map(
    readyCheckpoints.map((checkpoint) => [getReviewSectionIdForCheckpoint(checkpoint), checkpoint]),
  );
  // Turns show their last answered diff; the active turn's live query below overrides it.
  // Section ids and the selection do not depend on the live query, so they are resolved first.
  const cachedSections: ReviewSectionItem[] = [
    ...buildReviewSectionItems({
      checkpoints: readyCheckpoints,
      gitSections:
        canReadFiles || fileAccess.isPending ? (diffPreview.data?.sources ?? lastGitSections) : [],
      turnDiffById: reviewTurnDiffsBySectionId(readyCheckpoints, lastTurnDiffs),
      loadingGitSections: fileAccess.isPending || diffPreview.isPending,
      resolve: messages,
    }),
  ];
  if (history) {
    cachedSections.unshift({
      id: "thread",
      kind: "thread",
      title: messages(msg("Conversation")),
      subtitle: messages(msg("Recorded conversation snapshots")),
      diff: null,
      isLoading: false,
    });
    // Keep a turn chosen in another repository selected when this one has no snapshot for it.
    const requested = reviewCache.selectedSectionId;
    if (
      requested &&
      /^turn:[1-9]\d*$/.test(requested) &&
      !cachedSections.some((section) => section.id === requested)
    ) {
      cachedSections.unshift({
        id: requested,
        kind: "turn",
        title: messages(msg("Turn {count}", { count: Number(requested.slice(5)) })),
        subtitle: messages(msg("Snapshot unavailable")),
        diff: null,
        isLoading: false,
      });
    }
  }
  const selectedSectionId = resolveReviewSelectedSectionId(
    cachedSections,
    reviewCache.selectedSectionId,
  );

  const selectedKind =
    cachedSections.find((section) => section.id === selectedSectionId)?.kind ?? null;
  const isFullThread = selectedKind === "thread";
  const isHistorySelection = selectedKind === "turn" || isFullThread;
  const selectedCheckpoint =
    selectedSectionId === null ? undefined : checkpointBySectionId.get(selectedSectionId);
  const activeCheckpoint =
    selectedCheckpoint ?? (selectedKind === "turn" ? null : (readyCheckpoints[0] ?? null));
  const activeTurnCount = isFullThread
    ? (history?.toTurnCount ?? null)
    : (activeCheckpoint?.checkpointTurnCount ??
      (selectedKind === "turn" && selectedSectionId !== null
        ? Number(selectedSectionId.slice(5))
        : null));
  const activeSectionId = isFullThread
    ? "thread"
    : selectedKind === "turn"
      ? selectedSectionId
      : activeCheckpoint
        ? getReviewSectionIdForCheckpoint(activeCheckpoint)
        : null;
  const queryEnabled =
    enabled &&
    (!repositoryWorkspace.isMultiRepository || isHistorySelection) &&
    (activeTurnCount ?? 0) > 0;
  const activeTurnDiff = useCheckpointDiff({
    environmentId: queryEnabled ? (environmentId ?? null) : null,
    threadId: queryEnabled ? (threadId ?? null) : null,
    fromTurnCount:
      queryEnabled && activeTurnCount !== null
        ? isFullThread
          ? 0
          : Math.max(0, activeTurnCount - 1)
        : null,
    toTurnCount: queryEnabled ? activeTurnCount : null,
    ignoreWhitespace: false,
    repositoryId,
  });

  const reviewSections = cachedSections.map((section): ReviewSectionItem => {
    if (section.kind === "turn" || section.kind === "thread") {
      return section.id === activeSectionId
        ? {
            ...section,
            diff: activeTurnDiff.data?.diff ?? section.diff,
            isLoading: activeTurnDiff.isPending,
          }
        : section;
    }
    // Keep the selected section while its grant loads, without displaying cached host files.
    return fileAccess.isPending ? { ...section, diff: null, isLoading: true } : section;
  });
  const selectedSection =
    reviewSections.find((section) => section.id === selectedSectionId) ?? null;

  const refreshSelectedSection = async () => {
    if (!enabled) {
      return;
    }
    if (isHistorySelection) {
      activeTurnDiff.refresh();
      return;
    }
    diffPreview.refresh();
  };

  const selectSection = (sectionId: string) => {
    if (reviewCache.threadKey) {
      setReviewSelectedSectionId(reviewCache.threadKey, sectionId);
    }
  };

  return {
    historyProjection: selectedThread?.projection ?? null,
    historyRunId: isFullThread
      ? null
      : (activeCheckpoint?.runId ??
        selectedThread?.projection.runs.find((run) => run.ordinal === activeTurnCount)?.id ??
        selectedThread?.projection.checkpoints.find(
          (checkpoint) => checkpoint.appRunOrdinal === activeTurnCount,
        )?.runId ??
        null),
    isHistorySelection,
    error:
      (isHistorySelection ? activeTurnDiff.error : diffPreview.error) ??
      (selectedSection === null && !fileAccess.isPending && !canReadFiles
        ? (fileAccess.error ?? messages(msg("This connection cannot read local diffs.")))
        : null),
    isSelectedSectionPending: isHistorySelection ? activeTurnDiff.isPending : diffPreview.isPending,
    reviewSections,
    selectedSection,
    refreshSelectedSection,
    selectSection,
  };
}

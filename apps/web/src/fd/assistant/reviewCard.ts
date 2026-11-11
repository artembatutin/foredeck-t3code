import type { AssistantReviewSnapshot } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

/**
 * The surface's editable text. A list keeps its entries apart, since one entry can run over several
 * lines: anything flattening them to lines would turn it into several the owner never wrote.
 */
export interface ReviewDraft {
  readonly title: string;
  readonly goal: string;
  readonly acceptanceCriteria: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<string>;
  readonly decisions: ReadonlyArray<string>;
}

type ReviewEditable = Pick<
  AssistantReviewSnapshot,
  "title" | "goal" | "acceptanceCriteria" | "constraints" | "decisions"
>;

/** The entries as the server would store them. */
const tidied = (entries: ReadonlyArray<string>) =>
  entries.map((entry) => entry.trim()).filter((entry) => entry !== "");

const sameEntries = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) => {
  const [first, second] = [tidied(left), tidied(right)];
  return first.length === second.length && first.every((entry, index) => entry === second[index]);
};

/** The draft of a snapshot. A title is the owner's to edit only once it is set on the brief. */
export const reviewDraftOf = (snapshot: ReviewEditable): ReviewDraft => ({
  title: snapshot.title.origin === "explicit" ? snapshot.title.text : "",
  goal: snapshot.goal,
  acceptanceCriteria: snapshot.acceptanceCriteria,
  constraints: snapshot.constraints,
  decisions: snapshot.decisions,
});

/** Only what the draft changed, so an edit can never restate a field someone else just saved. */
export function reviewPatchOf(draft: ReviewDraft, snapshot: ReviewEditable) {
  const base = reviewDraftOf(snapshot);
  const title = draft.title.trim();
  const goal = draft.goal.trim();
  return {
    ...(title === base.title.trim() ? {} : { title }),
    ...(goal === base.goal.trim() ? {} : { goal }),
    ...(sameEntries(draft.acceptanceCriteria, snapshot.acceptanceCriteria)
      ? {}
      : { acceptanceCriteria: tidied(draft.acceptanceCriteria) }),
    ...(sameEntries(draft.constraints, snapshot.constraints)
      ? {}
      : { constraints: tidied(draft.constraints) }),
    ...(sameEntries(draft.decisions, snapshot.decisions)
      ? {}
      : { decisions: tidied(draft.decisions) }),
  };
}

export const reviewDraftChanged = (draft: ReviewDraft, snapshot: ReviewEditable) =>
  Object.keys(reviewPatchOf(draft, snapshot)).length > 0;

/** A draft and the snapshot it was edited from, which a save names and compares with. */
export interface ReviewEditing {
  readonly base: ReviewEditable &
    Pick<AssistantReviewSnapshot, "projectId" | "ideaId" | "briefRevision">;
  readonly draft: ReviewDraft;
}

export const reviewEditingOf = (base: ReviewEditing["base"]): ReviewEditing => ({
  base,
  draft: reviewDraftOf(base),
});

export const reviewEdited = ({ draft, base }: ReviewEditing) => reviewDraftChanged(draft, base);

/**
 * What the owner is editing once a newer snapshot arrives. An untouched draft follows it. An edited
 * one stays on what it was edited from, never rebased onto a revision its owner has not seen: its
 * save then names that older revision, and is refused instead of undoing what changed since.
 */
export const reviewEditingAfter = (
  editing: ReviewEditing,
  next: ReviewEditing["base"],
): ReviewEditing => (reviewEdited(editing) ? editing : reviewEditingOf(next));

/** Whether what the owner is editing has been overtaken, so saving it would be refused. */
export const reviewEditOvertaken = (
  editing: ReviewEditing,
  snapshot: Pick<AssistantReviewSnapshot, "briefRevision">,
) => reviewEdited(editing) && editing.base.briefRevision !== snapshot.briefRevision;

/** The save of a draft: only what its owner changed, against the revision they changed it from. */
export const reviewSaveInput = ({ draft, base }: ReviewEditing) => ({
  projectId: base.projectId,
  ideaId: base.ideaId,
  expectedRevision: base.briefRevision,
  patch: reviewPatchOf(draft, base),
});

/**
 * Whether this surface may edit what it shows. Text it could not show whole stays with the assistant:
 * saving what was cut would lose the rest of it.
 */
export const reviewEditable = (context: {
  readonly permitted: boolean;
  readonly briefTruncated: boolean;
}) => context.permitted && !context.briefTruncated;

const NO_PERMISSION =
  "This connection needs permission to write Work items and to run agents on this environment.";
const UNSAVED = "Save or discard your edits first: a start uses what is saved.";

/**
 * Whether the owner can start from this snapshot, and every reason not to. The server's reasons come
 * first; the permission and draft ones are this client's, and the server judges them again anyway.
 * `label` names the surface and `action` the button that starts, so the button never reads as one
 * more step of reviewing.
 */
export function reviewStartAvailability(
  snapshot: Pick<AssistantReviewSnapshot, "start">,
  context: { readonly permitted: boolean; readonly edited: boolean },
) {
  // What stands in the way whatever the owner types, apart from their own unsaved draft.
  const blockers = [
    ...snapshot.start.blockers.map(({ message }) => message),
    ...(context.permitted ? [] : [NO_PERMISSION]),
  ];
  const reasons = [...blockers, ...(context.edited ? [UNSAVED] : [])];
  const amend = snapshot.start.mode === "amend";
  return {
    canStart: snapshot.start.mode !== "none" && reasons.length === 0,
    reasons,
    blockers,
    label: amend ? "Review and resume" : "Review and start",
    action: amend ? "Resume delivery" : "Start delivery",
  };
}

/** Says what a start would freeze, without implying anything is frozen yet. */
export const reviewFreezeNote = (mode: AssistantReviewSnapshot["start"]["mode"]) =>
  mode === "amend"
    ? "These are the project's current settings. Resuming applies them to this delivery, which keeps counting what it has used."
    : "These are the project's current settings, and they can still change. Only starting fixes them for this delivery; later edits apply to future deliveries.";

const SCOPE_FIELD_LABELS: Record<string, string> = {
  title: "Title",
  goal: "Goal",
  acceptanceCriteria: "Acceptance criteria",
  constraints: "Restrictions",
  decisions: "Decisions",
};

/** A changed scope field under the name its own section has here. */
export const reviewScopeFieldLabel = (field: string) => SCOPE_FIELD_LABELS[field] ?? field;

/** What each way of delivering does, said beside the choice. */
export const REVIEW_KIND_NOTES: Record<AssistantReviewSnapshot["target"]["kind"], string> = {
  single: "One delivery and one pull request.",
  parent: "Factory plans child tasks first, and waits for you to approve that plan.",
};

/** One labelled line of what the review shows. */
export interface ReviewFact {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** Where a start would capture and deliver. */
export const reviewDestinationFacts = ({
  repository,
  source,
  sourcesOmitted,
  item,
}: AssistantReviewSnapshot["target"]): ReadonlyArray<ReviewFact> => [
  {
    key: "repository",
    label: "Repository",
    value:
      repository === null
        ? "Could not be resolved"
        : `${repository.repository ?? repository.workspaceRoot} (${repository.provider})`,
  },
  ...(source === null
    ? []
    : [{ key: "source", label: "Work source", value: `${source.label} (${source.identity})` }]),
  ...(sourcesOmitted > 0
    ? [{ key: "omitted", label: "More sources", value: `${sourcesOmitted} not listed here` }]
    : []),
  {
    key: "item",
    label: "Work item",
    value: item === null ? "Created when you start" : (item.key ?? item.itemId),
  },
];

const optionText = (option: AssistantReviewSnapshot["roles"]["author"]["options"][number]) =>
  `${option.id}: ${String(option.value)}${option.supported ? "" : " (not supported)"}`;

/** A provider confirms what it runs only once it runs, which every role's request is read beside. */
export const REVIEW_PROVIDER_NOTE =
  "These are requests. Provider confirmation: not reported until a role runs.";

/** One role's requested model and options. What the provider confirms is never implied by them. */
export function reviewRoleFact(
  name: string,
  role: AssistantReviewSnapshot["roles"]["author"],
): ReviewFact {
  const options = [
    ...role.options.map(optionText),
    ...(role.optionsOmitted > 0 ? [`… and ${role.optionsOmitted} more`] : []),
  ].join(", ");
  return {
    key: name,
    label: name,
    value: [
      `${role.model}${role.offered ? "" : " (not offered)"}`,
      ...(options === "" ? [] : [options]),
    ].join(" · "),
  };
}

const commandText = (command: AssistantReviewSnapshot["verifyCommand"]) =>
  command === null ? "None" : [command.executable, ...command.args].join(" ");

/** The limits and commands, each labelled for what it actually limits. */
export const reviewLimitFacts = (
  snapshot: Pick<
    AssistantReviewSnapshot,
    "limits" | "verifyCommand" | "setupCommand" | "blockingSeverities" | "highRiskEffort"
  >,
): ReadonlyArray<ReviewFact> => [
  { key: "verify", label: "Verify command", value: commandText(snapshot.verifyCommand) },
  { key: "setup", label: "Setup command", value: commandText(snapshot.setupCommand) },
  { key: "fix", label: "Fix rounds", value: `Up to ${snapshot.limits.maxFixRounds}` },
  { key: "review", label: "Review rounds", value: `Up to ${snapshot.limits.maxReviewRounds}` },
  ...(snapshot.limits.maxFixCommitTurns === null
    ? []
    : [
        {
          key: "fix-commit",
          label: "Fix-commit turns",
          value: `Up to ${snapshot.limits.maxFixCommitTurns}`,
        },
      ]),
  {
    key: "timeout",
    label: "Verify timeout",
    value: `${snapshot.limits.verifyTimeoutMinutes} minutes per command`,
  },
  // Nothing limits a delivery's total time, which reads worse left unsaid.
  { key: "total", label: "Total time", value: "Not limited" },
  {
    key: "severities",
    label: "Blocking severities",
    value: snapshot.blockingSeverities.join(", ") || "None",
  },
  { key: "effort", label: "High-risk effort", value: snapshot.highRiskEffort },
];

/** The overrides that exist, or that none does, so the common case stays one line. */
export function reviewOverrideFact(overrides: AssistantReviewSnapshot["overrides"]): ReviewFact {
  const present = overrides.filter(({ state }) => state === "present").map(({ prompt }) => prompt);
  return {
    key: "overrides",
    label: "Prompt overrides",
    value: overrides.some(({ state }) => state === "unknown")
      ? "Could not be read"
      : present.length === 0
        ? "None"
        : present.join(", "),
  };
}

/** The reason a request failed, in the words the server gave it. */
export function reviewFailureText(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.trim() !== ""
    ? squashed.message
    : "The review could not be completed. Check the connection and try again.";
}

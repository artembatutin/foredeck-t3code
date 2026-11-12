// @effect-diagnostics-next-line nodeBuiltinImport:off -- a synchronous hash keeps a version pure.
import * as NodeCrypto from "node:crypto";

import {
  type AssistantReviewGetInput,
  type AssistantReviewSnapshot,
  type AssistantReviewStarted,
  type AssistantReviewStartInput,
  clientRpcRequiredScopes,
  CommandId,
  MessageId,
  type RuntimeMode,
  ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  type FactoryCommand,
  type FactoryPromptName,
  FactoryRole,
} from "@t3tools/contracts/fd/factory";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { isAssistantThread } from "@t3tools/shared/fd/assistant";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

import * as Threads from "../../orchestration-v2/ThreadManagementService.ts";
import * as Projects from "../../project/ProjectService.ts";
import type { Dispatch } from "./dispatch.ts";
import * as FactoryExecutor from "./FactoryExecutor.ts";
import * as HandoffAdmission from "./HandoffAdmission.ts";
import * as HandoffBackend from "./handoffBackend.ts";
import * as Portfolio from "./portfolio.ts";
import * as PortfolioStore from "./PortfolioStore.ts";
import * as WorkCapture from "./WorkCapture.ts";
import * as WorkCaptureStore from "./WorkCaptureStore.ts";

const refusal = (reason: string) => new FactoryExecutor.FactoryExecutorRefusal({ reason });

const STALE =
  "What you reviewed changed while it was being started, so nothing was authorized or started. Anything already captured stays in Work. Review it again.";
const FOREIGN_REQUEST =
  "This confirmation belongs to another review, so nothing was started. Review it again.";
const KIND_MISMATCH =
  "This delivery runs as it started, not as this review was asked for, so nothing was authorized or started. Review it again.";
const OWNER_REVOKED =
  "This connection may no longer write to Work and run agents here, so nothing was authorized or started.";

/**
 * What one snapshot shows, so its size has a ceiling whatever an idea, its history and its settings
 * hold. Only what is shown is ever cut: a version and every comparison use the whole.
 */
const REVIEW_LIMITS = {
  /** The goal, the entries of one list and the length of each, and a brief's text as a whole. */
  text: 20_000,
  list: 200,
  item: 4_000,
  brief: 200_000,
  /** The text of everything changed since the capture, and of one command's arguments. */
  changes: 100_000,
  command: 16_000,
  /** One name, path, option or reason. */
  line: 1_024,
  /** How many of each are listed. */
  options: 32,
  sources: 50,
  attempts: 20,
  blockers: 20,
} as const;

/** The grants a start needs, as the RPC and the client's command judge them. */
const REQUIRED_SCOPES = clientRpcRequiredScopes(WS_METHODS.assistantReviewStart, undefined);

type ScopeChange = Extract<
  Portfolio.BriefChange,
  {
    readonly field:
      | "title"
      | "goal"
      | "acceptanceCriteria"
      | "constraints"
      | "decisions"
      | "openQuestions";
  }
>;

/** Whether a revision changed what a worker and a Work item are told. */
const isScopeChange = (change: Portfolio.BriefChange): change is ScopeChange =>
  change.field !== "priority" &&
  change.field !== "executionAuthorized" &&
  change.field !== "conversationNotes";

const PROMPTS: ReadonlyArray<FactoryPromptName> = [
  "plan",
  "author",
  "review",
  "fix-verify",
  "fix-review",
  "fix-commit",
  "integrate",
];

const ENDED: ReadonlySet<string> = new Set(["completed", "cancelled", "failed"]);

const textOf = (entries: ReadonlyArray<string>) =>
  entries.reduce((total, entry) => total + entry.length, 0);

const exceedsList = (entries: ReadonlyArray<string>) =>
  entries.length > REVIEW_LIMITS.list || entries.some((entry) => entry.length > REVIEW_LIMITS.item);

/** Whether a brief holds more than a snapshot shows: nobody can start what they could not read. */
const exceedsReview = (brief: Portfolio.ProjectBrief) => {
  const lists = [
    brief.acceptanceCriteria,
    brief.constraints,
    brief.decisions ?? [],
    brief.openQuestions,
    brief.conversationNotes ?? [],
  ];
  return (
    brief.goal.length > REVIEW_LIMITS.text ||
    lists.some(exceedsList) ||
    brief.goal.length + textOf(lists.flat()) > REVIEW_LIMITS.brief
  );
};

const exceedsCommand = (command: FactoryCommand | null) =>
  command !== null &&
  (command.executable.length > REVIEW_LIMITS.line ||
    exceedsList(command.args) ||
    textOf(command.args) > REVIEW_LIMITS.command);

const exceedsRole = ({ selection, options }: HandoffBackend.HandoffReviewRole) =>
  selection.model.length > REVIEW_LIMITS.line ||
  options.length > REVIEW_LIMITS.options ||
  options.some(
    ({ id, value }) =>
      id.length > REVIEW_LIMITS.line ||
      (typeof value === "string" && value.length > REVIEW_LIMITS.line),
  );

/**
 * Cuts what one snapshot shows, each cut marked where it falls and remembered, so the snapshot can
 * say whether it shows everything.
 */
const makeClip = () => {
  let cut = false;
  const text = (value: string, limit: number = REVIEW_LIMITS.line) => {
    if (value.length > limit) cut = true;
    return Portfolio.truncate(value, limit);
  };
  /** A text that also spends what is left of the text it is shown with. */
  const within = (value: string, limit: number, budget: { left: number }) => {
    const shown = text(value, Math.min(limit, budget.left));
    budget.left -= shown.length;
    return shown;
  };
  return {
    text,
    within,
    optional: (value: string | null) => (value === null ? null : text(value)),
    list: (entries: ReadonlyArray<string>, budget: { left: number }) => {
      const kept =
        entries.length <= REVIEW_LIMITS.list ? entries : entries.slice(0, REVIEW_LIMITS.list - 1);
      const shown: Array<string> = [];
      for (const entry of kept) {
        if (budget.left < 0) break;
        shown.push(within(entry, REVIEW_LIMITS.item, budget));
      }
      const more = entries.length - shown.length;
      if (more === 0) return shown;
      cut = true;
      return [...shown, `… and ${more} more`];
    },
    omitted: (whole: number, shown: number) => {
      if (whole > shown) cut = true;
      return whole - shown;
    },
    anyCut: () => cut,
  };
};

/** What a review binds, before a start names its receipt. */
const boundOf = ({ execution }: HandoffBackend.HandoffReviewPreview) => {
  if (execution === null) return null;
  const { receiptId: _receipt, reviewVersion: _version, ...values } = execution;
  return values;
};

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** A stable text of a plain value built in one order, to hash or compare. */
const canonical = (value: unknown) => JSON.stringify(value);

const asList = (value: string | ReadonlyArray<string>): ReadonlyArray<string> =>
  typeof value === "string" ? (value === "" ? [] : [value]) : value;

/** Each scope field that differs since the capture, from its first value to its latest. */
const scopeChangesSince = (
  revisions: ReadonlyArray<Portfolio.BriefRevision>,
  briefRevision: number,
) => {
  const changed = new Map<
    string,
    { readonly previous: ReadonlyArray<string>; next: ReadonlyArray<string> }
  >();
  for (const { revision, changes } of revisions) {
    if (revision <= briefRevision) continue;
    for (const change of changes) {
      if (!isScopeChange(change)) continue;
      const seen = changed.get(change.field);
      if (seen === undefined) {
        changed.set(change.field, {
          previous: asList(change.previous),
          next: asList(change.next),
        });
      } else {
        seen.next = asList(change.next);
      }
    }
  }
  return [...changed].flatMap(([field, { previous, next }]) =>
    previous.length === next.length && previous.every((item, index) => item === next[index])
      ? []
      : [{ field, previous, next }],
  );
};

/**
 * The latest revision that changed what a worker and a Work item are told, so a scope that changed
 * and came back is not the scope that was reviewed, while notes and authorization move nothing.
 */
const latestScopeRevision = (revisions: ReadonlyArray<Portfolio.BriefRevision>) =>
  revisions.findLast(({ changes }) => changes.some(isScopeChange))?.revision ?? 0;

/** How the assistant's service lends what a start needs of it. */
interface OwnerReviewContext<StoreError> {
  /** The assistant's one lock, which every decision on its assignments runs under. */
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly save: (record: Dispatch) => Effect.Effect<void, StoreError>;
  readonly dispatchOf: (assignmentId: string) => Effect.Effect<Dispatch | undefined, StoreError>;
  readonly executor: Effect.Success<typeof FactoryExecutor.make>;
}

export type OwnerReviewInput = AssistantReviewGetInput;
export type OwnerStartInput = AssistantReviewStartInput & {
  readonly owner: HandoffBackend.HandoffOwner;
};

/**
 * The owner's client-side review: a snapshot of what a start would capture and run, and a start
 * that captures, re-reads everything, and judges DB and checkout state in the same transaction that
 * records authorization. Versions hash scope revision and attempts (see `versionsOf`), so a
 * replayed version after an attempt grants nothing; a refused start's capture carries no authority.
 */
export const make = Effect.fn("OwnerReview.make")(function* <StoreError>(
  context: OwnerReviewContext<StoreError>,
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* PortfolioStore.PortfolioStore;
  const captures = yield* WorkCaptureStore.WorkCaptureStore;
  const capturing = yield* WorkCapture.WorkCapture;
  const admission = yield* HandoffAdmission.HandoffAdmission;
  const backend = yield* HandoffBackend.HandoffBackend;
  const review = yield* HandoffBackend.HandoffReview;
  const threads = yield* Threads.ThreadManagementService;
  const projects = yield* Projects.ProjectService;

  /** Whether the manager's thread can run this idea's work, or why not. */
  const managerBlocker = (
    manager: Effect.Success<ReturnType<typeof threads.getThreadShell>> | null,
    managerThreadId: ThreadId,
  ) => {
    if (!isAssistantThread(managerThreadId)) {
      return {
        code: "manager_unavailable",
        message: "Open this from the project assistant's own thread.",
      };
    }
    if (manager === null || manager.deletedAt !== null || manager.archivedAt !== null) {
      return {
        code: "manager_unavailable",
        message: "The project assistant's thread is not available. Reopen it, then review again.",
      };
    }
    return manager.interactionMode === "plan"
      ? {
          code: "plan_mode",
          message:
            "The project assistant's thread is in plan mode, which only reads. Leave plan mode to start work.",
        }
      : undefined;
  };

  /** The idea as it stands now, and everything a start would do from it. */
  const observe = Effect.fn("OwnerReview.observe")(function* (input: OwnerReviewInput) {
    const stored = yield* captures.get(input.projectId, input.ideaId);
    const capture = Option.getOrUndefined(stored);
    // A captured item is read past Work's cache, so what follows judges it as it reads now. It
    // is the slowest read here, and first, so nothing that moved while it ran goes unseen.
    const read =
      capture?.itemId === null || capture?.itemId === undefined
        ? undefined
        : yield* backend
            .read({ sourceId: capture.sourceId, itemId: capture.itemId })
            .pipe(Effect.result);
    const found = yield* store.getBrief(input.projectId, input.ideaId);
    if (Option.isNone(found)) return yield* refusal("Agree and save a project brief first.");
    const brief = found.value;
    const revisions = yield* store.listRevisions(input.projectId, input.ideaId);
    const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
    if (project === undefined || project.deletedAt !== null) {
      return yield* refusal("The destination project is unavailable.");
    }
    const manager = yield* threads.getThreadShell(input.managerThreadId);
    const requested: RuntimeMode | null = manager?.runtimeMode ?? null;
    const preview = yield* review.preview({
      projectId: input.projectId,
      runtimeCeiling: requested ?? "approval-required",
    });
    const attempts = yield* admission.ideaAttempts({
      projectId: input.projectId,
      ideaId: input.ideaId,
    });
    const open = attempts.filter(({ state }) => !ENDED.has(state));
    const [only] = open;
    const carried =
      only === undefined || only.receiptId === null || open.length > 1
        ? undefined
        : yield* admission.factoryAssignment(only.assignmentId);
    // An attempt under way runs as it started, whatever this review was asked for: everything
    // below judges, and the owner reads, the delivery it would actually carry on.
    const kind = carried?.kind ?? input.kind;
    const blockers: Array<{ readonly code: string; readonly message: string }> = [];
    const blockedManager = managerBlocker(manager, input.managerThreadId);
    if (blockedManager !== undefined) blockers.push(blockedManager);
    if ((project.repositories?.length ?? 0) > 1) {
      blockers.push({
        code: "multi_repository",
        message:
          "Multi-repository projects cannot currently create isolated worktrees, so nothing can start here.",
      });
    }
    if (brief.goal.trim() === "" || brief.acceptanceCriteria.length === 0) {
      blockers.push({
        code: "incomplete_brief",
        message: "Save the idea's goal and at least one acceptance criterion.",
      });
    }

    if (exceedsReview(brief)) {
      blockers.push({
        code: "too_long",
        message:
          "This idea is too long to review here, so it cannot start from here. Shorten it, or have the assistant keep the detail in the Work item.",
      });
    }

    const listed = yield* backend.sources(input.projectId).pipe(Effect.result);
    const sources = Result.isSuccess(listed) ? listed.success : [];
    if (Result.isFailure(listed)) {
      blockers.push({
        code: "sources_unreadable",
        message: "This project's Work sources could not be read. Try again.",
      });
    }
    const picked = Result.isSuccess(listed)
      ? WorkCapture.captureSource(sources, input.sourceId, stored, kind)
      : undefined;
    const source = picked !== undefined && Result.isSuccess(picked) ? picked.success : undefined;
    if (picked !== undefined && Result.isFailure(picked)) {
      blockers.push({ code: picked.failure.reason, message: picked.failure.message });
    }

    const item = read !== undefined && Result.isSuccess(read) ? read.success : undefined;
    if (read !== undefined && Result.isFailure(read)) {
      blockers.push(
        read.failure.reason === "not_found"
          ? {
              code: "item_missing",
              message:
                "The captured Work item no longer exists. Ask the assistant to abandon the capture.",
            }
          : {
              code: "item_unreadable",
              message:
                "The captured Work item could not be read. Try again once its source can be read.",
            },
      );
    }
    const edited =
      capture?.itemFingerprint !== null &&
      capture?.itemFingerprint !== undefined &&
      item !== undefined &&
      item.fingerprint !== capture.itemFingerprint;
    if (item?.invalid === true) {
      blockers.push({
        code: "item_invalid",
        message: "Work cannot read the captured item cleanly. Fix it in its source.",
      });
    }
    if (item?.status === "done" || item?.status === "cancelled") {
      blockers.push({
        code: "item_closed",
        message:
          "The captured Work item is done or cancelled. Reopen it in Work, or have the assistant capture the idea anew.",
      });
    }
    // A write no read confirmed: the item must say what was written, or what the brief says now.
    const unconfirmed =
      capture !== undefined &&
      source !== undefined &&
      capture.itemFingerprint === null &&
      item !== undefined &&
      item.fingerprint !== capture.contentHash &&
      item.fingerprint !==
        backend.fingerprint({
          kind: source.kind,
          ...WorkCapture.renderCaptured(brief, capture.captureId, WorkCapture.newItemTitle(brief)),
        });
    if (edited || unconfirmed) {
      blockers.push({
        code: "item_edited",
        message:
          "The captured Work item was edited in Work since it was captured. Decide with the assistant which version stands, then review it again.",
      });
    }

    const title =
      brief.title !== undefined
        ? { text: brief.title, origin: "explicit" as const }
        : capture?.itemFingerprint !== null &&
            capture?.itemFingerprint !== undefined &&
            item !== undefined &&
            !edited
          ? { text: item.title, origin: "stored" as const }
          : { text: Portfolio.shortTitleOf(brief.goal), origin: "derived" as const };

    if (preview.refusal !== null) {
      blockers.push({ code: "settings", message: preview.refusal });
    }
    const usedRoles = kind === "parent" ? FactoryRole.literals : (["author", "reviewer"] as const);
    // The same rule as for the brief, for the rest of what a start commits to. Ahead of what each
    // option says, which could otherwise leave it past the reasons a snapshot lists.
    const repository = preview.execution?.repository;
    if (
      [
        title.text,
        source?.label,
        source?.identity,
        item?.key ?? capture?.itemKey,
        item?.url ?? capture?.itemUrl,
        repository?.workspaceRoot,
        repository?.publication.provider,
        repository?.publication.repository,
      ].some((text) => (text?.length ?? 0) > REVIEW_LIMITS.line) ||
      usedRoles.some((role) => exceedsRole(preview.roles[role])) ||
      exceedsCommand(preview.verifyCommand) ||
      exceedsCommand(preview.setupCommand)
    ) {
      blockers.push({
        code: "details_too_long",
        message:
          "Part of where this goes or what it runs with is too long to show here, so it cannot start from here. Shorten it in its Work source or in the project's Factory settings.",
      });
    }
    for (const role of usedRoles) {
      const { selection, offered, options } = preview.roles[role];
      if (!offered) {
        blockers.push({
          code: "model_not_offered",
          message: `Provider ${selection.instanceId} does not offer ${selection.model}, the ${role} model. Choose another in the project's Factory settings.`,
        });
      }
      for (const option of options) {
        if (!option.supported) {
          blockers.push({
            code: "option_unsupported",
            message: `${selection.model} does not support the ${role}'s saved option ${option.id}. It stays saved until you change it in the project's Factory settings.`,
          });
        }
      }
    }

    const ending = attempts.some(
      ({ rootState, state }) =>
        ENDED.has(state) && (rootState === "active" || rootState === "ending"),
    );
    let amend:
      | {
          readonly assignmentId: string;
          readonly root: string;
          readonly target: HandoffBackend.HandoffAtRest;
          readonly assignment: HandoffAdmission.FactoryAssignment;
        }
      | undefined;
    if (open.length > 1 || (only !== undefined && only.receiptId === null)) {
      blockers.push({
        code: "attempt_running",
        message:
          "An assignment of this idea that was not reviewed has not ended. Finish or cancel it first.",
      });
    } else if (only !== undefined) {
      const target =
        only.deliveryId === null || carried === undefined
          ? null
          : yield* review.atRest(only.deliveryId).pipe(Effect.orElseSucceed(() => null));
      if (carried === undefined || only.deliveryId === null || target === null) {
        blockers.push({
          code: "attempt_running",
          message:
            "An attempt of this idea has not ended. A fresh review applies once it stops or blocks, or after you cancel it.",
        });
      } else if (
        carried.scopeHash !== Portfolio.briefScopeHash(brief) ||
        carried.captureId !== capture?.captureId ||
        carried.itemFingerprint !== item?.fingerprint
      ) {
        blockers.push({
          code: "attempt_scope_changed",
          message:
            "The idea or its Work item changed since this attempt started, so a review cannot carry it on. Cancel it, then review the idea again.",
        });
      } else {
        amend = {
          assignmentId: only.assignmentId,
          root: only.deliveryId,
          target,
          assignment: carried,
        };
      }
    } else if (ending) {
      blockers.push({
        code: "attempt_ending",
        message:
          "An earlier attempt of this idea is still ending. Try again once its threads are quiet.",
      });
    }

    // What a start would do, without anything a capture of it changes; see `versionsOf`.
    const bound = boundOf(preview);
    const parts = {
      format: 1,
      scope: Portfolio.briefScopeHash(brief),
      scopeRevision: latestScopeRevision(revisions),
      title: title.text,
      // What the item says, past the first line naming the capture.
      sections: sha256(WorkCapture.renderCaptured(brief, "", title.text).body),
      kind,
      // All of where a capture writes: one id can move to another directory or repository.
      source:
        source === undefined
          ? null
          : {
              sourceId: source.sourceId,
              kind: source.kind,
              identity: source.identity,
              version: source.version,
            },
      bound,
      refusal: preview.refusal,
      manager:
        manager === null
          ? null
          : {
              threadId: manager.id,
              runtimeMode: manager.runtimeMode,
              interactionMode: manager.interactionMode,
            },
      attempts,
      amend: amend === undefined ? null : { root: amend.root, target: amend.target },
    };
    return {
      brief,
      revisions,
      project,
      manager,
      requested,
      preview,
      capture,
      source,
      sources,
      item,
      title,
      attempts,
      kind,
      kindFixed: carried !== undefined,
      amend,
      blockers,
      parts,
    };
  });

  type Observed = Effect.Success<ReturnType<typeof observe>>;

  /** A version with the capture a review saw, if it saw one. */
  const versionWith = (observed: Observed, captureId: string | null) =>
    sha256(canonical({ ...observed.parts, captureId }));

  /**
   * The versions that describe this idea now. One taken before the idea had a capture stays good
   * once a capture exists, or a start could not converge after its own capture and a failure:
   * every later check compares that capture's content with what was reviewed, whoever made it. One
   * taken of a capture is good only for that capture, so an item replaced meanwhile is stale.
   */
  const versionsOf = (observed: Observed) => [
    versionWith(observed, observed.capture?.captureId ?? null),
    versionWith(observed, null),
  ];

  /** Whether the owner's connection still may do all of this, as their session stands now. */
  const ownerHolds = (owner: HandoffBackend.HandoffOwner) =>
    Effect.map(
      owner.current,
      (scopes) => scopes !== null && REQUIRED_SCOPES.every((required) => scopes.includes(required)),
    );

  const snapshot = Effect.fn("OwnerReview.snapshot")(function* (input: OwnerReviewInput) {
    const observed = yield* observe(input);
    const { brief, capture, item, preview, source, sources, title, attempts, amend, requested } =
      observed;
    const { execution } = preview;
    const clip = makeClip();
    const changesLeft = { left: REVIEW_LIMITS.changes };
    const scopeChanges =
      capture === undefined
        ? null
        : scopeChangesSince(observed.revisions, capture.briefRevision).map((change) => ({
            field: change.field,
            previous: clip.list(change.previous, changesLeft),
            next: clip.list(change.next, changesLeft),
          }));
    const role = (name: FactoryRole) => {
      const { selection, offered, options } = preview.roles[name];
      const listed = options.slice(0, REVIEW_LIMITS.options);
      return {
        instanceId: selection.instanceId,
        model: clip.text(selection.model),
        offered,
        options: listed.map(({ id, value, supported }) => ({
          id: clip.text(id),
          value: typeof value === "string" ? clip.text(value) : value,
          supported,
        })),
        optionsOmitted: clip.omitted(options.length, listed.length),
        acknowledgement: "not_reported" as const,
      };
    };
    const command = (saved: FactoryCommand | null) =>
      saved === null
        ? null
        : {
            executable: clip.text(saved.executable),
            args: clip.list(saved.args, { left: REVIEW_LIMITS.command }),
          };
    const sourceOf = ({ sourceId, kind, label, identity }: HandoffBackend.HandoffSource) => ({
      sourceId,
      kind,
      label: clip.text(label),
      identity: clip.text(identity),
    });
    const briefLeft = { left: REVIEW_LIMITS.brief };
    const shown = {
      goal: clip.within(brief.goal, REVIEW_LIMITS.text, briefLeft),
      acceptanceCriteria: clip.list(brief.acceptanceCriteria, briefLeft),
      constraints: clip.list(brief.constraints, briefLeft),
      decisions: clip.list(brief.decisions ?? [], briefLeft),
      openQuestions: clip.list(brief.openQuestions, briefLeft),
      notes: clip.list(brief.conversationNotes ?? [], briefLeft),
    };
    const { blockers } = observed;
    const listedSources = sources.slice(0, REVIEW_LIMITS.sources);
    const listedAttempts = attempts.slice(-REVIEW_LIMITS.attempts);
    return {
      reviewVersion: versionWith(observed, capture?.captureId ?? null),
      projectId: input.projectId,
      ideaId: input.ideaId,
      briefRevision: brief.revision,
      title: { text: clip.text(title.text), origin: title.origin },
      goal: shown.goal,
      acceptanceCriteria: shown.acceptanceCriteria,
      constraints: shown.constraints,
      decisions: shown.decisions,
      openQuestions: shown.openQuestions,
      conversationNotes: { items: shown.notes, delivered: false as const },
      scopeChanges,
      target: {
        repository:
          execution === null
            ? null
            : {
                workspaceRoot: clip.text(execution.repository.workspaceRoot),
                provider: clip.text(execution.repository.publication.provider),
                repository: clip.optional(execution.repository.publication.repository),
              },
        kind: observed.kind,
        kindFixed: observed.kindFixed,
        source: source === undefined ? null : sourceOf(source),
        sources: listedSources.map(sourceOf),
        sourcesOmitted: clip.omitted(sources.length, listedSources.length),
        item:
          capture?.itemId === null || capture === undefined
            ? null
            : {
                sourceId: capture.sourceId,
                itemId: capture.itemId,
                key: clip.optional(item?.key ?? capture.itemKey),
                url: clip.optional(item?.url ?? capture.itemUrl),
              },
      },
      roles: {
        planner: role("planner"),
        author: role("author"),
        reviewer: role("reviewer"),
      },
      verifyCommand: command(preview.verifyCommand),
      setupCommand: command(preview.setupCommand),
      limits: {
        maxFixRounds: preview.limits.maxFixRounds,
        maxReviewRounds: preview.limits.maxReviewRounds,
        maxFixCommitTurns: execution?.limits.maxFixCommitTurns ?? null,
        verifyTimeoutMinutes: preview.limits.verifyTimeoutMinutes,
        verifyTimeoutScope: "per_command" as const,
        totalTime: "unsupported" as const,
      },
      blockingSeverities: [...new Set(preview.blockingSeverities)],
      highRiskEffort: preview.highRiskEffort,
      pipelineId: preview.pipelineId,
      runtime: { requested, ceiling: execution?.runtimeCeiling ?? null },
      overrides: PROMPTS.map((prompt) => ({
        prompt,
        state:
          execution === null
            ? ("unknown" as const)
            : execution.promptOverrides[prompt] === "absent"
              ? ("absent" as const)
              : ("present" as const),
      })),
      attempts: listedAttempts.map(({ assignmentId, attempt, state, receiptId }) => ({
        assignmentId: clip.text(assignmentId),
        attempt,
        state,
        reviewed: receiptId !== null,
      })),
      attemptsOmitted: clip.omitted(attempts.length, listedAttempts.length),
      start: {
        mode:
          blockers.length > 0
            ? ("none" as const)
            : amend === undefined
              ? ("new_attempt" as const)
              : ("amend" as const),
        blockers: (blockers.length <= REVIEW_LIMITS.blockers
          ? blockers
          : [
              ...blockers.slice(0, REVIEW_LIMITS.blockers - 1),
              {
                code: "more",
                message: `… and ${blockers.length - REVIEW_LIMITS.blockers + 1} more reasons`,
              },
            ]
        ).map(({ code, message }) => ({ code, message: clip.text(message) })),
      },
      briefTruncated: exceedsReview(brief),
      // Last, once everything above has been cut.
      truncated: clip.anyCut(),
    } satisfies AssistantReviewSnapshot;
  });

  /**
   * Hands a delivery its review and takes up the one resume that owes it, or whichever of the two a
   * failure cut short. Factory records that resume in the step that does it, so a repeat that
   * finds it taken does nothing, whatever the delivery has done since: only a new review or the
   * owner can start it again.
   */
  const finishAmendment = Effect.fn("OwnerReview.finishAmendment")(function* (start: {
    readonly assignmentId: string;
    readonly resume: HandoffAdmission.ReviewResume;
    readonly execution: Parameters<typeof review.rebind>[0]["execution"];
  }) {
    const { root, deliveryId, effectsIssued } = start.resume;
    yield* review
      .rebind({
        root,
        execution: start.execution,
        resume: { deliveryId, effectsIssued },
      })
      .pipe(
        Effect.catchTags({
          HandoffFactoryRefused: (refused) => Effect.fail(refusal(refused.message)),
        }),
      );
    yield* context.withLock(
      Effect.gen(function* () {
        const owed = yield* review.resumeOwed({
          deliveryId,
          receiptId: start.execution.receiptId,
        });
        if (!owed) return;
        const current = yield* store.getAssignment(start.assignmentId);
        if (Option.isSome(current)) {
          yield* context.executor.control(current.value, "resume", {
            owed: { deliveryId, receiptId: start.execution.receiptId },
          });
        }
      }),
    );
  });

  /** What a repeated confirmation finds; only a rebound delivery has anything left to do. */
  const replay = Effect.fn("OwnerReview.replay")(function* (
    found: HandoffAdmission.ReviewStart,
    input: OwnerStartInput,
  ) {
    if (
      found.projectId !== input.projectId ||
      found.ideaId !== input.ideaId ||
      found.reviewVersion !== input.reviewVersion
    ) {
      return yield* refusal(FOREIGN_REQUEST);
    }
    if (found.kind === "amendment") {
      if (found.resume === null) return yield* refusal(FOREIGN_REQUEST);
      yield* finishAmendment({
        assignmentId: found.assignmentId,
        resume: found.resume,
        execution: yield* HandoffBackend.decodeReviewed(found.execution),
      });
    }
    return {
      assignmentId: found.assignmentId,
      receiptId: found.receiptId,
      attempt: found.attempt,
      outcome: found.kind === "attempt" ? ("queued" as const) : ("amended" as const),
      replayed: true,
    } satisfies AssistantReviewStarted;
  });

  /**
   * What authority a start judges in its recording transaction: the owner's session, the manager's
   * thread, the project and the idea's attempts as the database holds them now. Fails stale with
   * nothing written.
   */
  const authorityHolds = Effect.fn("OwnerReview.authorityHolds")(function* (
    input: OwnerStartInput,
    reviewed: Observed,
  ) {
    if (!(yield* ownerHolds(input.owner))) return yield* refusal(OWNER_REVOKED);
    const manager = yield* threads.getThreadShell(input.managerThreadId);
    if (
      managerBlocker(manager, input.managerThreadId) !== undefined ||
      manager === null ||
      manager.runtimeMode !== reviewed.requested
    ) {
      return yield* refusal(STALE);
    }
    const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
    if (
      project === undefined ||
      project.deletedAt !== null ||
      (project.repositories?.length ?? 0) > 1
    ) {
      return yield* refusal(STALE);
    }
    const attempts = yield* admission.ideaAttempts({
      projectId: input.projectId,
      ideaId: input.ideaId,
    });
    if (canonical(attempts) !== canonical(reviewed.attempts)) {
      return yield* refusal(STALE);
    }
    return manager;
  });

  const receiptFields = Effect.fn("OwnerReview.receiptFields")(function* (
    input: OwnerStartInput,
    reviewed: Observed,
  ) {
    const { execution } = reviewed.preview;
    if (execution === null) return yield* refusal(STALE);
    const digest = sha256(input.requestId).slice(0, 32);
    const receiptId = `review-${digest}`;
    const reviewVersion = yield* admission.nextReviewVersion({
      projectId: input.projectId,
      ideaId: input.ideaId,
    });
    return { digest, execution: { ...execution, receiptId, reviewVersion } };
  });

  /**
   * The settings and prompt overrides as they stand in the recording transaction, which a settings
   * write cannot land inside, compared with what it is about to bind. Where publication goes takes
   * Git and a provider to ask, so `finalPreview` does right before it, and the delivery's binding
   * refuses it from then on.
   */
  const settingsHold = (
    input: OwnerStartInput,
    reviewed: Observed,
    execution: Parameters<typeof review.holds>[0]["execution"],
  ) =>
    review
      .holds({
        projectId: input.projectId,
        runtimeCeiling: reviewed.requested ?? "approval-required",
        execution,
      })
      .pipe(Effect.flatMap((holds) => (holds ? Effect.void : Effect.fail(refusal(STALE)))));

  /**
   * The Work source as it stands in the recording transaction, still writing where was reviewed or
   * nothing is recorded, and the idea's capture as it stands there.
   */
  const targetHolds = Effect.fn("OwnerReview.targetHolds")(function* (
    input: OwnerStartInput,
    reviewed: Observed,
  ) {
    const listed = yield* backend.sources(input.projectId).pipe(Effect.result);
    const stored = yield* captures.get(input.projectId, input.ideaId);
    const picked = Result.isSuccess(listed)
      ? WorkCapture.captureSource(listed.success, input.sourceId, stored, reviewed.kind)
      : undefined;
    if (
      picked === undefined ||
      Result.isFailure(picked) ||
      picked.success.sourceId !== reviewed.source?.sourceId ||
      picked.success.identity !== reviewed.source.identity ||
      picked.success.version !== reviewed.source.version
    ) {
      return yield* refusal(STALE);
    }
    return Option.getOrUndefined(stored);
  });

  /** Records the attempt the owner reviewed, with everything that could have moved compared. */
  const recordAttempt = (input: OwnerStartInput, reviewed: Observed) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const found = yield* admission.reviewStartOf(input.requestId);
        if (found !== undefined) return found;
        const manager = yield* authorityHolds(input, reviewed);

        const current = yield* store.getBrief(input.projectId, input.ideaId);
        if (Option.isNone(current)) return yield* refusal(STALE);
        const brief = current.value;
        const revisions = yield* store.listRevisions(input.projectId, input.ideaId);
        if (
          Portfolio.briefScopeHash(brief) !== reviewed.parts.scope ||
          latestScopeRevision(revisions) !== reviewed.parts.scopeRevision
        ) {
          return yield* refusal(STALE);
        }

        const capture = yield* targetHolds(input, reviewed);
        const { source, item, title } = reviewed;
        if (
          capture?.state !== "captured" ||
          capture.itemId === null ||
          capture.itemFingerprint === null ||
          source === undefined ||
          item === undefined ||
          capture.captureId !== reviewed.capture?.captureId ||
          capture.sourceId !== source.sourceId ||
          capture.kind !== input.kind ||
          capture.itemId !== item.ref.itemId ||
          capture.itemFingerprint !== item.fingerprint ||
          capture.scopeHash !== Portfolio.briefScopeHash(brief) ||
          capture.contentHash !==
            backend.fingerprint({
              kind: source.kind,
              ...WorkCapture.renderCaptured(brief, capture.captureId, title.text),
            })
        ) {
          return yield* refusal(STALE);
        }

        const { digest, execution } = yield* receiptFields(input, reviewed);
        yield* settingsHold(input, reviewed, execution);
        const reentered = reviewed.attempts.findLast(
          ({ receiptId, state }) =>
            receiptId !== null && (state === "failed" || state === "cancelled"),
        );
        const assignmentId = reentered?.assignmentId ?? `review-${digest}`;
        yield* store.reviseBrief({
          projectId: input.projectId,
          ideaId: input.ideaId,
          patch: { executionAuthorized: true },
          reason: "The owner reviewed and started this idea.",
        });
        const authorized = {
          ...brief,
          executionAuthorized: true,
        };
        const stated = {
          managerThreadId: input.managerThreadId,
          brief: authorized,
          modelSelection: manager.modelSelection,
          runtimeMode: manager.runtimeMode,
          interactionMode: "default" as const,
        };
        const earlier = yield* context.dispatchOf(assignmentId);
        if (reentered === undefined) {
          yield* store.createAssignment({
            assignmentId,
            projectId: input.projectId,
            ideaId: input.ideaId,
            executor: "factory",
          });
        }
        const threadId = ThreadId.make(yield* randomUuidV4);
        yield* context.save(
          earlier === undefined
            ? {
                assignmentId,
                threadId,
                commandId: CommandId.make(`assignment:${threadId}`),
                messageId: MessageId.make(`assignment:${threadId}`),
                runId: null,
                cancelRequested: false,
                lastNotice: "",
                lastProgress: "",
                answeredRequestIds: [],
                resumeWorkspace: null,
                looper: null,
                looperRunId: null,
                previousLooperRunId: null,
                history: [],
                looperConfig: null,
                ...stated,
              }
            : { ...earlier, ...stated },
        );
        const queued = yield* admission.queueReviewed({
          assignmentId,
          link: {
            captureId: capture.captureId,
            item: { sourceId: capture.sourceId, itemId: capture.itemId },
            kind: input.kind,
            scopeHash: capture.scopeHash,
            itemFingerprint: capture.itemFingerprint,
            runtimeMode: manager.runtimeMode,
          },
          execution,
        });
        if (queued === "refused") return yield* refusal(STALE);
        const attempt = Option.getOrThrow(yield* store.getAssignment(assignmentId)).attempt;
        yield* admission.recordReviewStart({
          requestId: input.requestId,
          projectId: input.projectId,
          ideaId: input.ideaId,
          reviewVersion: input.reviewVersion,
          receiptId: execution.receiptId,
          assignmentId,
          attempt,
          kind: "attempt",
          execution,
          resume: null,
        });
        return {
          assignmentId,
          receiptId: execution.receiptId,
          attempt,
          outcome: "queued" as const,
          replayed: false,
        } satisfies AssistantReviewStarted;
      }),
    );

  /**
   * Everything a review binds, asked once more under the assistant's lock right before recording,
   * since Git and a provider cannot be asked inside the transaction. What this read is what a start
   * goes on to bind.
   */
  const finalPreview = Effect.fn("OwnerReview.finalPreview")(function* (
    input: OwnerStartInput,
    reviewed: Observed,
  ) {
    const preview = yield* review.preview({
      projectId: input.projectId,
      runtimeCeiling: reviewed.requested ?? "approval-required",
    });
    if (
      canonical(boundOf(preview)) !== canonical(reviewed.parts.bound) ||
      canonical(preview.roles) !== canonical(reviewed.preview.roles)
    ) {
      return yield* refusal(STALE);
    }
    return { ...reviewed, preview };
  });

  /**
   * Re-reads the captured item after every other wait, since a tracker cannot join the recording
   * transaction, which compares this with the capture. A later edit is caught by the claim's read.
   */
  const finalRead = Effect.fn("OwnerReview.finalRead")(function* (reviewed: Observed) {
    const { capture } = reviewed;
    if (capture?.itemId === null || capture === undefined) {
      return yield* refusal(STALE);
    }
    const read = yield* backend
      .read({ sourceId: capture.sourceId, itemId: capture.itemId })
      .pipe(Effect.mapError(() => refusal(STALE)));
    if (read.invalid || read.status === "done" || read.status === "cancelled") {
      return yield* refusal(STALE);
    }
    return { ...reviewed, item: read };
  });

  const recordUnderLock = (input: OwnerStartInput, reviewed: Observed) =>
    context.withLock(
      Effect.gen(function* () {
        const final = yield* finalRead(yield* finalPreview(input, reviewed));
        return yield* recordAttempt(input, final);
      }),
    );

  /**
   * A fresh review of a delivery at rest: its receipt recorded with the authorization, under the
   * same late comparisons as a new attempt, then handed to Factory under its own lock, which never
   * runs inside this transaction. A repeat of the same confirmation finishes what a failure cut
   * short.
   */
  const amendAttempt = Effect.fn("OwnerReview.amendAttempt")(function* (
    input: OwnerStartInput,
    observed: Observed,
    amend: NonNullable<Observed["amend"]>,
  ) {
    const recorded = yield* context.withLock(
      Effect.gen(function* () {
        const final = yield* finalRead(yield* finalPreview(input, observed));
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const found = yield* admission.reviewStartOf(input.requestId);
            if (found !== undefined) return { row: found, fresh: false };
            yield* authorityHolds(input, final);
            const current = yield* store.getBrief(input.projectId, input.ideaId);
            const revisions = yield* store.listRevisions(input.projectId, input.ideaId);
            const capture = yield* targetHolds(input, final);
            // A resume the owner asked for meanwhile answers to them, not to this review.
            const resting = yield* review.atRest(amend.root);
            if (
              Option.isNone(current) ||
              Portfolio.briefScopeHash(current.value) !== amend.assignment.scopeHash ||
              latestScopeRevision(revisions) !== final.parts.scopeRevision ||
              capture?.captureId !== amend.assignment.captureId ||
              capture.itemFingerprint !== amend.assignment.itemFingerprint ||
              final.item?.fingerprint !== amend.assignment.itemFingerprint ||
              canonical(resting) !== canonical(amend.target)
            ) {
              return yield* refusal(STALE);
            }
            const { execution } = yield* receiptFields(input, final);
            yield* settingsHold(input, final, execution);
            yield* store.reviseBrief({
              projectId: input.projectId,
              ideaId: input.ideaId,
              patch: { executionAuthorized: true },
              reason: "The owner reviewed this delivery again.",
            });
            const start = {
              requestId: input.requestId,
              projectId: input.projectId,
              ideaId: input.ideaId,
              reviewVersion: input.reviewVersion,
              receiptId: execution.receiptId,
              assignmentId: amend.assignmentId,
              attempt: Option.getOrThrow(yield* store.getAssignment(amend.assignmentId)).attempt,
              kind: "amendment" as const,
              resume: {
                root: amend.root,
                deliveryId: amend.target.deliveryId,
                effectsIssued: amend.target.effectsIssued,
              },
            };
            yield* admission.recordReviewStart({ ...start, execution });
            return { row: { ...start, execution }, fresh: true };
          }),
        );
      }),
    );
    return yield* replay(recorded.row, input).pipe(
      Effect.map((started) => ({ ...started, replayed: !recorded.fresh })),
    );
  });

  const start = Effect.fn("OwnerReview.start")(function* (input: OwnerStartInput) {
    // Even a repeat, which can still have a rebind and a resume to finish.
    if (!(yield* ownerHolds(input.owner))) return yield* refusal(OWNER_REVOKED);
    const found = yield* admission.reviewStartOf(input.requestId);
    if (found !== undefined) return yield* replay(found, input);

    const first = yield* observe(input);
    // A duplicate that committed since moved what the version holds; it is this very start.
    const settled = yield* admission.reviewStartOf(input.requestId);
    if (settled !== undefined) return yield* replay(settled, input);
    if (!versionsOf(first).includes(input.reviewVersion)) return yield* refusal(STALE);
    if (first.kind !== input.kind) return yield* refusal(KIND_MISMATCH);
    const [blocked] = first.blockers;
    if (blocked !== undefined) {
      return yield* refusal(Portfolio.truncate(blocked.message, REVIEW_LIMITS.line));
    }
    if (first.amend !== undefined) return yield* amendAttempt(input, first, first.amend);

    const captured = yield* capturing
      .captureAsOwner({
        owner: input.owner,
        projectId: input.projectId,
        ideaId: input.ideaId,
        kind: input.kind,
        sourceId: input.sourceId,
      })
      .pipe(Effect.mapError((error) => refusal(error.message)));
    if (!captured.verified) return yield* refusal(STALE);

    // Read again now that the capture's I/O ended: whatever moved meanwhile shows here.
    const reviewed = yield* observe(input);
    const joined = yield* admission.reviewStartOf(input.requestId);
    if (joined !== undefined) return yield* replay(joined, input);
    if (reviewed.blockers.length > 0 || !versionsOf(reviewed).includes(input.reviewVersion)) {
      return yield* refusal(STALE);
    }
    const recorded = yield* recordUnderLock(input, reviewed);
    return "requestId" in recorded ? yield* replay(recorded, input) : recorded;
  });

  return { snapshot, start };
});

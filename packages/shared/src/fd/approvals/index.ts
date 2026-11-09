import type { ProviderApprovalOption, RuntimeMode, ServerProvider } from "@t3tools/contracts";
import { providerRuntimeModeRestriction } from "@t3tools/contracts";

/**
 * How every surface explains what waits on someone, and what a permission mode covers, so a
 * notice the assistant reads and a row the owner reads say the same thing. Pure: it reads what it
 * is given and decides nothing about whether anything may run.
 */

/** What deciding it amounts to. */
export type PendingActionClass =
  | "foredeck_authorization"
  | "provider_permission"
  | "host_restriction"
  | "factory_question"
  | "unknown";

export const PENDING_ACTION_LABELS: Record<PendingActionClass, string> = {
  foredeck_authorization: "Foredeck authorization",
  provider_permission: "Provider or session permission",
  host_restriction: "External host restriction",
  factory_question: "Factory question",
  unknown: "Unknown",
};

export type PendingActionRunClass = "factory" | "explicit" | "unknown";

/**
 * Whether a request is one someone decides. A dynamic tool call or a login refresh is answered
 * between the provider and the server, with nowhere to decide it, so no surface lists one.
 */
export const isOwnerDecidedRequest = (kind: string): boolean =>
  kind !== "dynamic_tool_call" && kind !== "auth_refresh";

/** A delivery's own wait on its owner, which no provider request stands behind. */
export const PLAN_GATE_ACTION = "plan_gate";
/** A mode the provider's host policy refused, before anything ran. */
export const HOST_POLICY_ACTION = "host_policy";

const PERMISSION_KINDS: ReadonlySet<string> = new Set([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
]);

/**
 * What a pending action is, from its request kind and its run's class alone. Nothing here reads a
 * prompt or an answer, so nothing a provider writes can turn a question into a permission: only a
 * question of Factory's own run is a Factory question, and any other is unknown rather than guessed.
 */
export const classifyPendingAction = (input: {
  readonly kind: string;
  readonly runClass: PendingActionRunClass | null;
}): PendingActionClass => {
  if (input.kind === PLAN_GATE_ACTION) return "foredeck_authorization";
  if (input.kind === HOST_POLICY_ACTION || input.kind === "auth_refresh") return "host_restriction";
  if (PERMISSION_KINDS.has(input.kind)) return "provider_permission";
  if (input.kind === "user_input" && input.runClass === "factory") return "factory_question";
  return "unknown";
};

/** What a provider answered a question with no reason for, which nothing here makes up. */
export const APPROVAL_REASON_UNKNOWN =
  "The provider gave no reason, so why this is not already covered is unknown.";

interface ActionWords {
  /** This one, as "this command". */
  readonly one: string;
  /** Its kind, as "commands". */
  readonly many: string;
  /** What Supervised does about it. */
  readonly supervised: string;
  /** Why Auto-accept edits leaves it out. */
  readonly edits: string;
}

const ACTION_WORDS: Readonly<Record<string, ActionWords>> = {
  command: {
    one: "this command",
    many: "commands",
    supervised: "Supervised asks before commands.",
    edits: "Auto-accept edits covers file edits, not a command that needs your decision.",
  },
  "file-read": {
    one: "this file read",
    many: "file reads",
    supervised: "Supervised leaves reads to the provider, and it asks before this one.",
    edits: "Auto-accept edits covers file edits, not a read the provider holds back.",
  },
  "file-change": {
    one: "this file change",
    many: "file changes",
    supervised: "Supervised asks before file changes.",
    edits: "Auto-accept edits did not cover this file change.",
  },
  "mcp-elicitation": {
    one: "this app's access",
    many: "app access",
    supervised: "Supervised asks before an app gets access.",
    edits: "Auto-accept edits covers file edits, not an app's access.",
  },
  permission: {
    one: "this permission",
    many: "extra permissions",
    supervised: "Supervised asks before the agent gets more access than this turn has.",
    edits: "Auto-accept edits covers file edits, not more access than this turn has.",
  },
  dynamic_tool_call: {
    one: "this tool call",
    many: "tool calls",
    supervised: "Supervised asks before this tool call.",
    edits: "Auto-accept edits covers file edits, not this tool call.",
  },
};

/** The longest provider reason any surface repeats; a request's own text can run on. */
const APPROVAL_REASON_MAX = 300;

const providerSays = (reason: string) => {
  const flat = reason.replace(/\s+/g, " ").trim();
  return `The provider says: ${
    flat.length > APPROVAL_REASON_MAX ? `${flat.slice(0, APPROVAL_REASON_MAX - 1)}…` : flat
  }`;
};

/**
 * Why an approval is being asked, given what its thread's mode allowed already. The kind and mode
 * say only what the mode left out, and Supervised asks by its nature. Anything more is the
 * provider's to say: `reason` is its own, repeated rather than `detail` when that already shows it,
 * and without one this says it gave none rather than work out why from the kind.
 */
export const pendingApprovalReason = (input: {
  readonly kind: string;
  readonly runtimeMode: RuntimeMode | null | undefined;
  readonly reason?: string | undefined;
  readonly detail?: string | undefined;
}): string => {
  const reason = input.reason?.trim();
  const said = !reason
    ? null
    : reason === input.detail?.trim()
      ? "The provider's reason is shown above."
      : providerSays(reason);
  const words = ACTION_WORDS[input.kind];
  const covered = (() => {
    if (words === undefined) return null;
    switch (input.runtimeMode) {
      case "approval-required":
        return words.supervised;
      case "auto-accept-edits":
        return words.edits;
      case "auto":
        return `Auto lets the provider approve routine actions. It did not treat ${words.one} as routine, or it has no automatic review.`;
      case "full-access":
        return `Full access allows ${words.many} without asking, but the provider asked anyway.`;
      default:
        return null;
    }
  })();
  if (covered === null) return said ?? APPROVAL_REASON_UNKNOWN;
  if (said !== null) return `${covered} ${said}`;
  return input.runtimeMode === "approval-required"
    ? covered
    : `${covered} The provider gave no reason.`;
};

/** Who is asking, from its run's class alone. */
export const pendingActionProvenance = (input: {
  readonly kind: string;
  readonly runClass: PendingActionRunClass | null;
}): string => {
  if (input.kind === PLAN_GATE_ACTION) return "Factory's plan gate";
  if (input.kind === HOST_POLICY_ACTION) return "The provider's host policy";
  switch (input.runClass) {
    case "factory":
      return "Factory's own agent";
    case "explicit":
      return "A turn someone started on purpose on this thread";
    case "unknown":
      return "Not known whether Factory or someone else started this turn";
    case null:
      return "No run is recorded for this request";
  }
};

const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

interface EditsCoverage {
  readonly covers: string;
  readonly stillAsks: string;
}

/**
 * What Auto-accept edits covers on each provider, as its adapter and the provider's own rules run
 * it. Grok, Muse and Devin Cloud do not offer the mode, so no choice ever shows theirs.
 */
const EDITS_COVERAGE: Readonly<Record<string, EditsCoverage>> = {
  codex: {
    covers: "File edits and commands that stay inside the workspace sandbox.",
    stillAsks: "Anything that has to leave it, such as network access or writing elsewhere.",
  },
  claudeAgent: {
    covers: "File edits in the workspace and the simple file commands that go with them.",
    stillAsks: "Other commands, network access and edits outside the workspace.",
  },
  cursor: {
    covers: "File edits and commands inside Cursor's sandbox.",
    stillAsks:
      "Nothing: Cursor sends no approval requests, so what its sandbox blocks does not run.",
  },
  opencode: {
    covers: "OpenCode's file edits.",
    stillAsks: "Commands, web access and anything outside the project.",
  },
  pi: {
    covers: "Pi's edit and write tools.",
    stillAsks: "Commands and extension tools.",
  },
  antigravity: {
    covers: "File edits, under Antigravity's own auto-edit mode.",
    stillAsks: "Other actions Antigravity asks about.",
  },
  acpRegistry: {
    covers: "File edits, moves and deletes, wherever the agent makes them.",
    stillAsks: "Commands and other tools. Reads and searches never wait.",
  },
  devin: {
    covers: "File edits, moves and deletes, wherever the agent makes them.",
    stillAsks: "Commands and other tools. Reads and searches never wait.",
  },
};

const UNKNOWN_EDITS_COVERAGE: EditsCoverage = {
  covers: "File edits, as far as this provider honours the mode.",
  stillAsks: "Not known for this provider, so other actions can still ask.",
};

export const autoAcceptEditsCoverage = (driver: string | null | undefined): EditsCoverage =>
  (driver === null || driver === undefined ? undefined : EDITS_COVERAGE[driver]) ??
  UNKNOWN_EDITS_COVERAGE;

/** What a mode means on a provider, as a choice of it says so. */
export const runtimeModeMeaning = (mode: RuntimeMode, driver?: string | null): string => {
  switch (mode) {
    case "approval-required":
      return "Ask before commands and file changes.";
    case "auto-accept-edits": {
      const { covers, stillAsks } = autoAcceptEditsCoverage(driver);
      return `Covers: ${covers} Still asks: ${stillAsks}`;
    }
    case "auto":
      return "Supported providers approve routine actions; others still ask.";
    case "full-access":
      return "Allow commands and edits without prompts.";
  }
};

const RUNTIME_MODES = Object.keys(RUNTIME_MODE_LABELS) as ReadonlyArray<RuntimeMode>;

/** A provider as a refusal reads it. */
export type RuntimeModePolicyProvider = Pick<
  ServerProvider,
  "runtimeModeRestrictions" | "supportedRuntimeModes" | "displayName"
> & { readonly driver: string };

export interface RuntimeModeAlternative {
  readonly mode: RuntimeMode;
  readonly label: string;
  readonly meaning: string;
}

export interface RuntimeModeRefusal {
  readonly mode: RuntimeMode;
  /** The incompatibility, with what the policy allows when it said. */
  readonly reason: string;
  readonly alternatives: ReadonlyArray<RuntimeModeAlternative>;
  /** All of it as one sentence or two, without the alternatives' meanings. */
  readonly summary: string;
}

const listed = (names: ReadonlyArray<string>) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;

/** How the owner chooses another mode for a delivery a host refused. */
export type RuntimeModeChoice = "resume" | "thread" | "automatic_turn" | "review" | "before_review";

export const RUNTIME_MODE_CHOICE_TEXT: Record<RuntimeModeChoice, string> = {
  resume: "Change the project's default permission mode, then resume.",
  thread: "Change this thread's permission mode, then resume.",
  automatic_turn: "Change this thread's permission mode so its next automatic turn can run.",
  review: "Review it again to choose another.",
  before_review: "Change the project's or this assistant's mode, then review again.",
};

/** What a refusal says, for a mode and alternatives read earlier or just now. */
export const runtimeModeRefusalText = (input: {
  readonly provider: string;
  readonly mode: RuntimeMode;
  readonly detail?: string | undefined;
  readonly alternatives: ReadonlyArray<RuntimeMode>;
}): Pick<RuntimeModeRefusal, "reason" | "summary"> => {
  const label = RUNTIME_MODE_LABELS[input.mode];
  const reason = `${input.provider}'s host policy refuses ${label}.${input.detail === undefined ? "" : ` ${input.detail}`}`;
  const labels = input.alternatives.map((mode) => RUNTIME_MODE_LABELS[mode]);
  return {
    reason,
    summary:
      labels.length === 0
        ? `${reason} It leaves no mode this provider offers, so nothing can run here until that policy changes.`
        : `${reason} Choose ${listed(labels)} instead.`,
  };
};

/** The modes the provider offers, of those its policy does not refuse. */
const allowedAlternatives = (provider: RuntimeModePolicyProvider, refused: RuntimeMode) => {
  const offered = provider.supportedRuntimeModes;
  return RUNTIME_MODES.filter(
    (mode) =>
      mode !== refused &&
      (offered === undefined || offered.length === 0 || offered.includes(mode)) &&
      providerRuntimeModeRestriction(provider, mode).status === "allowed",
  );
};

/**
 * Why a turn in `runtimeMode` would be refused by the provider's host policy, or null while that
 * is not known. An unknown policy is never refused on: a mode is only refused on what was read.
 * This chooses no mode: the alternatives wait for someone to choose one.
 */
export const runtimeModeRefusal = (
  provider: RuntimeModePolicyProvider | null | undefined,
  runtimeMode: RuntimeMode,
): RuntimeModeRefusal | null => {
  if (provider === null || provider === undefined) return null;
  const restriction = providerRuntimeModeRestriction(provider, runtimeMode);
  if (restriction.status !== "disallowed") return null;
  const alternatives = allowedAlternatives(provider, runtimeMode);
  const name = provider.displayName ?? provider.driver;
  return {
    mode: runtimeMode,
    ...runtimeModeRefusalText({
      provider: name,
      mode: runtimeMode,
      detail: restriction.detail,
      alternatives,
    }),
    alternatives: alternatives.map((mode) => ({
      mode,
      label: RUNTIME_MODE_LABELS[mode],
      meaning: runtimeModeMeaning(mode, provider.driver),
    })),
  };
};

/**
 * Why the host would refuse a turn core starts on a thread in `threadMode`: core asks the provider
 * for that mode, or `RuntimePolicy`'s stand-in for one it does not offer, so this judges the same.
 */
export const threadTurnRefusal = (
  provider: RuntimeModePolicyProvider | null | undefined,
  threadMode: RuntimeMode,
): RuntimeModeRefusal | null => {
  const offered = provider?.supportedRuntimeModes;
  return runtimeModeRefusal(
    provider,
    offered === undefined || offered.length === 0 || offered.includes(threadMode)
      ? threadMode
      : offered.includes("approval-required")
        ? "approval-required"
        : (offered[0] ?? "approval-required"),
  );
};

/**
 * Whether answering a question starts a turn: core takes a message-capable answer as a new message,
 * while a live one continues the turn that asked.
 */
export const pendingAnswerStartsTurn = (
  responseCapability: "live" | "message" | "not_resumable" | undefined,
): boolean => responseCapability === "message";

/** Why the host would refuse the turn an answer starts, or null for one that starts none. */
export const pendingAnswerRefusal = (input: {
  readonly responseCapability: "live" | "message" | "not_resumable" | undefined;
  readonly provider: RuntimeModePolicyProvider | null | undefined;
  readonly threadMode: RuntimeMode;
}): RuntimeModeRefusal | null =>
  pendingAnswerStartsTurn(input.responseCapability)
    ? threadTurnRefusal(input.provider, input.threadMode)
    : null;

/**
 * What a client offers for a request that lists no choices, as one from an older server: only what
 * every provider can answer. A longer-lasting choice is the provider's to offer, and offering one it
 * cannot honor would come back cancelled.
 */
export const approvalChoices = (
  options: ReadonlyArray<ProviderApprovalOption> | undefined,
): ReadonlyArray<ProviderApprovalOption> =>
  options ?? [
    { decision: "cancel", label: "Cancel" },
    { decision: "decline", label: "Decline" },
    { decision: "accept", label: "Approve" },
  ];

/**
 * How long an approval's choices last, on what the provider offered. Foredeck holds no approval of
 * its own, so this names none: where a provider offers only this action or this session, that is
 * all there is, and the owner asks again after it ends.
 */
export const approvalChoiceNote = (options: ReadonlyArray<ProviderApprovalOption>): string => {
  const decisions = new Set(options.map((option) => option.decision));
  const once = decisions.has("accept") ? "Approving covers this one action." : null;
  const session = decisions.has("acceptForSession")
    ? "The session choice covers this thread's provider session only, and ends with it, such as when the provider or server restarts."
    : null;
  const always = decisions.has("acceptAlways")
    ? "The always choice is kept by the provider under its own rules."
    : null;
  const lasting =
    session === null && always === null && once !== null ? "Nothing longer is offered here." : null;
  return [once, session, always, lasting, "Foredeck has no project or delivery grant."]
    .filter((part) => part !== null)
    .join(" ");
};

/**
 * A session choice's label, saying it is for this session whatever the provider called it, since a
 * label like "Allow" alone would read as lasting.
 */
export const approvalOptionLabel = (option: ProviderApprovalOption): string =>
  option.decision === "acceptForSession" && !/session|this thread/i.test(option.label)
    ? `${option.label} for this session`
    : option.label;

/** One pending action as a request or a delivery states it. */
export interface PendingActionFacts {
  readonly kind: string;
  readonly runClass: PendingActionRunClass | null;
  readonly runtimeMode: RuntimeMode | null;
  readonly capability: "live" | "message" | "not_resumable";
  /** Why the provider says it asks, when it says. */
  readonly reason?: string | undefined;
  readonly refused?: {
    readonly provider: string;
    readonly driver: string;
    readonly detail?: string | undefined;
    readonly choose: RuntimeModeChoice;
    readonly alternatives: ReadonlyArray<RuntimeMode>;
  };
}

const NOT_RESUMABLE =
  "Its provider process is gone, so it cannot be answered. Interrupt or restart the run.";

/** Why it waits on someone, in the words every surface uses for it. */
export const pendingActionReason = (action: PendingActionFacts): string => {
  if (action.capability === "not_resumable") return NOT_RESUMABLE;
  if (action.kind === PLAN_GATE_ACTION) {
    return "A plan waits for your approval, and nothing of it runs until you decide.";
  }
  if (action.kind === HOST_POLICY_ACTION) {
    const refused = action.refused;
    const provider = refused?.provider ?? "The provider";
    const mode = action.runtimeMode;
    if (mode === null) return `${provider}'s host policy refused this delivery's mode.`;
    const { reason } = runtimeModeRefusalText({
      provider,
      mode,
      detail: refused?.detail,
      alternatives: refused?.alternatives ?? [],
    });
    const choices = (refused?.alternatives ?? []).map(
      (alternative) =>
        `${RUNTIME_MODE_LABELS[alternative]}: ${runtimeModeMeaning(alternative, refused?.driver)}`,
    );
    const next = refused === undefined ? "" : ` ${RUNTIME_MODE_CHOICE_TEXT[refused.choose]}`;
    return choices.length === 0
      ? `${reason} Nothing ran and no mode changed. It leaves no other mode this provider offers.`
      : `${reason} Nothing ran and no mode changed.${next} ${choices.join(" ")}`;
  }
  if (action.kind === "auth_refresh") {
    return "The provider needs its login refreshed, which no approval here can grant.";
  }
  if (action.kind === "user_input") {
    return "The agent asks a question only you can answer. An answer grants no permission.";
  }
  return pendingApprovalReason({
    kind: action.kind,
    runtimeMode: action.runtimeMode,
    reason: action.reason,
  });
};

/**
 * A pending request as the project assistant's notice says it, naming where it is decided. A
 * permission is never answered from a question tool, so a notice only ever offers one for a live
 * question of Factory's own running agent, whose text the caller has already bounded.
 */
export const pendingRequestNotice = (
  action: PendingActionFacts & {
    readonly threadId: string;
    readonly requestId: string;
    readonly questions: string | null;
  },
): string => {
  const { threadId, requestId } = action;
  if (action.kind === "user_input") {
    return action.capability === "live" && action.runClass === "factory"
      ? `Owner question from thread ${threadId}: ${action.questions ?? ""}. Reply through assistant_answer with its exact request ID ${requestId}.`
      : `A question on thread ${threadId} waits for an answer. Answer it in that thread.`;
  }
  const label = PENDING_ACTION_LABELS[classifyPendingAction(action)];
  return `${label} on thread ${threadId}: ${pendingActionReason(action)} Open that thread's approval UI; question tools cannot grant permission.`;
};

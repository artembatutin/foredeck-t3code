import type { RuntimeMode, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  APPROVAL_REASON_UNKNOWN,
  autoAcceptEditsCoverage,
  classifyPendingAction,
  composerRuntimeModeRefusal,
  HOST_POLICY_ACTION,
  isOwnerDecidedRequest,
  PENDING_ACTION_LABELS,
  pendingActionProvenance,
  pendingActionReason,
  pendingAnswerRefusal,
  pendingApprovalReason,
  pendingRequestNotice,
  PLAN_GATE_ACTION,
  runtimeModeChoiceDescriptions,
  runtimeModeMeaning,
} from "./pendingActions";

const MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

describe("why an approval is asked", () => {
  it.each([
    ["command", "approval-required", "Supervised asks before commands."],
    ["command", "auto-accept-edits", "covers file edits, not a command"],
    ["command", "auto", "did not treat this command as routine"],
    ["command", "full-access", "allows commands without asking"],
    ["file-change", "approval-required", "Supervised asks before file changes."],
    ["file-change", "auto-accept-edits", "did not cover this file change"],
    ["file-change", "auto", "did not treat this file change as routine"],
    ["file-change", "full-access", "allows file changes without asking"],
    ["dynamic_tool_call", "approval-required", "asks before this tool call"],
    ["dynamic_tool_call", "auto-accept-edits", "not this tool call"],
    ["dynamic_tool_call", "auto", "did not treat this tool call as routine"],
    ["dynamic_tool_call", "full-access", "allows tool calls without asking"],
    ["mcp-elicitation", "auto-accept-edits", "not an app's access"],
    ["file-read", "approval-required", "leaves reads to the provider"],
    ["permission", "approval-required", "more access than this turn has"],
  ] as const)("%s under %s", (kind, runtimeMode, expected) => {
    expect(pendingApprovalReason({ kind, runtimeMode })).toContain(expected);
  });

  it("says it does not know for a kind nothing here can explain, in any mode", () => {
    for (const runtimeMode of MODES) {
      expect(pendingApprovalReason({ kind: "brand-new-kind", runtimeMode })).toBe(
        APPROVAL_REASON_UNKNOWN,
      );
    }
  });

  it("says it does not know without a mode, rather than assuming one", () => {
    expect(pendingApprovalReason({ kind: "command", runtimeMode: null })).toBe(
      APPROVAL_REASON_UNKNOWN,
    );
    expect(pendingApprovalReason({ kind: "command", runtimeMode: undefined })).toBe(
      APPROVAL_REASON_UNKNOWN,
    );
  });

  it("never works out why from the kind, for a change a mode would otherwise cover", () => {
    const reason = pendingApprovalReason({ kind: "file-change", runtimeMode: "auto-accept-edits" });
    expect(reason).toBe(
      "Auto-accept edits did not cover this file change. The provider gave no reason.",
    );
    expect(reason).not.toMatch(/outside|workspace/i);
  });

  it("says no reason was given wherever the mode alone does not explain asking", () => {
    for (const runtimeMode of ["auto-accept-edits", "auto", "full-access"] as const) {
      for (const kind of ["command", "file-change", "file-read", "permission"]) {
        expect(pendingApprovalReason({ kind, runtimeMode })).toContain(
          "The provider gave no reason.",
        );
      }
    }
    // Supervised asks by its nature, so nothing is missing there.
    expect(pendingApprovalReason({ kind: "command", runtimeMode: "approval-required" })).toBe(
      "Supervised asks before commands.",
    );
  });

  it("states a file change outside the workspace only when the provider says so", () => {
    const reason = pendingApprovalReason({
      kind: "file-change",
      runtimeMode: "auto-accept-edits",
      reason: "  Writes /etc/hosts, outside the workspace.\n",
    });
    expect(reason).toBe(
      "Auto-accept edits did not cover this file change. The provider says: Writes /etc/hosts, outside the workspace.",
    );
  });

  it("keeps a provider's reason for a kind nothing here knows", () => {
    expect(
      pendingApprovalReason({ kind: "brand-new-kind", runtimeMode: "auto", reason: "Because." }),
    ).toBe("The provider says: Because.");
  });

  it("points at a reason the request already shows, rather than repeating it", () => {
    expect(
      pendingApprovalReason({
        kind: "command",
        runtimeMode: "full-access",
        reason: "Needs network.",
        detail: "Needs network.",
      }),
    ).toBe(
      "Full access allows commands without asking, but the provider asked anyway. The provider's reason is shown above.",
    );
  });

  it("bounds a reason however long the provider's is", () => {
    const reason = pendingApprovalReason({
      kind: "command",
      runtimeMode: "approval-required",
      reason: "x".repeat(2_000),
    });
    expect(reason.length).toBeLessThan(400);
    expect(reason.endsWith("…")).toBe(true);
  });

  it("treats a blank reason as none", () => {
    expect(
      pendingApprovalReason({ kind: "command", runtimeMode: "full-access", reason: "  " }),
    ).toContain("The provider gave no reason.");
  });
});

describe("what Auto-accept edits covers on each provider", () => {
  it("does not claim every provider asks before commands, where a sandbox covers them", () => {
    expect(autoAcceptEditsCoverage("codex").covers).toContain("commands");
    expect(autoAcceptEditsCoverage("cursor").covers).toContain("commands");
    expect(autoAcceptEditsCoverage("pi").stillAsks).toContain("Commands");
    expect(autoAcceptEditsCoverage("opencode").stillAsks).toContain("Commands");
    expect(autoAcceptEditsCoverage("claudeAgent").stillAsks).toContain("outside the workspace");
    expect(autoAcceptEditsCoverage("acpRegistry").covers).toContain(
      "wherever the agent makes them",
    );
  });

  it("says it is not known on a provider it has no facts for", () => {
    expect(autoAcceptEditsCoverage("some-new-driver").stillAsks).toContain("Not known");
    expect(autoAcceptEditsCoverage(undefined).stillAsks).toContain("Not known");
  });

  it("gives a mode choice both what it covers and what still asks", () => {
    const [choice] = runtimeModeChoiceDescriptions([{ mode: "auto-accept-edits" as const }], "pi");
    expect(choice?.description).toBe(
      "Covers: Pi's edit and write tools. Still asks: Commands and extension tools.",
    );
    expect(runtimeModeMeaning("full-access", "pi")).toBe(
      "Allow commands and edits without prompts.",
    );
  });
});

describe("what a pending action is", () => {
  it.each([
    [PLAN_GATE_ACTION, null, "foredeck_authorization"],
    [PLAN_GATE_ACTION, "factory", "foredeck_authorization"],
    [HOST_POLICY_ACTION, null, "host_restriction"],
    ["auth_refresh", "factory", "host_restriction"],
    ["command", "factory", "provider_permission"],
    ["command", "explicit", "provider_permission"],
    ["command", "unknown", "provider_permission"],
    ["command", null, "provider_permission"],
    ["file-read", "factory", "provider_permission"],
    ["file-change", "factory", "provider_permission"],
    ["mcp-elicitation", "factory", "provider_permission"],
    ["permission", "factory", "provider_permission"],
    ["user_input", "factory", "factory_question"],
    ["user_input", "explicit", "unknown"],
    ["user_input", "unknown", "unknown"],
    ["user_input", null, "unknown"],
    ["dynamic_tool_call", "factory", "unknown"],
    ["brand-new-kind", "factory", "unknown"],
  ] as const)("%s on a %s run is %s", (kind, runClass, expected) => {
    expect(classifyPendingAction({ kind, runClass })).toBe(expected);
  });

  it("lists only what someone decides: a tool call or a login refresh has nowhere to decide", () => {
    expect(isOwnerDecidedRequest("command")).toBe(true);
    expect(isOwnerDecidedRequest("user_input")).toBe(true);
    expect(isOwnerDecidedRequest("brand-new-kind")).toBe(true);
    expect(isOwnerDecidedRequest("dynamic_tool_call")).toBe(false);
    expect(isOwnerDecidedRequest("auth_refresh")).toBe(false);
  });

  it("labels each class in words", () => {
    expect(PENDING_ACTION_LABELS.provider_permission).toBe("Provider or session permission");
    expect(PENDING_ACTION_LABELS.host_restriction).toBe("External host restriction");
    expect(PENDING_ACTION_LABELS.foredeck_authorization).toBe("Foredeck authorization");
  });

  it("names who asks from the run's class, and says when that is not known", () => {
    expect(pendingActionProvenance({ kind: "command", runClass: "factory" })).toBe(
      "Factory's own agent",
    );
    expect(pendingActionProvenance({ kind: "command", runClass: "unknown" })).toContain(
      "Not known",
    );
    expect(pendingActionProvenance({ kind: "command", runClass: null })).toContain("No run");
  });

  it("never offers a question tool for a permission, and says an answer grants none", () => {
    const facts = {
      threadId: "thread-1",
      requestId: "request-1",
      runClass: "factory",
      runtimeMode: "auto-accept-edits",
      capability: "live",
      questions: null,
    } as const;
    const permission = pendingRequestNotice({ ...facts, kind: "command" });
    expect(permission).toContain("Provider or session permission on thread thread-1");
    expect(permission).toContain("question tools cannot grant permission");
    expect(permission).not.toContain("assistant_answer");

    const question = pendingRequestNotice({ ...facts, kind: "user_input", questions: "Which?" });
    expect(question).toContain("Reply through assistant_answer");
    expect(question).toContain("request-1");

    const owners = pendingRequestNotice({
      ...facts,
      kind: "user_input",
      runClass: "explicit",
      questions: "Which?",
    });
    expect(owners).not.toContain("assistant_answer");
    expect(pendingActionReason({ ...facts, kind: "user_input" })).toContain("grants no permission");
  });

  it("uses one wording for a list row and a notice", () => {
    const facts = {
      kind: "file-change",
      runClass: "factory",
      runtimeMode: "auto-accept-edits",
      capability: "live",
    } as const;
    const reason = pendingActionReason({ ...facts, reason: "Writes outside the workspace." });
    expect(reason).toContain("The provider says: Writes outside the workspace.");
    expect(
      pendingRequestNotice({
        ...facts,
        reason: "Writes outside the workspace.",
        threadId: "t",
        requestId: "r",
        questions: null,
      }),
    ).toContain(reason);
  });

  it("says a request whose provider is gone cannot be answered", () => {
    expect(
      pendingActionReason({
        kind: "command",
        runClass: "factory",
        runtimeMode: "auto",
        capability: "not_resumable",
      }),
    ).toContain("cannot be answered");
  });

  it("states a refused launch with what each alternative means", () => {
    const reason = pendingActionReason({
      kind: HOST_POLICY_ACTION,
      runClass: null,
      runtimeMode: "approval-required",
      capability: "live",
      refused: {
        provider: "Codex",
        driver: "codex",
        detail: "It allows only these approval policies: never, on-request.",
        choose: "resume",
        alternatives: ["auto-accept-edits", "full-access"],
      },
    });
    expect(reason).toContain("Codex's host policy refuses Supervised.");
    expect(reason).toContain("never, on-request");
    expect(reason).toContain("Nothing ran and no mode changed.");
    expect(reason).toContain("Change the project's default permission mode, then resume.");
    expect(reason).toContain("Auto-accept edits: Covers: File edits and commands");
    expect(reason).toContain("Full access: Allow commands and edits without prompts.");
  });
});

describe("a mode the host refuses, in the composer", () => {
  const codex = (
    restrictions: ServerProvider["runtimeModeRestrictions"],
  ): Pick<ServerProvider, "runtimeModeRestrictions" | "supportedRuntimeModes" | "displayName"> & {
    readonly driver: string;
  } => ({
    driver: "codex",
    displayName: "Codex",
    supportedRuntimeModes: undefined,
    runtimeModeRestrictions: restrictions,
  });
  const refusesSupervised = codex([
    {
      runtimeMode: "approval-required",
      status: "disallowed",
      detail: "It allows only these approval policies: never, on-request.",
    },
    { runtimeMode: "auto-accept-edits", status: "allowed" },
    { runtimeMode: "auto", status: "allowed" },
    { runtimeMode: "full-access", status: "allowed" },
  ]);

  it("refuses only an answer that starts a turn, in the mode core would ask the provider for", () => {
    const answer = (
      responseCapability: "live" | "message" | "not_resumable",
      threadMode: RuntimeMode,
      provider: typeof refusesSupervised | null = refusesSupervised,
    ) => pendingAnswerRefusal({ responseCapability, provider, threadMode });

    expect(answer("message", "approval-required")?.mode).toBe("approval-required");
    expect(answer("message", "auto-accept-edits")).toBeNull();
    expect(answer("live", "approval-required")).toBeNull();
    expect(answer("not_resumable", "approval-required")).toBeNull();
    expect(answer("message", "approval-required", null)).toBeNull();
    // A mode the provider does not offer reaches it as RuntimePolicy steps it.
    const offersFewer = {
      ...refusesSupervised,
      supportedRuntimeModes: ["approval-required", "full-access"] as ReadonlyArray<RuntimeMode>,
    };
    expect(answer("message", "auto", offersFewer)?.mode).toBe("approval-required");
    expect(
      answer("message", "auto", {
        ...offersFewer,
        supportedRuntimeModes: ["full-access"],
      }),
    ).toBeNull();
  });

  it("refuses before a turn, says why, and lists what could run with what it means", () => {
    const refusal = composerRuntimeModeRefusal({
      provider: refusesSupervised,
      runtimeMode: "approval-required",
    });
    expect(refusal?.reason).toBe(
      "Codex's host policy refuses Supervised. It allows only these approval policies: never, on-request.",
    );
    expect(refusal?.summary).toContain("Choose Auto-accept edits, Auto or Full access instead.");
    expect(refusal?.alternatives.map(({ mode }) => mode)).toEqual([
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
    expect(refusal?.alternatives[0]?.meaning).toContain("Still asks:");
  });

  it("keeps the mode: it reports the mode refused and chooses nothing", () => {
    const refusal = composerRuntimeModeRefusal({
      provider: refusesSupervised,
      runtimeMode: "approval-required",
    });
    expect(refusal?.mode).toBe("approval-required");
    expect(refusal).not.toHaveProperty("chosen");
  });

  it("sends in a mode the host allows", () => {
    expect(
      composerRuntimeModeRefusal({ provider: refusesSupervised, runtimeMode: "auto" }),
    ).toBeNull();
  });

  it("never refuses on an unknown policy, a failed read or an adapter that reports none", () => {
    const failedRead = codex([{ runtimeMode: "approval-required", status: "unknown" }]);
    const otherAdapter = codex(undefined);
    for (const provider of [failedRead, otherAdapter, undefined, null]) {
      expect(composerRuntimeModeRefusal({ provider, runtimeMode: "approval-required" })).toBeNull();
    }
  });

  it("offers only modes the provider offers, of those it knows the policy allows", () => {
    const refusal = composerRuntimeModeRefusal({
      provider: {
        driver: "codex",
        displayName: "Codex",
        supportedRuntimeModes: ["approval-required", "full-access"],
        runtimeModeRestrictions: [
          { runtimeMode: "approval-required", status: "disallowed" },
          { runtimeMode: "auto-accept-edits", status: "allowed" },
          { runtimeMode: "full-access", status: "unknown" },
        ],
      },
      runtimeMode: "approval-required",
    });
    expect(refusal?.alternatives).toEqual([]);
    expect(refusal?.summary).toContain("nothing can run here until that policy changes");
  });
});

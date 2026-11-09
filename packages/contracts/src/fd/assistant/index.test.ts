import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId, RunId, ThreadId } from "../../baseSchemas.ts";
import { providerRuntimeModeRestriction, ServerProvider } from "../../server.ts";
import {
  boundedPendingActions,
  FACTORY_PENDING_ACTIONS_MAX,
  FACTORY_PENDING_REASON_MAX,
  FactoryPendingActions,
} from "../factory/index.ts";
import {
  AssistantOverview,
  AssistantReviewEdit,
  AssistantReviewGetInput,
  AssistantReviewSnapshot,
} from "./index.ts";

/** The overview as a client from before the handoff status knows it. */
const OldAssistantOverview = Schema.Struct({
  ideas: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      ideaId: Schema.String,
      goal: Schema.String,
      brief: Schema.String,
      authorized: Schema.Boolean,
      priority: Schema.NullOr(Schema.Int),
      priorityReason: Schema.String,
    }),
  ),
  assignments: Schema.Array(
    Schema.Struct({
      assignmentId: Schema.String,
      projectId: ProjectId,
      ideaId: Schema.String,
      state: Schema.String,
      attempt: Schema.Int,
      goal: Schema.String,
      brief: Schema.String,
      threadId: Schema.NullOr(ThreadId),
      runId: Schema.NullOr(RunId),
      evidence: Schema.Array(Schema.String),
      notice: Schema.String,
    }),
  ),
});

const idea = {
  projectId: "project-a",
  ideaId: "idea",
  goal: "Ship it",
  brief: "Agreed scope",
  authorized: true,
  priority: null,
  priorityReason: "",
};
const assignment = {
  assignmentId: "assignment",
  projectId: "project-a",
  ideaId: "idea",
  state: "needs-input",
  attempt: 1,
  goal: "Ship it",
  brief: "Agreed scope",
  threadId: null,
  runId: null,
  evidence: [],
  notice: "Factory delivery d1 is blocked.",
};
const workItem = {
  sourceId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20",
  itemId: "fd-aaaaaa",
  key: "fd-aaaaaa",
  url: null,
};
const factory = {
  deliveryId: "d1",
  status: "blocked",
  stage: "verify",
  needsYou: "Verify failed.",
  capacityWait: false,
  automaticWaits: { waiting: 1, blocked: 2 },
  endedDispositions: 3,
  notices: ["Background work on t1 is waiting for a project assistant slot."],
  pullRequestUrl: "https://github.com/acme/alpha/pull/7",
  threadId: "thread-author",
};
const legacy = { ideas: [idea], assignments: [assignment] };
const full = {
  ideas: [{ ...idea, capture: { state: "captured", item: workItem } }],
  assignments: [{ ...assignment, executor: "factory", factory, workItem, reviewed: true }],
};

const decodeNew = Schema.decodeUnknownSync(AssistantOverview);
const encodeNew = Schema.encodeSync(AssistantOverview);
const decodeOld = Schema.decodeUnknownSync(OldAssistantOverview);

describe("AssistantOverview", () => {
  it("decodes an older server's payload, with nothing of the handoff in it", () => {
    expect(decodeNew(legacy)).toStrictEqual(legacy);
  });

  it("decodes the handoff's fields, and encodes them back unchanged", () => {
    const decoded = decodeNew(full);
    expect(decoded).toStrictEqual(full);
    expect(encodeNew(decoded)).toStrictEqual(full);
  });

  it("drops the handoff's fields on an older client's copy of the schema", () => {
    expect(decodeOld(full)).toStrictEqual(legacy);
  });

  it("reads a status or stage this build does not know as unknown", () => {
    const decoded = decodeNew({
      ...full,
      assignments: [
        {
          ...full.assignments[0],
          factory: { ...factory, status: "paused", stage: "translate" },
        },
      ],
    });
    expect(decoded.assignments[0]?.factory).toMatchObject({ status: "unknown", stage: "unknown" });
  });

  it("keeps what a Work source says apart from the rank and the delivery, all optional", () => {
    const source = { title: "Ship it", status: "todo", statusName: null, assignee: null };
    const decoded = decodeNew({
      ideas: [{ ...idea, title: "Ship it", source }],
      assignments: [
        {
          ...assignment,
          title: "Ship it",
          priority: 1,
          source,
          factory: {
            ...factory,
            status: "pr_open",
            pullRequestOutcome: "merged",
            proceeding: true,
          },
        },
      ],
    });
    expect(decoded.ideas[0]?.source?.status).toBe("todo");
    expect(decoded.assignments[0]).toMatchObject({ title: "Ship it", priority: 1, source });
    expect(decoded.assignments[0]?.factory).toMatchObject({
      status: "pr_open",
      pullRequestOutcome: "merged",
      proceeding: true,
    });
    expect(decoded.assignments[0]?.source?.assignee).toBeNull();
    // A source's newer status reads as unknown, keeping the row.
    expect(
      decodeNew({ ideas: [{ ...idea, source: { ...source, status: "triage" } }], assignments: [] })
        .ideas[0]?.source?.status,
    ).toBe("unknown");
    // None of it is required of an older server, and an older client drops it.
    expect(decodeNew(legacy)).toStrictEqual(legacy);
    expect(
      decodeOld({ ideas: [{ ...idea, title: "Ship it", source }], assignments: [] }).ideas[0],
    ).not.toHaveProperty("source");
  });

  it("carries a delivery with no row yet, and a capture with no item yet", () => {
    const decoded = decodeNew({
      ideas: [{ ...idea, capture: { state: "pending", item: null } }],
      assignments: [
        { ...assignment, factory: { ...factory, status: null, stage: null, threadId: null } },
      ],
    });
    expect(decoded.ideas[0]?.capture).toStrictEqual({ state: "pending", item: null });
    expect(decoded.assignments[0]?.factory?.status).toBeNull();
  });
});

describe("what a delivery waits on", () => {
  const decodePending = Schema.decodeUnknownSync(FactoryPendingActions);
  const action = (overrides: object = {}) => ({
    kind: "command",
    runClass: "factory",
    runtimeMode: "auto-accept-edits",
    threadId: "thread-1",
    projectId: "project-1",
    requestId: "request-1",
    capability: "live",
    ...overrides,
  });

  it("carries a kind this build does not know, for clients to read as unknown", () => {
    expect(
      decodePending({ items: [action({ kind: "new-kind" })], omitted: 0, complete: true }).items,
    ).toHaveLength(1);
  });

  it("drops an entry it cannot read rather than the whole list", () => {
    const decoded = decodePending({
      items: [action(), action({ capability: "brand-new" })],
      omitted: 0,
      complete: true,
    });
    expect(decoded.items.map(({ requestId }) => requestId)).toEqual(["request-1"]);
  });

  it("bounds a provider's own reason, and carries where a delivery's wait is decided", () => {
    const item = { sourceId: "6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4", itemId: "fd-child1" };
    const decoded = decodePending({
      items: [action({ reason: "Needs network.", item })],
      omitted: 0,
      complete: true,
    }).items[0];
    expect(decoded?.reason).toBe("Needs network.");
    expect(decoded?.item?.itemId).toBe("fd-child1");
    // One past the bound costs only that entry, as with anything else it cannot read.
    expect(
      decodePending({
        items: [action({ reason: "x".repeat(FACTORY_PENDING_REASON_MAX + 1) })],
        omitted: 0,
        complete: true,
      }).items,
    ).toEqual([]);
  });

  it("bounds what crosses the wire, counting the rest", () => {
    const bounded = boundedPendingActions(
      Array.from(
        { length: FACTORY_PENDING_ACTIONS_MAX + 4 },
        () =>
          decodePending({
            items: [action()],
            omitted: 0,
            complete: true,
          }).items[0]!,
      ),
      true,
    );
    expect(bounded.items).toHaveLength(FACTORY_PENDING_ACTIONS_MAX);
    expect(bounded.omitted).toBe(4);
  });

  it("is optional on the overview, so an older server's assignment still decodes", () => {
    const delivery = {
      deliveryId: "delivery-1",
      status: "running",
      stage: null,
      needsYou: null,
      capacityWait: false,
      automaticWaits: { waiting: 0, blocked: 0 },
      endedDispositions: 0,
      notices: [],
      pullRequestUrl: null,
      threadId: null,
    };
    const overviewWith = (factory: object) =>
      Schema.decodeUnknownSync(AssistantOverview)({
        ideas: [],
        assignments: [
          {
            assignmentId: "a",
            projectId: "project-1",
            ideaId: "idea",
            state: "running",
            attempt: 1,
            goal: "g",
            brief: "b",
            threadId: null,
            runId: null,
            evidence: [],
            notice: "",
            factory,
          },
        ],
      });
    expect(overviewWith(delivery).assignments[0]?.factory?.pendingActions).toBeUndefined();
    expect(
      overviewWith({
        ...delivery,
        pendingActions: { items: [action()], omitted: 2, complete: false },
      }).assignments[0]?.factory?.pendingActions,
    ).toMatchObject({ omitted: 2, complete: false });
  });
});

describe("what a provider's host says of a mode", () => {
  const restrictionsOf = (restrictions: unknown) =>
    Schema.decodeUnknownSync(ServerProvider.fields.runtimeModeRestrictions)(restrictions);

  it("reads as unknown from an adapter that reports nothing", () => {
    expect(providerRuntimeModeRestriction({}, "approval-required")).toEqual({
      runtimeMode: "approval-required",
      status: "unknown",
    });
  });

  it("reads as unknown for a mode the provider did not name", () => {
    expect(
      providerRuntimeModeRestriction(
        { runtimeModeRestrictions: [{ runtimeMode: "auto", status: "allowed" }] },
        "full-access",
      ).status,
    ).toBe("unknown");
  });

  it("drops a status this build does not know instead of reading it as allowed", () => {
    const decoded = restrictionsOf([
      { runtimeMode: "auto", status: "partly" },
      { runtimeMode: "full-access", status: "disallowed", detail: "No." },
    ]);
    expect(decoded).toEqual([{ runtimeMode: "full-access", status: "disallowed", detail: "No." }]);
    expect(
      providerRuntimeModeRestriction({ runtimeModeRestrictions: decoded }, "auto").status,
    ).toBe("unknown");
  });
});

describe("AssistantReviewSnapshot", () => {
  const role = {
    instanceId: "codex",
    model: "m",
    offered: true,
    options: [{ id: "effort", value: "high", supported: false }],
    optionsOmitted: 0,
    acknowledgement: "not_reported",
  };
  const snapshot = {
    reviewVersion: "abc",
    projectId: "project-a",
    ideaId: "idea",
    briefRevision: 2,
    title: { text: "Ship it", origin: "derived" },
    goal: "Ship it",
    acceptanceCriteria: ["Works"],
    constraints: [],
    decisions: [],
    openQuestions: [],
    conversationNotes: { items: ["Temporary"], delivered: false },
    scopeChanges: null,
    target: {
      repository: null,
      kind: "single",
      kindFixed: false,
      source: null,
      sources: [],
      sourcesOmitted: 0,
      item: null,
    },
    roles: { planner: role, author: role, reviewer: role },
    verifyCommand: null,
    setupCommand: null,
    limits: {
      maxFixRounds: 3,
      maxReviewRounds: 3,
      maxFixCommitTurns: null,
      verifyTimeoutMinutes: 30,
      verifyTimeoutScope: "per_command",
      totalTime: "unsupported",
    },
    blockingSeverities: ["high"],
    highRiskEffort: "xhigh",
    pipelineId: "standard",
    runtime: { requested: "full-access", ceiling: null },
    overrides: [{ prompt: "plan", state: "absent" }],
    attempts: [],
    attemptsOmitted: 0,
    start: { mode: "none", blockers: [{ code: "settings", message: "No verify command." }] },
    briefTruncated: false,
    truncated: false,
  };
  const decode = Schema.decodeUnknownSync(AssistantReviewSnapshot);

  it("carries a review that cannot start, with what it could read of the rest", () => {
    expect(decode(snapshot)).toStrictEqual(snapshot);
  });

  it.each([
    ["notes marked delivered", { conversationNotes: { items: [], delivered: true } }],
    [
      "a timeout not limited to one command",
      { limits: { ...snapshot.limits, verifyTimeoutScope: "total" } },
    ],
    ["a total time limit", { limits: { ...snapshot.limits, totalTime: 60 } }],
    [
      "an acknowledgement nobody gave",
      { roles: { ...snapshot.roles, author: { ...role, acknowledgement: "confirmed" } } },
    ],
  ])("has no room for %s", (_name, patch) => {
    expect(() => decode({ ...snapshot, ...patch })).toThrow();
  });

  it("asks only about an idea short enough to answer with whole", () => {
    const decodeInput = Schema.decodeUnknownSync(AssistantReviewGetInput);
    const input = {
      projectId: "project-a",
      ideaId: "i".repeat(1024),
      managerThreadId: "thread-a",
      kind: "single",
    };
    expect(decodeInput(input).ideaId).toHaveLength(1024);
    expect(() => decodeInput({ ...input, ideaId: "i".repeat(1025) })).toThrow();
    expect(() => decodeInput({ ...input, projectId: "p".repeat(1025) })).toThrow();
  });

  it("carries where a Work source writes, and no more of it", () => {
    const source = {
      sourceId: "7e2aa85e-9347-44ce-b019-cb8dfd365b20",
      kind: "markdown",
      label: "Tasks",
      identity: ".foredeck/work",
    };
    const decoded = decode({
      ...snapshot,
      target: { ...snapshot.target, source, sources: [source] },
    });
    expect(decoded.target.source).toStrictEqual(source);
    expect(() =>
      decode({
        ...snapshot,
        target: { ...snapshot.target, source: { ...source, identity: undefined } },
      }),
    ).toThrow();
  });

  it("gives an edit no way to authorize anything, and bounds its title", () => {
    const decodeEdit = Schema.decodeUnknownSync(AssistantReviewEdit);
    expect(decodeEdit({ title: "Short", executionAuthorized: true })).toStrictEqual({
      title: "Short",
    });
    expect(() => decodeEdit({ title: "x".repeat(81) })).toThrow();
  });
});

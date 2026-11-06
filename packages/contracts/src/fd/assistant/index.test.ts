import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ProjectId, RunId, ThreadId } from "../../baseSchemas.ts";
import { AssistantOverview } from "./index.ts";

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
  assignments: [{ ...assignment, executor: "factory", factory, workItem }],
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

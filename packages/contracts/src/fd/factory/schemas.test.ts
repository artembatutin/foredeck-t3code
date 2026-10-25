import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type * as FactoryEntry from "@t3tools/contracts/fd/factory";
import {
  FactoryDelivery,
  FactoryDeliveryId,
  FactoryDeliveryStatus,
  FactoryPlan,
  FactoryPlanTask,
  FactoryProjectSettings,
  FactoryReview,
  FactoryStageKind,
  FactoryStageName,
  FactoryTaskId,
  FactoryVerifyReceipt,
  FactoryVerifyReceiptSummary,
} from "./index.ts";

// Typechecks only while the package's `./fd/factory` subpath export resolves to this entry.
const statusViaSubpath: typeof FactoryEntry.FactoryDeliveryStatus = FactoryDeliveryStatus;

const uuid = "7e2aa85e-9347-44ce-b019-cb8dfd365b20";
const headSha = "a".repeat(40);

describe("Factory entry", () => {
  it("lists the delivery statuses, stage names and stage kinds of the design", () => {
    expect(statusViaSubpath.literals).toEqual([
      "queued",
      "running",
      "waiting",
      "blocked",
      "stopping",
      "stopped",
      "approved",
      "pr_open",
      "done",
      "cancelled",
    ]);
    expect(FactoryStageName.literals).toEqual([
      "plan",
      "approve_plan",
      "author",
      "verify",
      "review",
      "repair",
      "record",
      "integrate",
      "pr",
      "follow_through",
    ]);
    expect(FactoryStageKind.literals).toEqual(["agent", "command", "gate", "integrate", "pr"]);
  });
});

describe("Factory ids", () => {
  const decodeDeliveryId = Schema.decodeUnknownSync(FactoryDeliveryId);
  const decodeTaskId = Schema.decodeUnknownSync(FactoryTaskId);

  it.each(["factory-contracts", uuid, "T1", "task_2.b", "x".repeat(64)])("accepts %j", (id) => {
    expect(decodeDeliveryId(id)).toBe(id);
    expect(decodeTaskId(id)).toBe(id);
  });

  it.each(["", "..", "../task", "a/b", ".hidden", "-flag", "has space", "x".repeat(65), 7, null])(
    "rejects %j, which is unsafe as an evidence file name",
    (id) => {
      expect(() => decodeDeliveryId(id)).toThrow();
      expect(() => decodeTaskId(id)).toThrow();
    },
  );
});

describe("FactoryProjectSettings", () => {
  const decode = Schema.decodeUnknownSync(FactoryProjectSettings);
  const verifyCommand = { executable: "vp", args: ["test", "run"] };

  it("fills the design defaults around a verify command", () => {
    expect(decode({ verifyCommand })).toEqual({
      verifyCommand,
      setupCommand: null,
      roles: { planner: null, author: null, reviewer: null },
      limits: { maxFixRounds: 2, maxReviewRounds: 2, verifyTimeoutMinutes: 30 },
      blockingSeverities: ["high"],
      highRiskEffort: "xhigh",
      pipelineId: "standard",
    });
  });

  it("leaves the verify command unset until the owner sets one", () => {
    expect(decode({}).verifyCommand).toBeNull();
  });

  it("keeps a setup command, a role model and partial limits", () => {
    const setupCommand = { executable: "vp", args: ["i"] };
    const reviewer = { instanceId: "codex", model: "gpt-6-astra" };
    const settings = decode({
      verifyCommand,
      setupCommand,
      roles: { reviewer },
      limits: { maxReviewRounds: 4 },
    });
    expect(settings.setupCommand).toEqual(setupCommand);
    expect(settings.roles).toEqual({ planner: null, author: null, reviewer });
    expect(settings.limits).toEqual({
      maxFixRounds: 2,
      maxReviewRounds: 4,
      verifyTimeoutMinutes: 30,
    });
  });

  it.each([
    ["an empty executable", { verifyCommand: { executable: "", args: [] } }],
    ["a blank executable", { verifyCommand: { executable: "  ", args: ["run"] } }],
    ["args that are not an array", { verifyCommand: { executable: "vp", args: "test run" } }],
    ["a shell line instead of a command", { verifyCommand: "vp test run" }],
    ["setup args that are not an array", { setupCommand: { executable: "vp", args: { 0: "i" } } }],
    ["an unknown blocking severity", { verifyCommand, blockingSeverities: ["critical"] }],
    ["a negative round limit", { verifyCommand, limits: { maxFixRounds: -1 } }],
    ["a zero verify timeout", { verifyCommand, limits: { verifyTimeoutMinutes: 0 } }],
  ])("rejects %s", (_label, input) => {
    expect(() => decode(input)).toThrow();
  });
});

const task = {
  id: "factory-contracts",
  title: "Add Factory contracts",
  kind: "feature",
  summary: "Ids, statuses, settings, plan, review, receipt and delivery schemas.",
  acceptance: ["Settings decode with the design defaults.", "Newer snapshots still decode."],
  testPlan: [
    {
      criterion: 1,
      check: "Decode a minimal settings input and assert every default.",
      paths: ["packages/contracts/src/fd/factory/schemas.test.ts"],
    },
    { criterion: 2, check: "Decode a snapshot with unknown values.", paths: [] },
  ],
  likelyPaths: ["packages/contracts/src/fd/factory/schemas.ts", "packages/contracts/package.json"],
  risk: "normal",
};

describe("FactoryPlanTask and FactoryPlan", () => {
  const decodeTask = Schema.decodeUnknownSync(FactoryPlanTask);
  const decodePlan = Schema.decodeUnknownSync(FactoryPlan);

  it("decodes a valid task and plan", () => {
    expect(decodeTask(task)).toEqual(task);
    expect(decodePlan({ tasks: [task] })).toEqual({ tasks: [task] });
  });

  it("accepts an empty plan that explains itself", () => {
    const plan = { tasks: [], note: "Main already satisfies the goal." };
    expect(decodePlan(plan)).toEqual(plan);
  });

  it.each([
    ["an unknown kind", { ...task, kind: "spike" }],
    ["an unknown risk", { ...task, risk: "medium" }],
    ["empty acceptance", { ...task, acceptance: [] }],
    ["a blank criterion", { ...task, acceptance: ["  "] }],
    ["criterion 0", { ...task, testPlan: [{ criterion: 0, check: "Run it.", paths: [] }] }],
    ["a fractional criterion", { ...task, testPlan: [{ criterion: 1.5, check: "x", paths: [] }] }],
    ["a path outside the repository", { ...task, likelyPaths: ["../outside.ts"] }],
    ["an absolute path", { ...task, likelyPaths: ["/etc/hosts"] }],
    ["a Windows path", { ...task, likelyPaths: ["src\\index.ts"] }],
    ["an id unsafe as a file name", { ...task, id: "../task" }],
    ["a multi-line title", { ...task, title: "Add\ncontracts" }],
  ])("rejects a task with %s", (_label, input) => {
    expect(() => decodeTask(input)).toThrow();
  });
});

const finding = {
  id: "F1",
  severity: "high",
  required: true,
  file: "packages/contracts/src/fd/factory/schemas.ts",
  line: 42,
  detail: "An unknown status fails the snapshot, so an older client loses the whole delivery.",
};

const review = {
  verdict: "changes-required",
  findings: [
    finding,
    {
      id: "F2",
      severity: "low",
      required: false,
      file: "docs/internals/factory.md",
      line: null,
      detail: "The ledger trap is undocumented, so a maintainer may add a core migration.",
    },
  ],
  acceptance: [
    {
      criterion: 1,
      status: "verified",
      evidence: "schemas.test.ts decodes a minimal input and asserts every default.",
      paths: ["packages/contracts/src/fd/factory/schemas.test.ts"],
    },
    { criterion: 2, status: "failed", evidence: "Unknown statuses throw.", paths: [] },
    { criterion: 3, status: "untested", evidence: "No test omits optional fields.", paths: [] },
  ],
  missing_evidence: ["No test decodes a snapshot without its optional fields."],
};

describe("FactoryReview", () => {
  const decode = Schema.decodeUnknownSync(FactoryReview);

  it("decodes a valid review", () => {
    expect(decode(review)).toEqual(review);
  });

  it.each([
    ["an unknown verdict", { ...review, verdict: "approve" }],
    ["an unknown severity", { ...review, findings: [{ ...finding, severity: "critical" }] }],
    ["a finding at line 0", { ...review, findings: [{ ...finding, line: 0 }] }],
    ["a finding outside the repository", { ...review, findings: [{ ...finding, file: "/tmp/x" }] }],
    [
      "an unknown acceptance status",
      {
        ...review,
        acceptance: [{ criterion: 1, status: "skipped", evidence: "Not run.", paths: [] }],
      },
    ],
    ["missing evidence that is not a list", { ...review, missing_evidence: "none" }],
  ])("rejects a review with %s", (_label, input) => {
    expect(() => decode(input)).toThrow();
  });
});

const receiptSummary = {
  headSha,
  tree: "b".repeat(40),
  startedAt: "2026-10-23T09:00:00.000Z",
  finishedAt: "2026-10-23T09:01:30.000Z",
  code: 0,
  timedOut: false,
  durationMs: 90_000,
};

const receipt = {
  version: 1,
  ...receiptSummary,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "c".repeat(64),
  platform: "darwin-arm64",
  logPath: "/home/owner/.t3/userdata/fd-factory/d-1/verify-1.log",
  outputHash: "d".repeat(64),
};

describe("FactoryVerifyReceipt", () => {
  const decode = Schema.decodeUnknownSync(FactoryVerifyReceipt);
  const encode = Schema.encodeSync(FactoryVerifyReceipt);

  it("round-trips a full receipt", () => {
    const decoded = decode(receipt);
    expect(decoded).toEqual(receipt);
    expect(encode(decoded)).toEqual(receipt);
  });

  it("records a timed-out run without an exit code", () => {
    expect(decode({ ...receipt, code: null, timedOut: true })).toMatchObject({
      code: null,
      timedOut: true,
    });
  });

  it.each([
    ["an abbreviated commit", { ...receipt, headSha: "abc1234" }],
    ["an uppercase tree id", { ...receipt, tree: "B".repeat(40) }],
    ["a shell-line command", { ...receipt, command: "vp test run" }],
    ["a negative duration", { ...receipt, durationMs: -1 }],
    ["no log path", { ...receipt, logPath: "" }],
  ])("rejects a receipt with %s", (_label, input) => {
    expect(() => decode(input)).toThrow();
  });
});

describe("FactoryVerifyReceiptSummary", () => {
  const decode = Schema.decodeUnknownSync(FactoryVerifyReceiptSummary);
  // Exactly these keys: adding the log, its path or the command line fails typecheck here.
  const summaryKeys: Record<keyof FactoryVerifyReceiptSummary, true> = {
    headSha: true,
    tree: true,
    startedAt: true,
    finishedAt: true,
    code: true,
    timedOut: true,
    durationMs: true,
    number: true,
  };

  it("keeps a receipt's outcome and drops its log path and command", () => {
    const summary = decode({ ...receipt, number: 4 });
    expect(Object.keys(summary).sort()).toEqual(Object.keys(summaryKeys).sort());
    expect(summary).toEqual({ ...receiptSummary, number: 4 });
  });
});

const reviewSummary = {
  headSha,
  verdict: "changes-required",
  blocking: true,
  findings: { high: 1, medium: 0, low: 1 },
  reviewedAt: "2026-10-23T09:05:00.000Z",
};

const snapshot = {
  deliveryId: "d-1",
  projectId: "project-1",
  itemRef: { sourceId: uuid, itemId: "fd-7k3qa2" },
  parentId: "d-0",
  childIds: [],
  status: "blocked",
  stage: { name: "review", kind: "agent" },
  rounds: { fix: 1, review: 2 },
  branch: "fd/fd-7k3qa2",
  worktreePath: "/home/owner/worktrees/fd-7k3qa2",
  threads: { author: "thread-author", reviewer: "thread-reviewer" },
  receipts: [receiptSummary],
  reviews: [reviewSummary],
  stageRuns: [
    {
      stage: "verify",
      attempt: 1,
      outcome: "passed",
      startedAt: "2026-10-23T09:00:00.000Z",
      finishedAt: "2026-10-23T09:01:00.000Z",
    },
    {
      stage: "review",
      attempt: 2,
      outcome: null,
      threadId: "thread-reviewer",
      startedAt: "2026-10-23T09:02:00.000Z",
    },
  ],
  needsYou: "Review found the same high finding twice on an unchanged tree.",
  createdAt: "2026-10-23T08:59:00.000Z",
  updatedAt: "2026-10-23T09:05:00.000Z",
};

describe("FactoryDelivery", () => {
  const decode = Schema.decodeUnknownSync(FactoryDelivery);

  it("decodes a current snapshot", () => {
    expect(decode(snapshot)).toEqual(snapshot);
  });

  it("reads a status, stage and stage kind from a newer server as unknown", () => {
    const decoded = decode({
      ...snapshot,
      status: "future_status",
      stage: { name: "deploy", kind: "release" },
    });
    expect(decoded.status).toBe("unknown");
    expect(decoded.stage).toEqual({ name: "unknown", kind: "unknown" });
  });

  it("keeps a known stage name when only its kind is new", () => {
    const decoded = decode({ ...snapshot, stage: { name: "verify", kind: "container" } });
    expect(decoded.stage).toEqual({ name: "verify", kind: "unknown" });
  });

  it("drops fields this build does not know, including any receipt log", () => {
    const decoded = decode({
      ...snapshot,
      budget: { tokens: 5 },
      threads: { ...snapshot.threads, integrator: "thread-integrator" },
      receipts: [{ ...receiptSummary, logPath: receipt.logPath, log: "FAIL schemas.test.ts" }],
    });
    expect(decoded).toEqual(snapshot);
    expect(decoded.receipts[0]).not.toHaveProperty("log");
  });

  it("leaves out a receipt or review summary it cannot read instead of failing", () => {
    const decoded = decode({
      ...snapshot,
      receipts: [{ ...receiptSummary, headSha: "abc1234" }, receiptSummary],
      reviews: [{ ...reviewSummary, verdict: "abstain" }],
    });
    expect(decoded.receipts).toEqual([receiptSummary]);
    expect(decoded.reviews).toEqual([]);
  });

  it("decodes a snapshot without its optional fields", () => {
    const minimal = {
      deliveryId: "d-2",
      projectId: "project-1",
      itemRef: snapshot.itemRef,
      childIds: [],
      status: "queued",
      rounds: { fix: 0, review: 0 },
      threads: {},
      receipts: [],
      reviews: [],
      createdAt: snapshot.createdAt,
      updatedAt: snapshot.createdAt,
    };
    const decoded = decode(minimal);
    expect(decoded).toEqual({ ...minimal, stageRuns: [] });
    expect(decoded.stage).toBeUndefined();
    expect(decoded.needsYou).toBeUndefined();
  });

  it("still rejects a snapshot that does not name its delivery or item", () => {
    expect(() => decode({ ...snapshot, deliveryId: undefined })).toThrow();
    expect(() => decode({ ...snapshot, itemRef: { sourceId: uuid } })).toThrow();
  });
});

// @effect-diagnostics nodeBuiltinImport:off - the import scan reads module sources synchronously, outside any Effect program.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";

import { RunId, ThreadId } from "@t3tools/contracts";
import type { FactoryVerifyReceipt } from "@t3tools/contracts/fd/factory";
import { parseSync } from "vite-plus";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { advance } from "./engine.ts";
import { queuedDeliveryState } from "./state.ts";
import type {
  FactoryAdvance,
  FactoryCommandOutcome,
  FactoryDeliveryState,
  FactoryEffect,
  FactoryEvent,
  FactorySettleResult,
  FactoryTerminalRunStatus,
} from "./state.ts";

const author = ThreadId.make("thread-author");
const otherThread = ThreadId.make("thread-other");
const firstRun = RunId.make("run-1");
const fixRun = RunId.make("run-2");
const otherRun = RunId.make("run-other");
const worktreePath = "/worktrees/item-7";
const baseline = "b".repeat(40);

const receipt = (overrides: Partial<FactoryVerifyReceipt> = {}): FactoryVerifyReceipt => ({
  version: 1,
  headSha: "a".repeat(40),
  tree: "c".repeat(40),
  startedAt: "2026-10-23T10:00:00.000Z",
  finishedAt: "2026-10-23T10:01:00.000Z",
  code: 0,
  timedOut: false,
  durationMs: 60_000,
  command: { executable: "vp", args: ["test", "run"] },
  settingsHash: "settings-1",
  platform: "darwin-arm64",
  logPath: "/t3/userdata/fd-factory/delivery-1/verify-1.log",
  outputHash: "output-1",
  ...overrides,
});

// Effect ids, issued in order. Every path starts with the author launch (1) and the settle check
// of run-1 (2). A settled branch then runs verify (3); a repairable one gets the fix-commit turn
// (3), the settle check of run-2 (4) and verify (5).
const LAUNCH = 1;
const FIRST_CHECK = 2;
const VERIFY = 3;
const FIX_TURN = 3;
const SECOND_CHECK = 4;

const start: FactoryEvent = { type: "start" };
const launched = (effectId = LAUNCH): FactoryEvent => ({
  type: "thread.launched",
  effectId,
  threadId: author,
  runId: firstRun,
  worktreePath,
  baseline,
});
const turnStarted = (effectId: number, runId: RunId): FactoryEvent => ({
  type: "turn.started",
  effectId,
  runId,
});
const runFinished = (
  runId: RunId,
  status: FactoryTerminalRunStatus = "completed",
  threadId = author,
): FactoryEvent => ({ type: "run.finished", threadId, runId, status });
const settleChecked = (effectId: number, result: FactorySettleResult): FactoryEvent => ({
  type: "settle.checked",
  effectId,
  result,
});
const commandFinished = (effectId: number, outcome: FactoryCommandOutcome): FactoryEvent => ({
  type: "command.finished",
  effectId,
  outcome,
});
const effectFailed = (effectId: number, detail = "The worker failed."): FactoryEvent => ({
  type: "effect.failed",
  effectId,
  detail,
});
const passed: FactoryCommandOutcome = { type: "receipt", receipt: receipt() };

const settled: FactorySettleResult = { status: "settled" };
const dirty = "The worktree has uncommitted changes.";
const repairable: FactorySettleResult = { status: "repairable", problems: [dirty] };

/** Feeds events in order and returns the last step. */
const run = (delivery: FactoryDeliveryState, ...events: FactoryEvent[]): FactoryAdvance =>
  events.reduce<FactoryAdvance>((last, event) => advance(last.delivery, event), {
    delivery,
    effects: [],
  });

const queued = queuedDeliveryState({ branch: "fd/item-7", baseRef: "main" });
const awaitingLaunch = run(queued, start).delivery;
const awaitingRun = run(awaitingLaunch, launched()).delivery;
const awaitingSettle = run(awaitingRun, runFinished(firstRun)).delivery;
const awaitingFixTurn = run(awaitingSettle, settleChecked(FIRST_CHECK, repairable)).delivery;
const awaitingFixRun = run(awaitingFixTurn, turnStarted(FIX_TURN, fixRun)).delivery;
const awaitingSecondSettle = run(awaitingFixRun, runFinished(fixRun)).delivery;
const awaitingVerify = run(awaitingSettle, settleChecked(FIRST_CHECK, settled)).delivery;
const verified = run(awaitingVerify, commandFinished(VERIFY, passed)).delivery;
const blockedOnRun = run(awaitingRun, runFinished(firstRun, "failed")).delivery;

/** The step that issues `effect` as the delivery's next effect and awaits it. */
const issued = (delivery: FactoryDeliveryState, effect: FactoryEffect): FactoryAdvance => ({
  delivery: { ...delivery, effectsIssued: effect.id, awaiting: { type: "effect", effect } },
  effects: [effect],
});

const blockedState = (
  delivery: FactoryDeliveryState,
  block: FactoryDeliveryState["block"],
): FactoryAdvance => ({
  delivery: { ...delivery, status: "blocked", awaiting: null, block },
  effects: [],
});

describe("advance purity", () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === "object" && value !== null) {
      for (const child of Object.values(value)) deepFreeze(child);
      Object.freeze(value);
    }
    return value;
  };

  it("never mutates its input and returns equal results for equal inputs", () => {
    const steps: ReadonlyArray<readonly [FactoryDeliveryState, FactoryEvent]> = [
      [queued, start],
      [awaitingLaunch, launched()],
      [awaitingRun, runFinished(firstRun)],
      [awaitingRun, runFinished(firstRun, "failed")],
      [awaitingRun, { type: "thread.deleted", threadId: author }],
      [awaitingSettle, settleChecked(FIRST_CHECK, repairable)],
      [awaitingFixTurn, turnStarted(FIX_TURN, fixRun)],
      [awaitingFixRun, runFinished(fixRun)],
      [awaitingSettle, settleChecked(FIRST_CHECK, settled)],
      [awaitingVerify, commandFinished(VERIFY, passed)],
      [awaitingVerify, commandFinished(VERIFY, { type: "refused", refusals: ["tree_dirty"] })],
      [awaitingVerify, effectFailed(VERIFY, "No shell.")],
      [verified, start],
    ];
    for (const [delivery, event] of steps) {
      // Frozen in strict mode, any write to the input throws.
      const input = deepFreeze(structuredClone(delivery));
      const frozenEvent = deepFreeze(structuredClone(event));
      const first = advance(input, frozenEvent);
      expect(advance(input, frozenEvent)).toEqual(first);
      expect(advance(structuredClone(delivery), structuredClone(event))).toEqual(first);
      expect(input).toEqual(delivery);
    }
  });
});

describe("the engine's imports", () => {
  type AstNode = { readonly type: string; readonly [key: string]: unknown };
  const isAstNode = (value: unknown): value is AstNode =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string";

  const visit = (value: unknown, onNode: (node: AstNode) => void): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, onNode);
      return;
    }
    if (!isAstNode(value)) return;
    onNode(value);
    for (const child of Object.values(value)) visit(child, onNode);
  };

  type ModuleImport =
    | { readonly specifier: string; readonly typeOnly: boolean }
    | { readonly specifier: null };

  const importsOf = (file: URL): ReadonlyArray<ModuleImport> => {
    const path = NodeURL.fileURLToPath(file);
    const { program, errors } = parseSync(path, NodeFS.readFileSync(path, "utf8"));
    expect(errors, `${path} parses`).toEqual([]);
    const found: Array<ModuleImport> = [];
    visit(program, (node) => {
      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportAllDeclaration" ||
        (node.type === "ExportNamedDeclaration" && node.source !== null)
      ) {
        found.push({
          specifier: (node.source as { readonly value: string }).value,
          typeOnly: node.importKind === "type" || node.exportKind === "type",
        });
      } else if (
        node.type === "ImportExpression" ||
        node.type === "TSImportType" ||
        node.type === "TSExternalModuleReference" ||
        (node.type === "CallExpression" &&
          isAstNode(node.callee) &&
          node.callee.type === "Identifier" &&
          node.callee.name === "require")
      ) {
        found.push({ specifier: null });
      }
    });
    return found;
  };

  /** Types from the contracts are the only package imports a pure engine module may have. */
  const ALLOWED_TYPE_IMPORTS = new Set(["@t3tools/contracts", "@t3tools/contracts/fd/factory"]);

  /**
   * Walks every module the entry reaches through relative imports. Relative imports must stay
   * inside `root`; any other import must be a type-only import of the contracts.
   */
  const importGraph = (root: URL, entry: string) => {
    const pending = [new URL(entry, root)];
    const seen = new Set<string>();
    const violations: Array<string> = [];
    for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
      if (seen.has(file.href)) continue;
      seen.add(file.href);
      const name = file.href.slice(root.href.length);
      for (const found of importsOf(file)) {
        if (found.specifier === null) {
          violations.push(`${name} has a dynamic import`);
        } else if (found.specifier.startsWith(".")) {
          const target = new URL(found.specifier, file);
          if (target.href.startsWith(root.href)) pending.push(target);
          else violations.push(`${name} imports ${found.specifier}`);
        } else if (!found.typeOnly || !ALLOWED_TYPE_IMPORTS.has(found.specifier)) {
          violations.push(`${name} imports ${found.specifier}`);
        }
      }
    }
    return {
      modules: [...seen].map((href) => href.slice(root.href.length)).sort(),
      violations,
    };
  };

  let scratch: URL | undefined;
  afterEach(() => {
    if (scratch !== undefined) NodeFS.rmSync(scratch, { recursive: true, force: true });
    scratch = undefined;
  });

  it("reach no Effect service, filesystem, process or database module", () => {
    expect(importGraph(new URL("./", import.meta.url), "engine.ts")).toEqual({
      modules: [
        "definitions.ts",
        "engine.ts",
        "stages/agent.ts",
        "stages/command.ts",
        "stages/gate.ts",
        "stages/pr.ts",
        "stages/registry.ts",
        "state.ts",
      ],
      violations: [],
    });
  });

  it("are checked through every relative module, not just the entry", () => {
    const root = NodeURL.pathToFileURL(
      `${NodeFS.mkdtempSync(`${NodeOS.tmpdir()}/fd-factory-engine-imports-`)}/`,
    );
    scratch = root;
    const write = (path: string, source: string) =>
      NodeFS.writeFileSync(new URL(path, root), source);
    write(
      "engine.ts",
      [
        'import * as Effect from "effect/Effect";',
        'import type { FactoryRole } from "@t3tools/contracts/fd/factory";',
        'import { helper } from "./helper.ts";',
        'export { outside } from "../outside.ts";',
      ].join("\n"),
    );
    write(
      "helper.ts",
      [
        'import * as NodeFS from "node:fs";',
        'import { RunId } from "@t3tools/contracts";',
        'export const load = () => import("./lazy.ts");',
      ].join("\n"),
    );
    expect(importGraph(root, "engine.ts")).toEqual({
      modules: ["engine.ts", "helper.ts"],
      violations: [
        "engine.ts imports effect/Effect",
        "engine.ts imports ../outside.ts",
        "helper.ts imports node:fs",
        "helper.ts imports @t3tools/contracts",
        "helper.ts has a dynamic import",
      ],
    });
  });
});

describe("starting a delivery", () => {
  it("runs the author stage on a new worktree for the delivery branch", () => {
    const launch = {
      id: LAUNCH,
      type: "launch_thread",
      role: "author",
      workspace: { type: "worktree", branch: "fd/item-7", baseRef: "main" },
    } as const;
    // The author launch is recorded as it is issued; see engine.resume.test.ts.
    expect(advance(queued, start)).toEqual(
      issued({ ...queued, status: "running", stage: "author", authorLaunch: launch }, launch),
    );
  });

  it("records the launched author thread, its worktree and the baseline", () => {
    expect(advance(awaitingLaunch, launched())).toEqual({
      delivery: {
        ...awaitingLaunch,
        worktreePath,
        baseline,
        threads: { author },
        awaiting: { type: "run", threadId: author, runId: firstRun },
      },
      effects: [],
    });
  });

  it("launches in the worktree the delivery already records, and keeps it", () => {
    const shared = queuedDeliveryState({
      branch: "fd/parent-3",
      baseRef: "main",
      worktreePath: "/worktrees/parent-3",
    });
    const started = advance(shared, start);
    expect(started.effects).toEqual([
      {
        id: LAUNCH,
        type: "launch_thread",
        role: "author",
        workspace: { type: "existing_worktree", worktreePath: "/worktrees/parent-3" },
      },
    ]);
    expect(advance(started.delivery, launched()).delivery.worktreePath).toBe("/worktrees/parent-3");
  });
});

describe("the author run ending", () => {
  it("checks that the branch settles after a completed run", () => {
    expect(advance(awaitingRun, runFinished(firstRun))).toEqual(
      issued(awaitingRun, {
        id: FIRST_CHECK,
        type: "check_settle",
        threadId: author,
        runId: firstRun,
      }),
    );
  });

  it.each(["failed", "cancelled", "interrupted", "rolled_back"] as const)(
    "blocks on a %s run without effects",
    (status) => {
      expect(advance(awaitingRun, runFinished(firstRun, status))).toEqual(
        blockedState(awaitingRun, {
          reason: "run_ended",
          threadId: author,
          runId: firstRun,
          runStatus: status,
        }),
      );
    },
  );

  it.each([
    ["awaiting its run", awaitingRun],
    ["awaiting the settle check", awaitingSettle],
    ["awaiting the fix-commit turn", awaitingFixTurn],
    ["running verify", awaitingVerify],
  ] as const)("blocks when the author thread is deleted while %s", (_, delivery) => {
    expect(advance(delivery, { type: "thread.deleted", threadId: author })).toEqual(
      blockedState(delivery, { reason: "thread_deleted", threadId: author }),
    );
  });
});

describe("settling the branch", () => {
  it("runs the verify command once the branch settles", () => {
    expect(advance(awaitingSettle, settleChecked(FIRST_CHECK, settled))).toEqual(
      issued(
        { ...awaitingSettle, stage: "verify" },
        { id: VERIFY, type: "run_command", stage: "verify" },
      ),
    );
  });

  it("asks the author thread for one fix-commit turn, then blocks if the branch still does not settle", () => {
    const repair = advance(awaitingSettle, settleChecked(FIRST_CHECK, repairable));
    expect(repair).toEqual(
      issued(
        { ...awaitingSettle, fixCommitTurns: 1 },
        { id: FIX_TURN, type: "send_fix_commit_turn", threadId: author, problems: [dirty] },
      ),
    );

    const rechecked = run(repair.delivery, turnStarted(FIX_TURN, fixRun), runFinished(fixRun));
    expect(rechecked.effects).toEqual([
      { id: SECOND_CHECK, type: "check_settle", threadId: author, runId: fixRun },
    ]);

    const problems = ["Commit 1a2b3c4 has a subject that is not a Conventional Commit."];
    expect(
      advance(rechecked.delivery, settleChecked(SECOND_CHECK, { status: "repairable", problems })),
    ).toEqual(blockedState(rechecked.delivery, { reason: "unsettled", problems }));
  });

  it("runs verify when the fix-commit turn settles the branch", () => {
    expect(advance(awaitingSecondSettle, settleChecked(SECOND_CHECK, settled))).toEqual(
      issued(
        { ...awaitingSecondSettle, stage: "verify" },
        { id: SECOND_CHECK + 1, type: "run_command", stage: "verify" },
      ),
    );
  });

  it("blocks when the fix-commit run does not complete", () => {
    expect(advance(awaitingFixRun, runFinished(fixRun, "interrupted"))).toEqual(
      blockedState(awaitingFixRun, {
        reason: "run_ended",
        threadId: author,
        runId: fixRun,
        runStatus: "interrupted",
      }),
    );
  });

  it("blocks at once on an AI identity, without a fix-commit turn", () => {
    const problems = ["Commit 1a2b3c4 names an AI agent as its author."];
    expect(
      advance(awaitingSettle, settleChecked(FIRST_CHECK, { status: "unrepairable", problems })),
    ).toEqual(blockedState(awaitingSettle, { reason: "unsettled", problems }));
  });
});

describe("the verify command finishing", () => {
  it("records a passing receipt and launches the first review round's reviewer", () => {
    const pass = receipt();
    expect(
      advance(awaitingVerify, commandFinished(VERIFY, { type: "receipt", receipt: pass })),
    ).toEqual(
      issued(
        { ...awaitingVerify, stage: "review", reviewRound: 1, receipts: [pass] },
        {
          id: VERIFY + 1,
          type: "launch_thread",
          role: "reviewer",
          workspace: { type: "existing_worktree", worktreePath },
        },
      ),
    );
  });

  it.each([
    ["failing", receipt({ code: 1 })],
    ["timed-out", receipt({ code: null, timedOut: true })],
    ["signal-killed", receipt({ code: null })],
  ] as const)("records a %s receipt and blocks when no fix round is allowed", (_, failed) => {
    // engine.repair.test.ts covers the fix rounds a failed receipt gets otherwise.
    const noRounds = { ...awaitingVerify, limits: { maxFixRounds: 0, maxReviewRounds: 0 } };
    expect(
      advance(noRounds, commandFinished(VERIFY, { type: "receipt", receipt: failed })),
    ).toEqual(blockedState({ ...noRounds, receipts: [failed] }, { reason: "verify_failed" }));
  });

  it.each([[["head_changed"]], [["tree_dirty"]], [["head_changed", "tree_dirty"]]] as const)(
    "blocks without a receipt when the server refuses one (%j)",
    (refusals) => {
      expect(
        advance(awaitingVerify, commandFinished(VERIFY, { type: "refused", refusals })),
      ).toEqual(blockedState(awaitingVerify, { reason: "receipt_refused", refusals }));
    },
  );
});

describe("a worker failure", () => {
  it.each([
    ["launch_thread", awaitingLaunch],
    ["send_fix_commit_turn", awaitingFixTurn],
    ["check_settle", awaitingSettle],
    ["run_command", awaitingVerify],
  ] as const)("of the awaited %s effect blocks with that effect and its detail", (_, delivery) => {
    if (delivery.awaiting?.type !== "effect") throw new Error("the state awaits an effect");
    const { effect } = delivery.awaiting;
    const detail = "The worktree is missing.";
    expect(advance(delivery, effectFailed(effect.id, detail))).toEqual(
      blockedState(delivery, { reason: "effect_failed", effect, detail }),
    );
  });
});

describe("stale events", () => {
  const EVENT_TYPES = [
    "start",
    "thread.launched",
    "turn.started",
    "run.finished",
    "thread.deleted",
    "settle.checked",
    "command.finished",
    "effect.failed",
  ] as const satisfies ReadonlyArray<FactoryEvent["type"]>;

  const STATES = {
    queued,
    "author, awaiting the launch": awaitingLaunch,
    "author, awaiting the run": awaitingRun,
    "author, awaiting the settle check": awaitingSettle,
    "author, awaiting the fix-commit turn": awaitingFixTurn,
    "author, awaiting the fix-commit run": awaitingFixRun,
    "author, awaiting the second settle check": awaitingSecondSettle,
    "verify, awaiting the command": awaitingVerify,
    "review, awaiting the reviewer launch": verified,
    blocked: blockedOnRun,
    done: { ...awaitingRun, status: "done" },
    cancelled: { ...awaitingRun, status: "cancelled" },
  } satisfies Record<string, FactoryDeliveryState>;

  /**
   * The event types each state answers to; every other type is stale there. Review events are
   * covered in `engine.review.test.ts`.
   */
  const ANSWERED: Readonly<Record<keyof typeof STATES, ReadonlyArray<FactoryEvent["type"]>>> = {
    queued: ["start"],
    "author, awaiting the launch": ["thread.launched", "effect.failed"],
    "author, awaiting the run": ["run.finished", "thread.deleted"],
    "author, awaiting the settle check": ["settle.checked", "thread.deleted", "effect.failed"],
    "author, awaiting the fix-commit turn": ["turn.started", "thread.deleted", "effect.failed"],
    "author, awaiting the fix-commit run": ["run.finished", "thread.deleted"],
    "author, awaiting the second settle check": [
      "settle.checked",
      "thread.deleted",
      "effect.failed",
    ],
    "verify, awaiting the command": ["command.finished", "thread.deleted", "effect.failed"],
    "review, awaiting the reviewer launch": ["thread.launched", "thread.deleted", "effect.failed"],
    blocked: [],
    done: [],
    cancelled: [],
  };

  /**
   * An event of `type` naming what the delivery awaits: the awaited effect's id, or the awaited
   * run. A worker result of another type than the awaited effect still names its id.
   */
  const eventFor = (
    type: (typeof EVENT_TYPES)[number],
    delivery: FactoryDeliveryState,
  ): FactoryEvent => {
    const { awaiting } = delivery;
    const effectId = awaiting?.type === "effect" ? awaiting.effect.id : LAUNCH;
    const threadId = awaiting?.type === "run" ? awaiting.threadId : author;
    const runId = awaiting?.type === "run" ? awaiting.runId : firstRun;
    switch (type) {
      case "start":
        return start;
      case "thread.launched":
        return launched(effectId);
      case "turn.started":
        return turnStarted(effectId, fixRun);
      case "run.finished":
        return runFinished(runId, "completed", threadId);
      case "thread.deleted":
        return { type, threadId: author };
      case "settle.checked":
        return settleChecked(effectId, settled);
      case "command.finished":
        return commandFinished(effectId, passed);
      case "effect.failed":
        return effectFailed(effectId);
    }
  };

  const pairs = Object.entries(STATES).flatMap(([state, delivery]) =>
    EVENT_TYPES.map((type) => ({
      state,
      type,
      delivery,
      answered: ANSWERED[state as keyof typeof STATES].includes(type),
    })),
  );

  it("cover every listed state and event type", () => {
    expect(pairs).toHaveLength(Object.keys(STATES).length * EVENT_TYPES.length);
  });

  it.each(pairs.filter((pair) => pair.answered))(
    "$state: $type advances the delivery",
    ({ delivery, type }) => {
      expect(advance(delivery, eventFor(type, delivery)).delivery).not.toEqual(delivery);
    },
  );

  it.each(pairs.filter((pair) => !pair.answered))(
    "$state: $type changes nothing",
    ({ delivery, type }) => {
      const result = advance(delivery, eventFor(type, delivery));
      expect(result.delivery).toBe(delivery);
      expect(result.effects).toEqual([]);
    },
  );

  it.each([
    ["a run on another thread", awaitingRun, runFinished(firstRun, "failed", otherThread)],
    ["another run on the author thread", awaitingRun, runFinished(otherRun, "failed")],
    [
      "the earlier run once the fix-commit turn started",
      awaitingFixRun,
      runFinished(firstRun, "failed"),
    ],
    ["a launch report naming an effect not issued", awaitingLaunch, launched(LAUNCH + 1)],
    [
      "the launch's report of run-1 standing in for the fix-commit turn",
      awaitingFixTurn,
      turnStarted(LAUNCH, firstRun),
    ],
    [
      "the first settle check's result while the second is awaited",
      awaitingSecondSettle,
      settleChecked(FIRST_CHECK, settled),
    ],
    [
      "the first settle check's failure while the second is awaited",
      awaitingSecondSettle,
      effectFailed(FIRST_CHECK),
    ],
    [
      "a command result naming another effect",
      awaitingVerify,
      commandFinished(FIRST_CHECK, passed),
    ],
    [
      "a result of another effect type naming the awaited effect",
      awaitingVerify,
      settleChecked(VERIFY, settled),
    ],
    ["another thread's deletion", awaitingRun, { type: "thread.deleted", threadId: otherThread }],
  ] as const)("ignore %s", (_, delivery, event: FactoryEvent) => {
    const result = advance(delivery, event);
    expect(result.delivery).toBe(delivery);
    expect(result.effects).toEqual([]);
  });

  it("let the fix-commit turn's own run through after a stale report of an earlier run", () => {
    expect(
      run(
        awaitingFixTurn,
        turnStarted(LAUNCH, firstRun),
        runFinished(firstRun),
        turnStarted(FIX_TURN, fixRun),
        runFinished(fixRun),
      ).effects,
    ).toEqual([{ id: SECOND_CHECK, type: "check_settle", threadId: author, runId: fixRun }]);
  });

  it("block on the second settle check's failure after ignoring the first's", () => {
    const detail = "The worktree is missing.";
    expect(
      run(awaitingSecondSettle, effectFailed(FIRST_CHECK), effectFailed(SECOND_CHECK, detail)),
    ).toEqual(
      blockedState(awaitingSecondSettle, {
        reason: "effect_failed",
        effect: { id: SECOND_CHECK, type: "check_settle", threadId: author, runId: fixRun },
        detail,
      }),
    );
  });
});

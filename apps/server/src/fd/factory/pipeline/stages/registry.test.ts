import { FactoryStageKind } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { standardStages } from "../definitions.ts";
import { queuedDeliveryState } from "../state.ts";
import { stageHandler } from "./registry.ts";

const delivery = {
  ...queuedDeliveryState({ branch: "fd/item-7", baseRef: "main" }),
  status: "running" as const,
};

describe("stageHandler", () => {
  it("registers the agent, command, gate and PR handlers, and not integrate yet", () => {
    const lookups = FactoryStageKind.literals.map((kind) => [kind, stageHandler(kind)] as const);
    expect(
      lookups.map(([kind, lookup]) => [
        kind,
        lookup.type === "supported" ? lookup.handler.kind : lookup,
      ]),
    ).toEqual([
      ["agent", "agent"],
      ["command", "command"],
      ["gate", "gate"],
      ["integrate", { type: "unsupported", kind: "integrate" }],
      ["pr", "pr"],
    ]);
  });

  it("begins record by recording the approval, and waits for the owner at plan approval", () => {
    const lookup = stageHandler("gate");
    if (lookup.type !== "supported") throw new Error("gate stages are supported");

    const record = { id: 1, type: "record_approval" } as const;
    expect(lookup.handler.begin(delivery, standardStages.record)).toEqual({
      delivery: {
        ...delivery,
        stage: "record",
        effectsIssued: 1,
        awaiting: { type: "effect", effect: record },
      },
      effects: [record],
    });

    // The owner's gate: the delivery waits there and issues nothing.
    expect(lookup.handler.begin(delivery, standardStages.approve_plan)).toEqual({
      delivery: { ...delivery, stage: "approve_plan", status: "waiting", awaiting: null },
      effects: [],
    });
  });

  it("begins an agent stage by launching the stage role's thread", () => {
    const lookup = stageHandler("agent");
    if (lookup.type !== "supported") throw new Error("agent stages are supported");

    const launch = {
      id: 1,
      type: "launch_thread",
      role: "reviewer",
      workspace: { type: "worktree", branch: "fd/item-7", baseRef: "main" },
    } as const;
    expect(lookup.handler.begin(delivery, standardStages.review)).toEqual({
      delivery: {
        ...delivery,
        stage: "review",
        effectsIssued: 1,
        awaiting: { type: "effect", effect: launch },
      },
      effects: [launch],
    });

    const shared = lookup.handler.begin(
      { ...delivery, worktreePath: "/worktrees/item-7" },
      standardStages.author,
    );
    expect(shared.effects).toEqual([
      {
        id: 1,
        type: "launch_thread",
        role: "author",
        workspace: { type: "existing_worktree", worktreePath: "/worktrees/item-7" },
      },
    ]);
  });

  it("begins a command stage by running the stage's command, as a new effect every run", () => {
    const lookup = stageHandler("command");
    if (lookup.type !== "supported") throw new Error("command stages are supported");

    const command = { id: 1, type: "run_command", stage: "verify" } as const;
    const first = lookup.handler.begin(delivery, standardStages.verify);
    expect(first).toEqual({
      delivery: {
        ...delivery,
        stage: "verify",
        effectsIssued: 1,
        awaiting: { type: "effect", effect: command },
      },
      effects: [command],
    });
    const second = lookup.handler.begin(first.delivery, standardStages.verify);
    expect(second.effects).toEqual([{ ...command, id: 2 }]);
  });
});

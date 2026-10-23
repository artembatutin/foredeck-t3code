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
  it("registers the agent and command handlers and nothing else yet", () => {
    const lookups = FactoryStageKind.literals.map((kind) => [kind, stageHandler(kind)] as const);
    expect(
      lookups.map(([kind, lookup]) => [
        kind,
        lookup.type === "supported" ? lookup.handler.kind : lookup,
      ]),
    ).toEqual([
      ["agent", "agent"],
      ["command", "command"],
      ["gate", { type: "unsupported", kind: "gate" }],
      ["integrate", { type: "unsupported", kind: "integrate" }],
      ["pr", { type: "unsupported", kind: "pr" }],
    ]);
  });

  it("begins an agent stage by launching the stage role's thread", () => {
    const lookup = stageHandler("agent");
    if (lookup.type !== "supported") throw new Error("agent stages are supported");

    const fresh = lookup.handler.begin(delivery, standardStages.review);
    expect(fresh).toEqual({
      delivery: { ...delivery, stage: "review", awaiting: { type: "launch", role: "reviewer" } },
      effects: [
        {
          type: "launch_thread",
          role: "reviewer",
          workspace: { type: "worktree", branch: "fd/item-7", baseRef: "main" },
        },
      ],
    });

    const shared = lookup.handler.begin(
      { ...delivery, worktreePath: "/worktrees/item-7" },
      standardStages.author,
    );
    expect(shared.effects).toEqual([
      {
        type: "launch_thread",
        role: "author",
        workspace: { type: "existing_worktree", worktreePath: "/worktrees/item-7" },
      },
    ]);
  });

  it("begins a command stage with a new attempt number on every run", () => {
    const lookup = stageHandler("command");
    if (lookup.type !== "supported") throw new Error("command stages are supported");

    const first = lookup.handler.begin(delivery, standardStages.verify);
    expect(first).toEqual({
      delivery: {
        ...delivery,
        stage: "verify",
        awaiting: { type: "command", attempt: 1 },
        commandRuns: 1,
      },
      effects: [{ type: "run_command", stage: "verify", attempt: 1 }],
    });
    const second = lookup.handler.begin(first.delivery, standardStages.verify);
    expect(second.effects).toEqual([{ type: "run_command", stage: "verify", attempt: 2 }]);
  });
});

import { FactoryRole, FactoryStageKind, FactoryStageName } from "@t3tools/contracts/fd/factory";
import { describe, expect, it } from "vite-plus/test";

import { standardPipeline } from "./definitions.ts";
import type { FactoryStageDefinition } from "./definitions.ts";

const names = (stages: ReadonlyArray<FactoryStageDefinition>) => stages.map((stage) => stage.name);

const everyStage = [
  ...standardPipeline.single,
  ...standardPipeline.parent.beforeChildren,
  ...standardPipeline.parent.perChild,
  ...standardPipeline.parent.afterChildren,
];

describe("the standard pipeline", () => {
  it("runs a single item through author, verify, review, record, pr and follow-through", () => {
    expect(standardPipeline.id).toBe("standard");
    expect(names(standardPipeline.single)).toEqual([
      "author",
      "verify",
      "review",
      "record",
      "pr",
      "follow_through",
    ]);
  });

  it("plans and approves a parent, runs each child's stages, then integrates and opens one PR", () => {
    const { beforeChildren, perChild, afterChildren } = standardPipeline.parent;
    expect(names(beforeChildren)).toEqual(["plan", "approve_plan"]);
    expect(names(perChild)).toEqual(["author", "verify", "review", "record"]);
    expect(names(afterChildren)).toEqual(["integrate", "pr", "follow_through"]);
  });

  it("uses only contract stage names and kinds", () => {
    for (const stage of everyStage) {
      expect(FactoryStageName.literals).toContain(stage.name);
      expect(FactoryStageKind.literals).toContain(stage.kind);
    }
  });

  it("gives each stage one kind, and a role to every stage that runs a thread", () => {
    const byName = new Map(everyStage.map((stage) => [stage.name, stage]));
    expect(Object.fromEntries(byName)).toEqual({
      plan: { name: "plan", kind: "agent", role: "planner" },
      approve_plan: { name: "approve_plan", kind: "gate" },
      author: { name: "author", kind: "agent", role: "author" },
      verify: { name: "verify", kind: "command" },
      review: { name: "review", kind: "agent", role: "reviewer" },
      record: { name: "record", kind: "gate" },
      integrate: { name: "integrate", kind: "integrate", role: "reviewer" },
      pr: { name: "pr", kind: "pr" },
      follow_through: { name: "follow_through", kind: "pr" },
    });
    for (const stage of everyStage) {
      expect(byName.get(stage.name)).toEqual(stage);
      if (stage.kind === "agent") expect(FactoryRole.literals).toContain(stage.role);
    }
  });

  it("is plain data that survives serialization unchanged", () => {
    expect(JSON.parse(JSON.stringify(standardPipeline))).toEqual(standardPipeline);
    expect(structuredClone(standardPipeline)).toEqual(standardPipeline);
  });
});

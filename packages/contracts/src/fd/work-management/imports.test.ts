import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * `environment.ts` imports this feature's index for the capability, `project.ts` imports
 * `environment.ts` and `orchestrationV2.ts` imports `project.ts`. A Work contract importing
 * any of those closes an ESM cycle that fails at module load, so the modules are loaded fresh
 * in both orders here; a cycle surfaces as a temporal-dead-zone error in one of them.
 */
describe("work-management contracts import graph", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("loads with environment first", async () => {
    const environment = await import("../../environment.ts");
    const work = await import("./index.ts");
    const orchestration = await import("../../orchestrationV2.ts");
    expect(environment.ExecutionEnvironmentCapabilities).toBeDefined();
    expect(work.WorkRpcs.length).toBeGreaterThan(0);
    expect(orchestration.OrchestrationV2ThreadLaunchInput).toBeDefined();
  });

  it("loads with orchestration first", async () => {
    const orchestration = await import("../../orchestrationV2.ts");
    const work = await import("./index.ts");
    const environment = await import("../../environment.ts");
    expect(orchestration.OrchestrationV2ThreadLaunchInput).toBeDefined();
    expect(work.WorkRpcs.length).toBeGreaterThan(0);
    expect(environment.ExecutionEnvironmentCapabilities).toBeDefined();
  });

  it("loads with the Work contracts first", async () => {
    const work = await import("./index.ts");
    const rpc = await import("../../rpc.ts");
    expect(work.WorkRpcs.length).toBeGreaterThan(0);
    expect(rpc.WS_METHODS.workItemsList).toBe("work.items.list");
  });
});

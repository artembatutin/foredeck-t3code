/// <reference types="vite-plus/client" />
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

/**
 * Core contract modules import fd entries: `environment.ts` imports Work's, `project.ts` imports
 * `environment.ts` and `orchestrationV2.ts` imports `project.ts`. Factory imports the Work entry,
 * so a Factory contract importing any of those (or the root barrel, which re-exports them) can
 * close an ESM cycle that fails at module load. The sources are scanned for such imports, and the
 * modules are loaded fresh in several orders; a cycle surfaces as a temporal-dead-zone error.
 */
const sources = import.meta.glob<string>(["./*.ts", "!./*.test.ts"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const FORBIDDEN = [
  /(?:^|\/)orchestrationV2(?:\.ts)?$/,
  /(?:^|\/)project(?:\.ts)?$/,
  /(?:^|\/)environment(?:\.ts)?$/,
  /^@t3tools\/contracts$/,
  /^\.\.\/\.\.\/index(?:\.ts)?$/,
];

const SPECIFIER = /\b(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

const importSpecifiers = (source: string) =>
  Array.from(source.matchAll(SPECIFIER), (match) => match[1] ?? "");

const forbiddenImports = (source: string) =>
  importSpecifiers(source).filter((specifier) =>
    FORBIDDEN.some((pattern) => pattern.test(specifier)),
  );

describe("factory contracts imports", () => {
  it("scans every Factory source file", () => {
    expect(Object.keys(sources)).toEqual(expect.arrayContaining(["./index.ts", "./schemas.ts"]));
    expect(importSpecifiers(sources["./schemas.ts"] ?? "")).toContain(
      "../work-management/index.ts",
    );
  });

  it.each([
    'import { ProjectId } from "../../project.ts";',
    'import type { ExecutionEnvironmentCapabilities } from "../../environment.ts";',
    'export { OrchestrationV2ThreadLaunchInput } from "../../orchestrationV2.ts";',
    'const environment = await import("../../environment.ts");',
    'import "../../project";',
    'import { ProjectId } from "@t3tools/contracts";',
    'import { ProjectId } from "../../index.ts";',
  ])("flags %s", (source) => {
    expect(forbiddenImports(source)).toHaveLength(1);
  });

  it.each([
    'import { WorkItemRef } from "../work-management/index.ts";',
    'import { ProjectId } from "../../baseSchemas.ts";',
    'import { OrchestrationProjectShell } from "../../orchestrationProject.ts";',
    'import { WorkItemRef } from "@t3tools/contracts/fd/work-management";',
  ])("allows %s", (source) => {
    expect(forbiddenImports(source)).toEqual([]);
  });

  it("finds none in the Factory sources", () => {
    const offenders = Object.entries(sources).flatMap(([file, source]) =>
      forbiddenImports(source).map((specifier) => `${file} imports ${specifier}`),
    );
    expect(offenders).toEqual([]);
  });
});

describe("factory contracts load order", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("loads with environment first", async () => {
    const environment = await import("../../environment.ts");
    const factory = await import("./index.ts");
    const orchestration = await import("../../orchestrationV2.ts");
    expect(environment.ExecutionEnvironmentCapabilities).toBeDefined();
    expect(factory.FactoryDeliveryStatus.literals).toContain("queued");
    expect(orchestration.OrchestrationV2ThreadLaunchInput).toBeDefined();
  });

  it("loads with orchestration first", async () => {
    const orchestration = await import("../../orchestrationV2.ts");
    const factory = await import("./index.ts");
    const environment = await import("../../environment.ts");
    expect(orchestration.OrchestrationV2ThreadLaunchInput).toBeDefined();
    expect(factory.FactoryDeliveryStatus.literals).toContain("queued");
    expect(environment.ExecutionEnvironmentCapabilities).toBeDefined();
  });

  it("loads with the Factory contracts first", async () => {
    const factory = await import("./index.ts");
    const environment = await import("../../environment.ts");
    const rpc = await import("../../rpc.ts");
    expect(factory.FactoryDeliveryStatus.literals).toContain("queued");
    expect(environment.ExecutionEnvironmentCapabilities).toBeDefined();
    expect(rpc.WS_METHODS.workItemsList).toBe("work.items.list");
  });

  it("stays out of the root contracts barrel", async () => {
    const root = await import("../../index.ts");
    const factory = await import("./index.ts");
    expect(Object.keys(factory).filter((name) => name in root)).toEqual([]);
  });
});

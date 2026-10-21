import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ExecutionEnvironmentCapabilities,
  ExecutionEnvironmentDescriptor,
} from "../../environment.ts";
import {
  WORK_MANAGEMENT_CAPABILITY,
  workManagementCapability,
  workManagementSupport,
} from "./index.ts";

const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
const encodeCapabilities = Schema.encodeSync(ExecutionEnvironmentCapabilities);
const descriptor = {
  environmentId: "environment-1",
  label: "Local",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "0.0.45",
  capabilities: { repositoryIdentity: true, pullRequests: true },
} as const;
const withWork = (workManagement: unknown) =>
  decodeDescriptor({
    ...descriptor,
    capabilities: { ...descriptor.capabilities, workManagement },
  }).capabilities;

describe("workManagementSupport", () => {
  it("leaves descriptors without Work unchanged and unsupported", () => {
    const capabilities = decodeDescriptor(descriptor).capabilities;
    expect(capabilities).toEqual({ repositoryIdentity: true, pullRequests: true });
    expect("workManagement" in capabilities).toBe(false);
    expect(workManagementSupport(capabilities)).toBeUndefined();
  });

  it.each([
    { version: 2, sourceKinds: ["markdown"], features: ["sources"] },
    { version: 0, sourceKinds: ["markdown"], features: ["sources"] },
    { version: "1", sourceKinds: ["markdown"], features: [] },
    { version: 1, sourceKinds: "markdown", features: [] },
    { version: 1 },
    true,
  ])("treats %j as unsupported without failing the descriptor", (workManagement) => {
    const capabilities = withWork(workManagement);
    expect(capabilities.pullRequests).toBe(true);
    expect(workManagementSupport(capabilities)).toBeUndefined();
  });

  it("reports version 1 Markdown support for exactly the listed features", () => {
    const support = workManagementSupport(
      withWork({ version: 1, sourceKinds: ["markdown"], features: ["sources", "links"] }),
    );
    expect(support?.sourceKinds).toEqual(new Set(["markdown"]));
    expect(support?.features).toEqual(new Set(["sources", "links"]));
    expect(support?.features.has("items.write")).toBe(false);
  });

  it("drops source kinds and features from a newer server", () => {
    const support = workManagementSupport(
      withWork({ version: 1, sourceKinds: ["markdown", "linear"], features: ["sources", "plans"] }),
    );
    expect(support?.sourceKinds).toEqual(new Set(["markdown"]));
    expect(support?.features).toEqual(new Set(["sources"]));
  });

  it("encodes an advertised capability unchanged", () => {
    const workManagement = workManagementCapability({
      sourceKinds: ["markdown"],
      features: ["sources", "links"],
    });
    expect(workManagement.version).toBe(1);
    expect(encodeCapabilities(withWork(workManagement)).workManagement).toEqual(workManagement);
  });

  it("advertises only the shipped source kinds and features", () => {
    expect(WORK_MANAGEMENT_CAPABILITY.version).toBe(1);
    expect(WORK_MANAGEMENT_CAPABILITY.sourceKinds).toEqual(["markdown"]);
    const support = workManagementSupport(withWork(WORK_MANAGEMENT_CAPABILITY));
    expect(support?.features).toEqual(
      new Set(["sources", "items.write", "comments", "links", "people"]),
    );
    // The handler refuses thread starts until the execution phase lands.
    expect(support?.features.has("threads.start")).toBe(false);
  });
});

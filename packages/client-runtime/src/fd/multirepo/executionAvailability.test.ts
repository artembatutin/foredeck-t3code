import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type RuntimeMode } from "@t3tools/contracts";
import { repositoryExecutionBlockReason } from "./executionAvailability.ts";

const provider = {
  driver: ProviderDriverKind.make("supported"),
  multiRepository: { runtimeModes: ["approval-required"] as readonly RuntimeMode[] },
};
const input = {
  isMultiRepository: true,
  serverProtocolVersion: 1,
  provider,
  runtimeMode: "approval-required" as const,
};
describe("multi-repository execution availability", () => {
  it("requires both server support and the selected adapter's exact permission mode", () => {
    expect(repositoryExecutionBlockReason(input)).toBeNull();
    expect(
      repositoryExecutionBlockReason({ ...input, serverProtocolVersion: undefined }),
    ).toContain("Update this server");
    expect(repositoryExecutionBlockReason({ ...input, runtimeMode: "full-access" })).toContain(
      "permission mode",
    );
    expect(
      repositoryExecutionBlockReason({
        ...input,
        provider: { driver: ProviderDriverKind.make("unsupported") },
      }),
    ).toContain("unsupported cannot");
    expect(repositoryExecutionBlockReason({ ...input, provider: null })).toContain(
      "selected provider",
    );
  });
  it("preserves single-repository behavior even on older servers or providers", () => {
    expect(
      repositoryExecutionBlockReason({
        ...input,
        isMultiRepository: false,
        serverProtocolVersion: undefined,
        provider: null,
      }),
    ).toBeNull();
  });
});

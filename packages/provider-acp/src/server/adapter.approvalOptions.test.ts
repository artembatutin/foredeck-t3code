import { describe, expect, it } from "vite-plus/test";
import type * as EffectAcpSchema from "effect-acp/compat";

import { acpNativeApprovalOptions, acpPermissionAnswer } from "./adapter.ts";

const request = (
  ...options: ReadonlyArray<{
    readonly kind: EffectAcpSchema.PermissionOption["kind"];
    readonly name?: string;
  }>
) =>
  ({
    sessionId: "session",
    toolCall: { toolCallId: "tool", kind: "execute" },
    options: options.map(({ kind, name }) => ({
      kind,
      optionId: `option-${kind}`,
      name: name ?? kind,
    })),
  }) as unknown as EffectAcpSchema.RequestPermissionRequest;

describe("what an ACP agent's permission request offers", () => {
  it("offers no longer-lasting choice to an agent that offers none", () => {
    expect(
      acpNativeApprovalOptions(request({ kind: "allow_once" }, { kind: "reject_once" })),
    ).toEqual([
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });

  it("offers an agent's always under its own name, never as a session choice", () => {
    const options = acpNativeApprovalOptions(
      request(
        { kind: "allow_once" },
        { kind: "allow_always", name: " Allow for this project " },
        { kind: "reject_once" },
      ),
    );
    expect(options).toContainEqual({ decision: "acceptAlways", label: "Allow for this project" });
    expect(options.map(({ decision }) => decision)).not.toContain("acceptForSession");
  });

  it("offers neither an approve nor a decline the agent has no option to answer", () => {
    expect(acpNativeApprovalOptions(request({ kind: "allow_always" }))).toEqual([
      { decision: "cancel", label: "Cancel" },
      { decision: "acceptAlways", label: "allow_always" },
    ]);
    expect(acpNativeApprovalOptions(request())).toEqual([{ decision: "cancel", label: "Cancel" }]);
  });
});

describe("how a decision answers an ACP agent", () => {
  const onceOnly = request({ kind: "allow_once" }, { kind: "reject_once" });

  it("grants nothing for a session choice the agent has no option to answer", () => {
    expect(acpPermissionAnswer(onceOnly, "acceptForSession")).toEqual({
      response: { outcome: { outcome: "cancelled" } },
      grant: null,
    });
    expect(acpPermissionAnswer(onceOnly, "acceptAlways").grant).toBeNull();
  });

  it("grants nothing for an approve the agent has no option to answer", () => {
    expect(acpPermissionAnswer(request({ kind: "reject_once" }), "accept")).toEqual({
      response: { outcome: { outcome: "cancelled" } },
      grant: null,
    });
  });

  it("selects the option it offered, and grants what that choice covers", () => {
    expect(acpPermissionAnswer(onceOnly, "accept")).toEqual({
      response: { outcome: { outcome: "selected", optionId: "option-allow_once" } },
      grant: "turn",
    });
    const always = request({ kind: "allow_always" });
    expect(acpPermissionAnswer(always, "acceptAlways")).toEqual({
      response: { outcome: { outcome: "selected", optionId: "option-allow_always" } },
      grant: "session",
    });
  });

  it("grants nothing for a decline or a cancel", () => {
    expect(acpPermissionAnswer(onceOnly, "decline").grant).toBeNull();
    expect(acpPermissionAnswer(onceOnly, "cancel")).toEqual({
      response: { outcome: { outcome: "cancelled" } },
      grant: null,
    });
  });
});

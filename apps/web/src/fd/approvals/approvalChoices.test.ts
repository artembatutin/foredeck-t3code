import { CLIENT_GUARDED_RPC_SCOPES, ProviderApprovalDecision } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { approvalChoiceNote, approvalChoices } from "./pendingActions";

describe("how long an approval's choices last", () => {
  it("states when the session choice ends, and that nothing longer exists here", () => {
    const note = approvalChoiceNote([
      { decision: "accept", label: "Approve" },
      { decision: "acceptForSession", label: "Allow this session" },
    ]);
    expect(note).toContain("Approving covers this one action.");
    expect(note).toContain("ends with it, such as when the provider or server restarts");
    expect(note).toContain("Foredeck has no project or delivery grant.");
  });

  it("explains one-time approval is all there is where nothing else exists", () => {
    expect(approvalChoiceNote([{ decision: "accept", label: "Approve" }])).toBe(
      "Approving covers this one action. Nothing longer is offered here. Foredeck has no project or delivery grant.",
    );
  });

  it("says a remembered choice is the provider's, not Foredeck's", () => {
    expect(
      approvalChoiceNote([
        { decision: "accept", label: "Approve" },
        { decision: "acceptAlways", label: "Always allow" },
      ]),
    ).toContain("kept by the provider under its own rules");
  });
});

describe("a request that lists no choices", () => {
  it("offers only what every provider can answer, on every client", () => {
    expect(approvalChoices(undefined).map(({ decision }) => decision)).toEqual([
      "cancel",
      "decline",
      "accept",
    ]);
  });

  it("offers exactly what a request lists, even if that is less", () => {
    const listed = [{ decision: "decline", label: "Deny" }] as const;
    expect(approvalChoices(listed)).toBe(listed);
  });

  it("says nothing longer is on offer", () => {
    expect(approvalChoiceNote(approvalChoices(undefined))).toContain("Nothing longer is offered");
  });
});

describe("what approval decisions and methods exist", () => {
  it("adds no project or delivery grant to a decision", () => {
    expect(ProviderApprovalDecision.literals).toEqual([
      "accept",
      "acceptForSession",
      "acceptAlways",
      "decline",
      "cancel",
    ]);
  });

  it("adds no grant or revoke method to the guarded client methods", () => {
    const named = Object.keys(CLIENT_GUARDED_RPC_SCOPES).filter((method) =>
      /approval.*(grant|revoke)|(grant|revoke).*approval|(project|delivery).*(grant|revoke)|(grant|revoke).*(project|delivery)/i.test(
        method,
      ),
    );
    expect(named).toEqual([]);
  });
});

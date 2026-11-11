import { describe, expect, it } from "vite-plus/test";

import {
  reviewDraftChanged,
  reviewDraftOf,
  reviewEditable,
  reviewEdited,
  reviewEditingAfter,
  reviewEditingOf,
  reviewEditOvertaken,
  reviewFreezeNote,
  reviewLimitFacts,
  reviewOverrideFact,
  reviewPatchOf,
  REVIEW_PROVIDER_NOTE,
  reviewRoleFact,
  reviewSaveInput,
  reviewStartAvailability,
} from "./reviewCard";

const snapshot = {
  title: { text: "Add the export", origin: "derived" as const },
  goal: "Add the export",
  acceptanceCriteria: ["Exports CSV", "Has a test"],
  constraints: ["No new dependencies"],
  decisions: [],
};

describe("the review draft", () => {
  it("offers only a title the owner set, and changes nothing until it is edited", () => {
    const draft = reviewDraftOf(snapshot);
    expect(draft.title).toBe("");
    expect(reviewDraftChanged(draft, snapshot)).toBe(false);
    expect(reviewPatchOf(draft, snapshot)).toEqual({});
    expect(reviewDraftOf({ ...snapshot, title: { text: "Set", origin: "explicit" } }).title).toBe(
      "Set",
    );
  });

  it("sends only what changed, with its lists tidied", () => {
    const patch = reviewPatchOf(
      {
        ...reviewDraftOf(snapshot),
        title: "  CSV export ",
        constraints: ["No new dependencies", "", "  Keep it small  "],
      },
      snapshot,
    );
    expect(patch).toEqual({
      title: "CSV export",
      constraints: ["No new dependencies", "Keep it small"],
    });
  });

  it("does not count tidying alone as an edit", () => {
    const draft = {
      ...reviewDraftOf(snapshot),
      acceptanceCriteria: [" Exports CSV ", "", "Has a test"],
    };
    expect(reviewDraftChanged(draft, snapshot)).toBe(false);
  });

  describe("of entries that run over several lines", () => {
    const multiline = {
      ...snapshot,
      acceptanceCriteria: ["Exports CSV\n\nwith a header row", "Has a test"],
      constraints: ["No new dependencies\nNot even for tests"],
      decisions: ["Use the toolbar\n- left of Share"],
    };

    it("leaves them untouched, and nothing reads as edited", () => {
      const draft = reviewDraftOf(multiline);
      expect(draft.acceptanceCriteria).toEqual(multiline.acceptanceCriteria);
      expect(reviewDraftChanged(draft, multiline)).toBe(false);
      expect(reviewPatchOf(draft, multiline)).toEqual({});
    });

    it("keeps an edit of one field from restating another", () => {
      const patch = reviewPatchOf({ ...reviewDraftOf(multiline), goal: "Add it" }, multiline);
      expect(patch).toEqual({ goal: "Add it" });
    });

    it("keeps each entry whole when a neighbour changes, numbering included", () => {
      const patch = reviewPatchOf(
        {
          ...reviewDraftOf(multiline),
          acceptanceCriteria: ["Exports CSV\n\nwith a header row", "Has two tests"],
        },
        multiline,
      );
      expect(patch).toEqual({
        acceptanceCriteria: ["Exports CSV\n\nwith a header row", "Has two tests"],
      });
    });

    it("drops only an entry the owner emptied, and adds only one they wrote", () => {
      const removed = reviewPatchOf(
        {
          ...reviewDraftOf(multiline),
          acceptanceCriteria: ["", "Has a test"],
        },
        multiline,
      );
      expect(removed).toEqual({ acceptanceCriteria: ["Has a test"] });
      const added = reviewPatchOf(
        {
          ...reviewDraftOf(multiline),
          constraints: [...multiline.constraints, "Keep it small"],
        },
        multiline,
      );
      expect(added).toEqual({
        constraints: ["No new dependencies\nNot even for tests", "Keep it small"],
      });
    });
  });

  it("is not editable when the review could not show it whole", () => {
    expect(reviewEditable({ permitted: true, briefTruncated: false })).toBe(true);
    expect(reviewEditable({ permitted: true, briefTruncated: true })).toBe(false);
    expect(reviewEditable({ permitted: false, briefTruncated: false })).toBe(false);
  });
});

describe("a draft across a newer snapshot", () => {
  const stored = {
    ...snapshot,
    projectId: "project" as never,
    ideaId: "idea",
    briefRevision: 1,
  };
  const corrected = {
    ...stored,
    briefRevision: 2,
    goal: "Add the export, corrected",
    decisions: ["Someone else decided this"],
  };

  it("follows it while its owner has typed nothing", () => {
    const next = reviewEditingAfter(reviewEditingOf(stored), corrected);
    expect(reviewEdited(next)).toBe(false);
    expect(next.draft.goal).toBe("Add the export, corrected");
    expect(next.base.briefRevision).toBe(2);
    expect(reviewEditOvertaken(next, corrected)).toBe(false);
  });

  it("stays on what it was edited from, so its save is refused rather than undoing a correction", () => {
    const typed = {
      ...reviewEditingOf(stored),
      draft: { ...reviewDraftOf(stored), constraints: ["Keep it small"] },
    };
    const next = reviewEditingAfter(typed, corrected);
    expect(next).toBe(typed);
    expect(reviewEditOvertaken(next, corrected)).toBe(true);
    // Only what its owner changed, against the revision they changed it from.
    expect(reviewSaveInput(next)).toEqual({
      projectId: "project",
      ideaId: "idea",
      expectedRevision: 1,
      patch: { constraints: ["Keep it small"] },
    });
  });

  it("is not overtaken by a snapshot of its own revision", () => {
    const typed = {
      ...reviewEditingOf(stored),
      draft: { ...reviewDraftOf(stored), goal: "Add it" },
    };
    expect(reviewEditOvertaken(typed, stored)).toBe(false);
  });
});

describe("whether a start is available", () => {
  const start = (mode: "new_attempt" | "amend" | "none", messages: ReadonlyArray<string> = []) => ({
    start: { mode, blockers: messages.map((message) => ({ code: "any", message })) },
  });

  it("is, once nothing stands in the way", () => {
    expect(
      reviewStartAvailability(start("new_attempt"), { permitted: true, edited: false }),
    ).toEqual({
      canStart: true,
      reasons: [],
      blockers: [],
      label: "Review and start",
      action: "Start delivery",
    });
    expect(reviewStartAvailability(start("amend"), { permitted: true, edited: false }).label).toBe(
      "Review and resume",
    );
  });

  it("says every reason it is not, the server's first", () => {
    const availability = reviewStartAvailability(start("none", ["No verify command."]), {
      permitted: false,
      edited: true,
    });
    expect(availability.canStart).toBe(false);
    expect(availability.reasons[0]).toBe("No verify command.");
    expect(availability.reasons[1]).toContain("permission");
    expect(availability.reasons[2]).toContain("Save or discard");
  });

  it("is not while an edit is unsaved or the connection lacks the grant", () => {
    const allowed = start("new_attempt");
    expect(reviewStartAvailability(allowed, { permitted: true, edited: true }).canStart).toBe(
      false,
    );
    expect(reviewStartAvailability(allowed, { permitted: false, edited: false }).canStart).toBe(
      false,
    );
  });

  it("never claims the settings are frozen before a start", () => {
    expect(reviewFreezeNote("new_attempt")).toContain("can still change");
    expect(reviewFreezeNote("none")).toContain("Only starting fixes them");
    expect(reviewFreezeNote("amend")).toContain("keeps counting");
  });
});

describe("what the review shows of its settings", () => {
  const role = {
    instanceId: "codex" as never,
    model: "model-a",
    offered: true,
    options: [
      { id: "effort", value: "high", supported: true },
      { id: "tier", value: "priority", supported: false },
    ],
    optionsOmitted: 0,
    acknowledgement: "not_reported" as const,
  };

  it("flags what a model does not support and never claims a provider confirmed it", () => {
    const { label, value } = reviewRoleFact("Author", role);
    expect(label).toBe("Author");
    expect(value).toContain("model-a");
    expect(value).toContain("effort: high");
    expect(value).toContain("tier: priority (not supported)");
    expect(REVIEW_PROVIDER_NOTE).toContain("Provider confirmation: not reported");
    expect(reviewRoleFact("Author", { ...role, offered: false }).value).toContain("(not offered)");
    expect(reviewRoleFact("Author", { ...role, optionsOmitted: 3 }).value).toContain(
      "… and 3 more",
    );
  });

  it("labels the timeout per command and says total time is not limited", () => {
    const facts = new Map(
      reviewLimitFacts({
        verifyCommand: { executable: "npm", args: ["test"] },
        setupCommand: null,
        blockingSeverities: [],
        highRiskEffort: "xhigh",
        limits: {
          maxFixRounds: 3,
          maxReviewRounds: 2,
          maxFixCommitTurns: null,
          verifyTimeoutMinutes: 30,
          verifyTimeoutScope: "per_command",
          totalTime: "unsupported",
        },
      }).map((fact) => [fact.label, fact.value]),
    );
    expect(facts.get("Verify command")).toBe("npm test");
    expect(facts.get("Setup command")).toBe("None");
    expect(facts.get("Fix rounds")).toBe("Up to 3");
    expect(facts.get("Verify timeout")).toBe("30 minutes per command");
    expect(facts.get("Total time")).toBe("Not limited");
    expect(facts.get("Blocking severities")).toBe("None");
    expect(facts.has("Fix-commit turns")).toBe(false);
  });

  it("names the overrides that exist, and says so when they could not be read", () => {
    expect(
      reviewOverrideFact([
        { prompt: "plan", state: "absent" },
        { prompt: "author", state: "present" },
      ]).value,
    ).toBe("author");
    expect(reviewOverrideFact([{ prompt: "plan", state: "absent" }]).value).toBe("None");
    expect(reviewOverrideFact([{ prompt: "plan", state: "unknown" }]).value).toContain("Could not");
  });

  it("keeps the owner's own unsaved draft out of what blocks a start for everyone", () => {
    const availability = reviewStartAvailability(
      { start: { mode: "amend", blockers: [{ code: "any", message: "No verify command." }] } },
      { permitted: true, edited: true },
    );
    expect(availability.blockers).toEqual(["No verify command."]);
    expect(availability.reasons).toHaveLength(2);
    expect(availability.action).toBe("Resume delivery");
  });
});

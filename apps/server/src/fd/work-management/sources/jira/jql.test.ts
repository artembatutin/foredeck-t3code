import { describe, expect, it } from "@effect/vitest";
import { WorkSourceId } from "@t3tools/contracts/fd/work-management";

import { jqlString, keysJql, listJql, normalizeIssueKey } from "./jql.ts";

const sourceId = WorkSourceId.make("6f9b1c2e-3d4a-4b5c-8d6e-7f8091a2b3c4");

describe("JQL", () => {
  it("escapes string literals", () => {
    expect(jqlString('say "hi" \\ now\nplease')).toBe('"say \\"hi\\" \\\\ now please"');
  });

  it("builds a filtered, stably ordered project search", () => {
    expect(
      listJql("PROJ", {
        sourceId,
        limit: 50,
        statuses: ["todo", "in_progress", "cancelled", "done"],
        assignee: "me",
        labels: ["a b"],
        search: 'crash "x"',
      }),
    ).toBe(
      'project = "PROJ" AND statusCategory in (2, 4, 3) AND assignee = currentUser() AND labels in ("a b") AND text ~ "crash \\"x\\"" ORDER BY updated DESC, key DESC',
    );
    expect(listJql("PROJ", { sourceId, limit: 50 })).toBe(
      'project = "PROJ" ORDER BY updated DESC, key DESC',
    );
  });

  it("upper-cases issue keys", () => {
    expect(normalizeIssueKey(" proj-12 ")).toBe("PROJ-12");
    expect(keysJql(["proj-1", "PROJ-2"])).toBe('key in ("PROJ-1", "PROJ-2")');
  });
});

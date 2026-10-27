import { WorkItemId, WorkSourceId } from "@t3tools/contracts/fd/work-management";
import { describe, expect, it } from "vite-plus/test";

import { renderAuthorPrompt } from "./author.ts";

describe("renderAuthorPrompt", () => {
  it("requires self-review, server-owned full verification and stops for credentials or owner decisions", () => {
    const prompt = renderAuthorPrompt({
      item: {
        ref: {
          sourceId: WorkSourceId.make("7e2aa85e-9347-44ce-b019-cb8dfd365b20"),
          itemId: WorkItemId.make("export"),
        },
        key: "export",
        title: "Export rows",
        body: "Export the visible rows.",
        bodyTruncated: false,
        url: null,
      },
      branch: "feature/export",
    });

    expect(prompt).toContain("Review your own diff before you commit.");
    expect(prompt).toContain(
      "Run focused checks while you work. The server runs the project's full verification after you finish.",
    );
    expect(prompt).toContain(
      "Stop and say so when you need credentials you do not have or a decision only the owner can make.",
    );
  });
});

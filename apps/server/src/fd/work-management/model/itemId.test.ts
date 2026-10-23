import { assert, describe, it } from "@effect/vitest";
import { WorkItemId } from "@t3tools/contracts/fd/work-management";

import { canonicalItemId } from "./itemId.ts";

const id = WorkItemId.make;

describe("canonicalItemId", () => {
  it("strips leading zeros from GitHub numbers and keeps other spellings as they are", () => {
    assert.strictEqual(canonicalItemId("github", id("01")), "1");
    assert.strictEqual(canonicalItemId("github", id("0")), "0");
    // Not issue numbers: the adapter refuses them, so they never alias issue 1.
    for (const spelling of ["1e0", "0x1", "1.0"]) {
      assert.strictEqual(canonicalItemId("github", id(spelling)), spelling);
    }
  });

  it("upper-cases Jira keys and leaves Markdown ids alone", () => {
    assert.strictEqual(canonicalItemId("jira", id("proj-12")), "PROJ-12");
    assert.strictEqual(canonicalItemId("markdown", id("fd-abc123")), "fd-abc123");
  });
});

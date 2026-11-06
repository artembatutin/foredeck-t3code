import { assert, it } from "@effect/vitest";

import { assistantToolRefusal } from "./toolPolicy.ts";

const call = (name: string) => ({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name, arguments: { item: "fd-7k3qa2" } },
});

it("refuses factory_deliver on an assistant thread as it refuses work_start_thread", () => {
  const refusal = assistantToolRefusal("fd-assistant-owner", call("factory_deliver"));
  assert.isDefined(refusal);
  assert.strictEqual(refusal?.id, 3);
  assert.isTrue(refusal?.result.isError);
  assert.deepStrictEqual(
    refusal?.result,
    assistantToolRefusal("fd-assistant-owner", call("work_start_thread"))?.result,
  );
  // Only the project assistant's own threads go through the queue.
  assert.isUndefined(assistantToolRefusal("ordinary-worker", call("factory_deliver")));
  assert.isUndefined(assistantToolRefusal(undefined, call("factory_deliver")));
});

it("lets an assistant thread read deliveries with factory_status", () => {
  assert.isUndefined(assistantToolRefusal("fd-assistant-owner", call("factory_status")));
});

it("keeps factory_deliver and work_start_thread refused beside the capture tools, which point at capture", () => {
  for (const name of ["factory_deliver", "work_start_thread"]) {
    const refusal = assistantToolRefusal("fd-assistant-owner", call(name));
    assert.isTrue(refusal?.result.isError);
    assert.include(refusal?.result.content[0]?.text ?? "", "assistant_capture_work");
  }
  for (const name of ["assistant_capture_work", "assistant_abandon_capture"]) {
    assert.isUndefined(assistantToolRefusal("fd-assistant-owner", call(name)));
  }
});

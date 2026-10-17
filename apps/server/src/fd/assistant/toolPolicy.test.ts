import { assert, it } from "@effect/vitest";
import { assistantToolRefusal } from "./toolPolicy.ts";
it("routes manager worker mutations through the queue without restricting ordinary project agents", () => {
  for (const name of [
    "t3_thread_launch",
    "create_threads",
    "delegate_task",
    "schedule_task",
    "run_scheduled_task_now",
    "t3_thread_send",
    "t3_thread_send_attachments",
    "t3_pending_request_respond",
    "t3_thread_interrupt",
  ]) {
    const request = {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name, arguments: {} },
    };
    assert.equal(assistantToolRefusal("fd-assistant-owner", request)?.id, 7);
    assert.isUndefined(assistantToolRefusal("ordinary-worker", request));
    assert.isUndefined(assistantToolRefusal(undefined, request));
  }
  for (const name of [
    "assistant_assign",
    "assistant_answer",
    "assistant_control",
    "assistant_portfolio",
    "t3_thread_read",
    "t3_pending_request_read",
    "t3_project_list",
  ]) {
    assert.isUndefined(
      assistantToolRefusal("fd-assistant-owner", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name },
      }),
    );
  }
});

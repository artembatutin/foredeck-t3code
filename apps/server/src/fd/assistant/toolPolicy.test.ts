import { assert, it } from "@effect/vitest";
import { assistantInstructionsForThread } from "./index.ts";
import { AssistantToolkit } from "./tools.ts";
import { assistantToolRefusal } from "./toolPolicy.ts";

it("tells an agent which words are scope and that authorization is only authorization", () => {
  const revise = AssistantToolkit.tools.assistant_revise_brief.description ?? "";
  assert.include(revise, "durable scope");
  assert.include(revise, "conversationNotes");
  assert.include(revise, "never reach the Work item, the worker or the scope");
  assert.include(revise, "Record authorization only as executionAuthorized");
  const capture = AssistantToolkit.tools.assistant_capture_work.description ?? "";
  assert.include(capture, "never its conversation notes");
  assert.include(capture, "at most 80 characters");
  assert.include(capture, "keeps its title");
  const role = assistantInstructionsForThread("fd-assistant-owner") ?? "";
  assert.include(role, "conversationNotes");
  assert.include(role, "never as a decision or constraint");
  // The owner's start is theirs: no tool of the assistant's reaches it.
  assert.isFalse(Object.keys(AssistantToolkit.tools).some((name) => name.includes("authoriz")));
  assert.isFalse(Object.keys(AssistantToolkit.tools).some((name) => name.includes("review")));
});
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
    "work_start_thread",
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
    "assistant_capture_work",
    "assistant_abandon_capture",
    "t3_thread_read",
    "t3_pending_request_read",
    "t3_project_list",
    "work_read",
    "work_update",
    "work_comment",
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

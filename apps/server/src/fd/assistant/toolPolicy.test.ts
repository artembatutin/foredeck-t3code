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
    "update_scheduled_task",
    "run_scheduled_task_now",
    "t3_thread_send",
    "t3_thread_send_attachments",
    "t3_pending_request_respond",
    "t3_thread_interrupt",
    "t3_thread_configure",
    "t3_thread_fork",
    "t3_thread_merge_back",
    "t3_worktree_handoff",
    "t3_queue_edit",
    "t3_queue_promote_to_steer",
    "watch_pull_request",
    "work_start_thread",
    // A tool nobody classified yet is refused rather than reached by falling through.
    "some_tool_published_later",
  ]) {
    assert.isDefined(assistantToolRefusal("fd-assistant-owner", [{ tool: name }]), name);
    assert.isUndefined(assistantToolRefusal("ordinary-worker", [{ tool: name }]));
    assert.isUndefined(assistantToolRefusal(undefined, [{ tool: name }]));
  }
  for (const name of [
    ...Object.keys(AssistantToolkit.tools),
    "t3_thread_read",
    "t3_pending_request_read",
    "t3_project_list",
    "work_list",
    "work_read",
    "work_update",
    "work_comment",
  ]) {
    assert.isUndefined(assistantToolRefusal("fd-assistant-owner", [{ tool: name }]), name);
  }
});

it("refuses a whole batch when any of its calls is refused", () => {
  const read = { tool: "t3_thread_read" };
  assert.isUndefined(assistantToolRefusal("fd-assistant-owner", [read, { tool: "work_read" }]));
  assert.isDefined(
    assistantToolRefusal("fd-assistant-owner", [read, { tool: "t3_thread_send" }, read]),
  );
});

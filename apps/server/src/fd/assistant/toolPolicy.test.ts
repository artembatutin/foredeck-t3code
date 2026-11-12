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
type ToolCall = { readonly tool: string; readonly arguments?: unknown };

it("routes manager worker mutations through the queue without restricting ordinary project agents", () => {
  const refused: ReadonlyArray<ToolCall> = [
    ...[
      "t3_thread_launch",
      "create_threads",
      "delegate_task",
      "schedule_task",
      "run_scheduled_task_now",
      "t3_thread_send",
      "t3_thread_send_attachments",
      "t3_thread_interrupt",
      "t3_worktree_handoff",
      "t3_environment_link",
      "watch_pull_request",
      "work_start_thread",
      // A tool nobody classified yet is refused rather than reached by falling through.
      "some_tool_published_later",
    ].map((tool) => ({ tool })),
    { tool: "t3_pending_request", arguments: { action: "respond" } },
    { tool: "t3_thread_configure", arguments: { modelSelection: { provider: "codex" } } },
    { tool: "t3_thread_transfer", arguments: { action: "fork" } },
    { tool: "t3_thread_transfer", arguments: { action: "merge_back" } },
    { tool: "t3_queue", arguments: { action: "edit" } },
    { tool: "t3_queue", arguments: { action: "promote_to_steer" } },
    { tool: "t3_queue", arguments: { action: "cancel" } },
    { tool: "t3_queue", arguments: { action: "reorder" } },
    // An action-taking tool without a known action is refused.
    { tool: "t3_queue" },
  ];
  for (const call of refused) {
    const label = `${call.tool} ${JSON.stringify(call.arguments)}`;
    assert.isDefined(assistantToolRefusal("fd-assistant-owner", [call]), label);
    assert.isUndefined(assistantToolRefusal("ordinary-worker", [call]));
    assert.isUndefined(assistantToolRefusal(undefined, [call]));
  }
  const allowed: ReadonlyArray<ToolCall> = [
    ...[
      ...Object.keys(AssistantToolkit.tools),
      "t3_thread_read",
      "t3_thread_configure",
      "t3_project_list",
      "work_list",
      "work_read",
      "work_update",
      "work_comment",
    ].map((tool) => ({ tool })),
    { tool: "t3_pending_request", arguments: { action: "read" } },
    { tool: "t3_queue", arguments: { action: "list" } },
    { tool: "t3_thread_transfer", arguments: { action: "status" } },
  ];
  for (const call of allowed) {
    const label = `${call.tool} ${JSON.stringify(call.arguments)}`;
    assert.isUndefined(assistantToolRefusal("fd-assistant-owner", [call]), label);
  }
});

it("refuses a whole batch when any of its calls is refused", () => {
  const read = { tool: "t3_thread_read" };
  assert.isUndefined(assistantToolRefusal("fd-assistant-owner", [read, { tool: "work_read" }]));
  assert.isDefined(
    assistantToolRefusal("fd-assistant-owner", [read, { tool: "t3_thread_send" }, read]),
  );
});

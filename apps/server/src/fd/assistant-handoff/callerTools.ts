/**
 * How the caller policy (see `CallerPolicy`) treats each published MCP tool when a thread of a
 * Factory delivery the project assistant manages calls it, by exact name. A name this module does
 * not list is refused, so a tool published later stays refused there until it is classified.
 */
export type CallerToolClass = "refuse" | "respond_live" | "delegate" | "allow";

/**
 * Tools that start, message, schedule, hand off or watch work. MCP credentials belong to a
 * thread, not a run, so a call cannot be told apart from the owner's own turn there, and a run
 * these start would escape the delivery's slot.
 */
const REFUSED: ReadonlySet<string> = new Set([
  "t3_thread_send",
  "t3_thread_send_attachments",
  "t3_thread_launch",
  "create_threads",
  "schedule_task",
  "update_scheduled_task",
  "run_scheduled_task_now",
  "t3_worktree_handoff",
  "t3_thread_fork",
  "t3_thread_merge_back",
  "t3_queue_edit",
  "t3_queue_promote_to_steer",
  "watch_pull_request",
  "work_start_thread",
  "factory_deliver",
  "voice_reply",
]);

/** The project assistant's own tools: every `assistant_*` name, published or not. */
const ASSISTANT_PREFIX = "assistant_";

/** Every other published tool, which reads, or changes nothing that starts a run. */
const ALLOWED: ReadonlySet<string> = new Set([
  "delete_scheduled_task",
  "device_close",
  "device_list",
  "device_open",
  "device_screenshot",
  "factory_status",
  "factory_submit_plan",
  "factory_submit_review",
  "html_preview",
  "html_render",
  "link_pull_request",
  "list_scheduled_tasks",
  "list_thread_pull_requests",
  "orchestrator_capabilities",
  "preview_click",
  "preview_dialog",
  "preview_drag",
  "preview_evaluate",
  "preview_hover",
  "preview_navigate",
  "preview_open",
  "preview_press",
  "preview_recording_start",
  "preview_recording_stop",
  "preview_resize",
  "preview_scroll",
  "preview_select",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_status",
  "preview_type",
  "preview_upload",
  "preview_wait_for",
  "read_pull_request_guide",
  "request_secret",
  "t3_attachment_discard",
  "t3_attachment_prepare_upload",
  "t3_environment_preferences_update",
  "t3_environment_read",
  "t3_pending_request_list",
  "t3_pending_request_read",
  "t3_preview_close",
  "t3_preview_list",
  "t3_project_clone",
  "t3_project_create",
  "t3_project_delete",
  "t3_project_list",
  "t3_project_read",
  "t3_project_update",
  "t3_queue_cancel",
  "t3_queue_list",
  "t3_queue_read",
  "t3_queue_reorder",
  "t3_thread_configuration",
  "t3_thread_configure",
  "t3_thread_interrupt",
  "t3_thread_list",
  "t3_thread_organize",
  "t3_thread_read",
  "t3_thread_search",
  "t3_thread_transfers",
  "t3_thread_update",
  "t3_thread_wait",
  "t3_workflow_stop",
  "t3_worktree_list",
  "t3_worktree_status",
  "task_cancel",
  "task_status",
  "unlink_pull_request",
  "unwatch_pull_request",
  "work_comment",
  "work_create",
  "work_link_thread",
  "work_list",
  "work_read",
  "work_set_status",
  "work_update",
  "write_pull_request_guides",
]);

/**
 * The class of the tool `name`. `respond_live` answers only questions that continue a run
 * already counted; `delegate` runs under the delivery's slot (see `CallerPolicy`).
 */
export const callerToolClass = (name: string): CallerToolClass => {
  if (name === "t3_pending_request_respond") return "respond_live";
  if (name === "delegate_task") return "delegate";
  if (ALLOWED.has(name)) return "allow";
  return "refuse";
};

/** Whether `name` has a class of its own here, rather than being refused as unlisted. */
export const isClassifiedTool = (name: string) =>
  name === "t3_pending_request_respond" ||
  name === "delegate_task" ||
  name.startsWith(ASSISTANT_PREFIX) ||
  REFUSED.has(name) ||
  ALLOWED.has(name);

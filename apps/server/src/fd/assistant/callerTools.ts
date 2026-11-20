/**
 * How `CallerPolicy` treats each MCP tool, by exact name, for threads of managed deliveries.
 * Unlisted names are refused, so new tools stay refused until classified. The assistant's own
 * threads reach only `allow` plus their toolkit (see `toolPolicy`).
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
  "run_scheduled_task_now",
  "t3_worktree_handoff",
  "t3_environment_link",
  "t3_environment_unlink",
  "watch_pull_request",
  "work_start_thread",
  "factory_deliver",
  "voice_reply",
  // Factory opens, edits and merges its delivery's pull request itself, past its own gates.
  "pull_request_create",
  "pull_request_update",
  "pull_request_merge",
]);

/** The project assistant's own tools: every `assistant_*` name, published or not. */
const ASSISTANT_PREFIX = "assistant_";

/** Every other published tool, which reads, or changes nothing that starts a run. */
const ALLOWED: ReadonlySet<string> = new Set([
  "ci_logs",
  "ci_rerun",
  "comment_on_issue",
  "create_issue",
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
  "link_issue",
  "link_pull_request",
  "link_pull_requests",
  "list_issues",
  "list_scheduled_tasks",
  "list_thread_issues",
  "list_thread_pull_requests",
  "orchestrator_capabilities",
  "preview_act",
  "preview_dialog",
  "preview_evaluate",
  "preview_navigate",
  "preview_open",
  "preview_recording_start",
  "preview_recording_stop",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_status",
  "preview_wait_for",
  "pull_request_list",
  "pull_request_read",
  "pull_request_respond",
  "pull_request_review",
  "read_issue",
  "read_pull_request_guide",
  "request_secret",
  "send_to_user",
  "set_issue_state",
  "t3_attachment_discard",
  "t3_attachment_prepare_upload",
  "t3_background_wait",
  "t3_environment_links",
  "t3_environment_preferences_update",
  "t3_environment_read",
  "t3_preview_close",
  "t3_preview_list",
  "t3_project_clone",
  "t3_project_create",
  "t3_project_delete",
  "t3_project_list",
  "t3_project_read",
  "t3_project_update",
  "t3_theme_read",
  "t3_theme_set",
  "t3_thread_configure",
  "t3_thread_interrupt",
  "t3_thread_list",
  "t3_thread_organize",
  "t3_thread_read",
  "t3_thread_search",
  "t3_thread_update",
  "t3_thread_wait",
  "t3_workflow_stop",
  "t3_worktree_list",
  "t3_worktree_status",
  "task_cancel",
  "task_status",
  "unlink_issue",
  "unlink_pull_request",
  "unlink_pull_requests",
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
 * Tools that take an `action`, classed per action. An action this does not list is refused.
 */
const ACTIONS: Readonly<Record<string, Readonly<Record<string, CallerToolClass>>>> = {
  t3_pending_request: { list: "allow", read: "allow", respond: "respond_live" },
  t3_queue: {
    list: "allow",
    read: "allow",
    cancel: "allow",
    reorder: "allow",
    edit: "refuse",
    promote_to_steer: "refuse",
  },
  t3_thread_transfer: { status: "allow", fork: "refuse", merge_back: "refuse" },
};

const actionOf = (args: unknown) =>
  (args as { readonly action?: unknown } | null | undefined)?.action;

/**
 * The class of a call to the tool `name` with `args`. `respond_live` answers only questions that
 * continue a run already counted; `delegate` runs under the delivery's slot (see `CallerPolicy`).
 */
export const callerToolClass = (name: string, args?: unknown): CallerToolClass => {
  const actions = ACTIONS[name];
  if (actions !== undefined) {
    const action = actionOf(args);
    return (typeof action === "string" ? actions[action] : undefined) ?? "refuse";
  }
  if (name === "delegate_task") return "delegate";
  if (ALLOWED.has(name)) return "allow";
  return "refuse";
};

/** Whether `name` has a class of its own here, rather than being refused as unlisted. */
export const isClassifiedTool = (name: string) =>
  name in ACTIONS ||
  name === "delegate_task" ||
  name.startsWith(ASSISTANT_PREFIX) ||
  REFUSED.has(name) ||
  ALLOWED.has(name);

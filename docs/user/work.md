# Work

Work keeps one list of the things you want done in a project and lets you or an
agent act on them. Items come from **Work sources**: a folder of Markdown task
files in the repository. Agents read and update the same items through the
`work_*` tools, and a thread started from an item stays linked to it.

## Task files

A Markdown source is a folder in the project's main checkout, `.foredeck/work`
by default. Each task is one file such as `fd-7k3qa2-add-jira-sync.md`. The file
name is only a hint; the `id` in the frontmatter is what identifies the task, so
renaming a file keeps its links.

```markdown
---
id: fd-7k3qa2
title: Add Jira sync for the Work module
status: in_progress
priority: high
labels: work, jira
assignee: artem
parent: fd-2m9x4c
blocked_by: fd-9ab3de, fd-2m9x4c
created: 2026-10-20T09:15:00Z
updated: 2026-10-20T11:02:00Z
---

Free Markdown. Checkboxes are just Markdown.

## Notes

- 2026-10-20T10:40:00Z (claude) Mapped ADF to Markdown.
```

- `id`, `title` and `status` are required. `status` is one of `todo`,
  `in_progress`, `done` or `cancelled`.
- Every field is a single line. Lists (`labels`, `blocked_by`) are
  comma-separated.
- A task is **blocked** while any task in `blocked_by` is not done or cancelled.
  Blocked is shown, never stored.
- Comments are lines under `## Notes`. Work appends them; it never edits or
  removes old notes.
- A file that cannot be read cleanly (broken frontmatter, a duplicate id, an
  unknown status) is shown as read-only and never rewritten. Fix it in your
  editor.

There is no delete. Set a task to `cancelled`, or remove the file yourself.
Task files are ordinary repository files: commit them like any other change.

## Threads started from an item

Starting a thread from an item opens a new thread in the item's project with the
item, its recent comments and instructions in the first message. Choose a mode:

- **Scope** investigates and replies with a plan without changing files.
- **Plan** writes a plan and stops to ask.
- **Implement** does the work and opens one pull request for it.

The thread is linked to the item. Starting again while that thread is still open
returns the same thread; choose to start another one only when you want a second
attempt. Deleting or settling the thread removes the link; unlinking keeps the
thread.

When **Mark as in progress on start** is on for a Markdown source (the
default), a `todo` task moves to `in_progress` when its thread starts. If that
thread's run fails or is stopped, Work offers to move the task back to `todo`.
Nothing changes back on its own.

## Agents

Agents in your threads, scheduled tasks and outside MCP clients reach Work
through these tools:

| Tool                | What it does                                              |
| ------------------- | --------------------------------------------------------- |
| `work_list`         | Lists a project's items, newest first.                    |
| `work_read`         | Reads one item with comments, links and transitions.      |
| `work_create`       | Creates an item.                                          |
| `work_update`       | Changes title, body, priority, labels, assignee, parents. |
| `work_set_status`   | Sets the status.                                          |
| `work_comment`      | Adds a comment, signed with the agent's name.             |
| `work_link_thread`  | Links or unlinks a thread.                                |
| `work_start_thread` | Starts a thread from an item in the agent's own modes.    |

An agent names an item by the reference in its prompt
(`<source id>:<item id>`), by a key such as `fd-7k3qa2`, or by its URL.

Agents in plan mode, and outside clients you approved as read-only, can only
read. Other agents can update items and start threads, but never with broader
permissions than their own, and never change source settings.

To keep agents from editing task frontmatter by hand, you can add this to your
project's `AGENTS.md` or `CLAUDE.md`:

```markdown
Tasks live in `.foredeck/work/*.md`. Keep their frontmatter valid. Change a
task's status with `work_set_status` and record progress with `work_comment`
instead of editing the file. Do not edit task frontmatter inside a worktree.
```

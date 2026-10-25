# Work

Work keeps one list of the things you want done in a project and lets you or an
agent act on them. Items come from **Work sources**: a folder of Markdown task
files in the repository, a GitHub repository's issues, or a Jira Cloud project's
issues. Agents read and update the same items through the
`work_*` tools, and a thread started from an item stays linked to it.

## Open Work

Choose **Work** in the sidebar, **Open work** in the command palette, or press
`mod+shift+u`. Pick a project; the list shows its items from every source.
**Ready** shows unblocked `todo` items nobody is working on, **Active** items with
an open linked thread, **Done** finished or cancelled items, and **All**
everything. Select an item to read, edit, comment, change its status, start a
thread or link one. **Add to prompt** opens a new thread in the item's project
with a reference to the item in the composer. If an item changes while you edit
its title or description, Work keeps your edit and shows the current version so
you can reapply your edit or discard it. **Deliver** hands the item to
[Factory](./factory.md), which takes it through authoring, verification and
review to one pull request.

To add a source, open the project's settings and use **Work sources**. In a
thread, the details panel lists the thread's linked items; use **Link work item**
there or in the command palette.

On mobile, tap the checklist in the threads header (iOS) or toolbar (Android).
Threads show their linked items above the conversation, and **Settings →
Projects & threads → Overview** manages a project's Work sources.

If Work says the connection cannot read it, this device was paired before Work
existed. Pair it again from a session that has Work access.

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

## GitHub Issues

A GitHub source lists one repository's issues. It uses the same GitHub
credential as pull requests (**Settings → Source Control**, then `GH_TOKEN`,
then `gh auth login`), so issues and pull requests share one rate limit. A
fine-grained token needs **Issues: read and write**, **Metadata: read** and
**Pull requests: read** on the repository; a token made for pull requests alone
may not be able to change issues.

GitHub issues are open or closed, so Work shows them as **To do**, **Done** or
**Cancelled** (closed as not planned or duplicate). They have no in-progress
state; a linked thread shows that work is happening. Labels, the assignee, the
title, the description and comments can be changed from Work; sub-issues and
dependencies are shown but changed on GitHub. A transferred or deleted issue
shows as not found; unlink it from its threads.

## Jira Cloud

A Jira source lists one Jira Cloud project's issues. Add it with the site URL
(`https://your-site.atlassian.net`), the project key, your Atlassian email and an
**unscoped** API token from your Atlassian account settings. The token stays on
the server and is shared by every source on the same site and email, so a second
project on that site does not ask for it again. **Remove token** forgets it for
all of them; a source without a token shows that it needs one. Jira Data Center,
scoped tokens and Atlassian sign-in are not supported yet. Tokens expire on the
date you chose when creating them; when one does, use **Replace token** on the
source. Work checks the new token before saving it for every source on that site
and email, so nothing needs to be disconnected.

Work shows Jira's own status name and maps its category to **To do**, **In
progress** or **Done** (**Cancelled** for resolutions such as Won't Do or
Duplicate). Changing the status applies the Jira transition that reaches it; when
several do, Work lists them to choose from, and transitions that need extra fields
are done in Jira. Descriptions are shown as Markdown; content Work cannot show,
such as tables, appears as a placeholder, and such a description is edited in
Jira so nothing is lost. Issue links are read to show what blocks an issue and are
changed in Jira.

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
default), a `todo` task moves to `in_progress` when its thread starts, unless
someone changed the task while the thread was starting. If that
thread's run fails or is stopped, the item offers **Back to todo?**; when a run
completes, it offers to mark the item done. Both can be undone, and nothing
changes on its own. Undo applies only while nobody else has changed the item
since; otherwise Work tells you and leaves the newer change in place. **Send
update to thread** appears when the item changed after its thread started, and
opens the thread with a note added to its draft; anything you had already typed
there stays.

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

Agents deliver an item through Factory with `factory_deliver`; see
[Factory](./factory.md#start-a-delivery).

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

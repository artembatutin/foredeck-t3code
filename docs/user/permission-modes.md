# Permission modes

Permission modes control when an agent needs your approval to act. Choose a mode in the message
composer; it applies to that thread.

Set the default for new threads in **Settings → General → New threads → Permissions**.
Projects can override the environment default. New threads use this setting rather than the
mode of the thread you were viewing. The initial default is **Full access**; existing threads
and modes you choose in a draft keep their permissions.

| Mode                  | Behavior                                                                              |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Supervised**        | Requests approval for commands and file changes.                                      |
| **Auto-accept edits** | Approves file edits automatically; what else still asks depends on the provider.      |
| **Auto**              | Uses the provider's automatic review to approve routine actions and ask about others. |
| **Full access**       | Allows commands and edits without approval prompts.                                   |

Approve or reject requests in the conversation to let the agent continue. Permission modes do
not prevent the agent from asking questions about the task. Each request says why this mode did not
already cover it, or that the provider gave no reason.

## What approving lasts for

You can choose only what the provider offers. **Approve** covers that one action. A session choice
covers the thread's provider session and ends with it, such as when the provider or server restarts.
An **always** choice is the provider's own, and how long it lasts is up to that provider. T3 Code
keeps no approval of its own for a project or a delivery, so a new permission always asks you, and
there is nothing to revoke later.

## When a host's policy refuses a mode

An administrator's policy on the provider's host can refuse a mode. Codex reports its policy, so a
mode it refuses is explained before anything is sent, with the modes it does allow and what each
means. Nothing changes until you choose one. Other providers do not report a policy, so a refusal
there shows only when the turn fails. Answering a question that would start a new turn waits the same
way: the question stays open, and you can still dismiss it. An answer the running turn is waiting for
goes through as usual. Factory refuses the same way, before launching a thread or sending a turn on
one: change the project's default permission mode for a launch or the thread's own for a turn, then
**Resume**, or review a reviewed delivery again. A turn that starts by itself, such as a wake from a
watched pull request, starts nothing while its mode is refused and runs the next time it is due after
you change the thread's mode. On a Factory delivery's thread it shows in **Pending actions**.

## Provider differences

Providers enforce permissions differently. Some read-only actions can proceed in **Supervised**.
**Auto-accept edits** is the one that varies most, and the composer's mode menu says what it covers
for the selected provider. On Codex it also lets commands run inside the sandbox, and asks for what
leaves it. Cursor sends no approval requests, so what its sandbox blocks does not run. On Claude it
covers edits in the workspace and the simple file commands that go with them. On OpenCode and Pi it
covers file edits and asks before commands.
**Auto** uses automatic review on Codex, Claude, Cursor, and Grok; providers without an equivalent,
including OpenCode and Antigravity, fall back to asking. On Grok, commands its review blocks come
to you for approval.

Muse Code offers only **Supervised** and **Full access**. A Muse thread already set to another mode
runs in **Supervised**.

Grok offers no **Auto-accept edits**. A Grok thread already set to it runs in **Supervised**. Grok
file-change approvals offer **Allow all edits this session**. Its command approvals have no
session-wide choice, because Grok would remember that command for the whole project.

ACP Registry agents run their own tools in their own mode; T3 Code answers their approval requests
by the permission mode. See [ACP Registry permissions](./providers-acp.md#permissions-and-terminals).

Antigravity can still send native approval requests in **Full access**. It only offers remembered
approvals for actions that support them.

Devin CLI commands run through Foredeck's terminals and follow the selected permission mode.
Devin Cloud offers only **Full access** because its hosted workspace does not use the local
permission system. Selecting Cloud uses that mode even when the thread previously used a
different mode. See [Devin CLI and Cloud](./providers-devin.md).

See the [provider guides](./install.md#providers) for setup and provider-specific limits.

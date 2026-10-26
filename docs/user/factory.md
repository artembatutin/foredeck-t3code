# Factory

Factory delivers a [Work](./work.md) item for you. A delivery runs an author agent on a new
branch and worktree, verifies its commits by running the project's verify command on the server,
has a reviewer agent on a fresh, separate thread check the verified commit, and sends failed
checks or blocking findings back to the author as repair rounds. A repair that leaves the same
failure ends the repairs early. Once a commit passes verify and review, Factory records its
approval and opens one pull request for the branch. Factory never merges it; merging is up to
you.

## Before you start

A delivery cannot start until the project has a verify command. Open the project's settings and
use **Factory**:

- **Verify command** runs in the delivery's worktree after each change, on the environment that
  owns the project. It decides whether the work passes, so use the command that runs your checks,
  such as your test script. It must leave the checkout as it found it: a run that commits or
  changes files is refused and the delivery blocks.
- **Setup command** is optional. It can be saved, but deliveries do not run it yet.
- **Role models** pick the model for the **Planner**, the **Author** and the **Reviewer** from that
  environment's providers. **Default** uses the project's model, and the planner and the reviewer
  default to the author's. The planner plans an item delivered as a parent.
- **Limits** set how many **Fix rounds** and **Review rounds** a delivery may spend, and the
  **Verify timeout** in minutes.

Each command is an executable plus its arguments, not a shell line. Enter `npm` as the executable
and `test` as an argument, each argument in its own field. Pipes, `&&`, variables and wildcards
are not interpreted, so put several steps in a script and run that.

A running delivery keeps the round limits it started with. The verify command, its timeout and
the role models are read when each step runs, so a change applies to the delivery's next verify
or thread.

Factory settings are stored on each environment for its own checkout of the project. Changing
them needs a live connection with the settings permission.

## Start a delivery

On web and desktop, start one from an item in Work:

- **Deliver** in the Factory section of the item's detail.
- **Deliver** in the **Start a thread** dialog, beside **Start thread**.
- **Deliver work item** in the command palette, for the item open in Work.

Deliver is offered only on a live connection allowed to run agents, and only while the item has
no delivery that is not done or cancelled. Starting fails when the project has no verify command,
and the message names the settings to change. The project's repository needs at least one commit.

Agents start deliveries with the `factory_deliver` tool, as a single item or a parent, and follow
them with `factory_status`, which reads one delivery or every delivery of an item. Only you decide
a parent's plan. Agents in plan mode and outside clients you approved as read-only can only read.
A delivery's threads never run with broader permissions than those of the agent that started it.

## Deliver a parent

Deliver an item as a parent when it is too large for one change. A planner agent splits it into
tasks, you approve the plan, and Factory delivers each task in turn, all on one branch and one
pull request.

On web and desktop, use **Deliver as parent** beside **Deliver** in the item's Factory section or
the **Start a thread** dialog, or **Deliver work item as parent** in the command palette. It is
offered where Deliver is, when the environment can plan. Only an item from a Markdown source can
be a parent, because its tasks become task files in that source. An item from any other source,
such as a GitHub or Jira issue, is refused as a parent and nothing starts; deliver it as a single
item instead.

The planner reads the project on the delivery's new branch and worktree without changing it, and
submits a plan: tasks in order, each with a title, a summary, acceptance criteria and how each
criterion is tested. A planner that finds nothing to plan blocks the delivery, and shows its
note saying why when it gave one. **Resume** asks it to plan again, or cancel the delivery.

### Approve the plan

The plan waits for you in the parent item's Factory section, on web, desktop and mobile, as
**Waiting for you**. You can edit each task's title, summary, acceptance criteria and their tests,
change the order and remove tasks, then **Save plan**. You cannot add tasks or remove every task.
If the plan changes while you edit, choose **Keep my edits** or **Use the new plan**.

- **Approve plan** asks first. Save or discard your edits before approving. Factory refuses a
  plan with a task too long or with characters the source's files cannot hold; edit it and approve
  again. The plan cannot change after approval.
- **Reject plan** asks first, then ends the delivery. No child items are created.
- **Replan** sends the planner a note about what to change. Its new plan waits for you here in
  place of the old one.

### After approval

Factory creates one child item per task in the parent's source, under the parent and blocked by
the child before it. They are task files like the ones you write; commit them like any other
change. Each child is then delivered in plan order, one at a time, on the parent's branch and
worktree: a new author thread, verify, review and repair rounds, like a single item, and its own
Factory section on the child item. A child ends **Approved** without a pull request of its own.
A blocked child holds the parent until you resume or cancel it.

Once the last child is approved, the parent integrates: the server runs the verify command again
on the whole branch, and a reviewer on a new thread checks every change since the branch started
against every child's acceptance criteria. Then Factory opens one pull request for the branch
that lists each child item with its verified commit and review. A failed verify or a review that
requires changes blocks the parent with no repair round. Fix the branch if needed, then
**Resume** to verify and review it again with a new reviewer.

## Follow a delivery

The item's Factory section shows its current delivery: its status, the stage it is in, its branch
and how many fix and review rounds it has used. The timeline lists each step in order (author,
verify, review, repair, record, pull request) with its round and outcome, the verify receipt or
review it produced, and the findings a review raised. **Open thread** opens the thread a step ran
on. On mobile, the item's screen in Work shows the same timeline and controls; start deliveries
from web or desktop.

Factory's threads are linked to the item but do not offer **Mark done?** or **Back to todo?**.
Factory does not change the item's status until its pull request merges.

## When the pull request gets feedback

Factory watches a single item's pull request on the author's thread. When a check fails, someone
comments or the branch starts to conflict, T3 Code wakes that thread, and Factory follows the
author's answer as a round of the delivery: once the turn ends, the server verifies the branch
again, a reviewer on a fresh thread reviews it, and Factory records the approval and pushes the
approved commit to the same pull request. It does this even when the author changed nothing, so
the pull request only ever holds verified, reviewed commits. Feedback that arrives during a round
is followed too, once the author is done with the round or the pull request is open again. Checks
that all pass start no round. Rounds count against the fix and review rounds the delivery has
left, and a round that fails or runs out of rounds blocks like any other; **Resume** verifies and
reviews again before pushing. Turns you send on the thread yourself are yours and start no round,
and cancelling the delivery leaves them running. Feedback on a parent's pull request is not
followed yet.

If T3 Code stops watching the pull request, because it cannot read it from the host or after too
many comment-only updates, or cannot start watching it, as on an author thread you settled, the
delivery blocks: Factory no longer hears of its feedback. **Resume** watches it again; unsettle the
thread first if you settled it. Cancelling the delivery stops the watch Factory started and the
turns it woke the thread for, but not a watch or a turn you started yourself.

## When the pull request merges or closes

Factory follows the pull request on the thread it is linked to: the author's thread, or for a
parent the last child's author's. When you merge it, Factory marks the item done, and for a parent
each of its child items too, leaving any already done as they are. Then it removes the delivery's
worktree, unless it has uncommitted changes or a thread is still working in it. The branch always
stays. The delivery then shows **Done**. If an item cannot be marked done or the worktree cannot be
removed, the delivery blocks; **Resume** tries again. Cancelling the delivery while it finishes
keeps the worktree.

Closing the pull request without merging cancels the delivery and posts a comment on the item.
The worktree, branch and commits stay; a parent's approved children keep their approval. A merge
or close during a feedback round ends the round the same way.

Factory notices a merge or close made outside the app only while that thread is not settled. A
thread with an open pull request does not settle on its own; if you settle it yourself, unsettle
it once the pull request is merged.

## Stop, resume or cancel

- **Stop after step** lets the current step finish. The delivery shows **Stopping** and becomes
  **Stopped** at the next stage boundary, before it would verify, start a review or repair round,
  record or open the pull request. A parent also stops before the plan waits for you, before its
  next child and before it integrates. A problem found before then still blocks it.
- **Resume** on a delivery that is still **Stopping** takes back the stop: it goes on running from
  the step under way, with the rounds it has already used.
- **Resume** on a **Stopped** or **Blocked** single item or child checks its branch again and
  verifies it before going on, even if nothing changed, unless all that is left is opening the
  pull request for the commit it approved. It also gets a fresh set of repair rounds within the
  limits it started with. If you deleted one of its threads, it blocks again; cancel it and
  deliver the item anew.
- **Resume** on a **Stopped** or **Blocked** parent goes on from where it is. Before you approve
  its plan, a parent stopped where the plan waits for you waits for you again on the same plan,
  without verifying; otherwise its planner gets a new turn to plan again. If you deleted the
  planner's thread, it blocks again; cancel it and deliver the item anew. Once its plan is
  approved, deleted planner or reviewer threads do not hold it back. It creates the child items
  still missing, keeping those already created, or goes on with the first child not yet approved,
  and never creates a child twice. After its last child is approved, it integrates again with a
  fresh verify and a new reviewer on a separate thread, with no repair round.
- **Cancel delivery** asks first, then interrupts what the delivery's agents are working on and
  ends it. Cancelling a parent also ends its child deliveries not yet approved. Cancelling a child
  ends its parent and the parent's other children not yet approved. Approved children keep their
  approval. The branch, worktree and commits stay. Verification or a pull request the server has
  already started finishes, but no longer changes the delivery. Delivering the item again starts
  a new delivery on a branch of its own, named like the first with `-2`, `-3` and so on added.

## When a delivery needs you

A delivery needs you when it is **Blocked** or **Waiting for you**. The item's Factory section
highlights its status and shows the reason, such as verify still failing with no fix round left,
a review still requiring changes with no review round left, the same failure after a repair, or
code that changed during review. Fix what it names if needed, then **Resume**, or **Cancel
delivery**.

Factory also posts one comment on the Work item each time a delivery becomes blocked or starts
waiting, so the GitHub issue, Jira issue or task file shows it too. It posts again when a commit
is approved, when the pull request opens or a feedback round updates it, and when it is closed
without merging. Factory sends no notifications.

Factory refuses to publish a pull request whose text would name an AI tool or credit one as an
author, and blocks before pushing. The item's title and the verify command appear in the pull
request as written; change them and resume.

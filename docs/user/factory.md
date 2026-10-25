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
- **Role models** pick the model for the **Author** and the **Reviewer** from that environment's
  providers. **Default** uses the project's model, and the reviewer's default is the author's. The
  **Planner** model is not used yet.
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

Agents start deliveries with the `factory_deliver` tool and follow them with `factory_status`,
which reads one delivery or every delivery of an item. Agents in plan mode and outside clients you
approved as read-only can only read. A delivery's threads never run with broader permissions than
those of the agent that started it.

## Follow a delivery

The item's Factory section shows its current delivery: its status, the stage it is in, its branch
and how many fix and review rounds it has used. The timeline lists each step in order (author,
verify, review, repair, record, pull request) with its round and outcome, the verify receipt or
review it produced, and the findings a review raised. **Open thread** opens the thread a step ran
on. On mobile, the item's screen in Work shows the same timeline and controls; start deliveries
from web or desktop.

Factory's threads are linked to the item but do not offer **Mark done?** or **Back to todo?**.
Factory does not change the item's status.

## Stop, resume or cancel

- **Stop after step** lets the current step finish. The delivery shows **Stopping** and becomes
  **Stopped** at the next stage boundary, before it would verify, start a review or repair round,
  record or open the pull request. A problem found before then still blocks it.
- **Resume** on a delivery that is still **Stopping** takes back the stop: it goes on running from
  the step under way, with the rounds it has already used. Resuming a **Stopped** or **Blocked**
  delivery checks its branch again and verifies it before going on, even if nothing changed,
  unless all that is left is opening the pull request for the commit it approved. It also gets a
  fresh set of repair rounds within the limits it started with. If you deleted one of its threads,
  it blocks again; cancel it and deliver the item anew.
- **Cancel delivery** asks first, then interrupts what the delivery's agents are working on and
  ends it. The branch, worktree and commits stay. Verification or a pull request the server has
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
is approved and when the pull request opens. Factory sends no notifications.

Factory refuses to publish a pull request whose text would name an AI tool or credit one as an
author, and blocks before pushing. The item's title and the verify command appear in the pull
request as written; change them and resume.

# Factory

Factory delivers a [Work](./work.md) item for you. A delivery runs an author agent on a new
branch and worktree, verifies its commits by running the project's verify command on the server,
has a reviewer agent on a fresh, separate thread check the verified commit, and sends failed
checks or blocking findings back to the author as repair rounds. A repeated failure on the same
tree ends the repairs early. Once a commit passes verify and review, Factory records its
approval and opens one pull request for the branch. Factory never merges it; merging is up to
you.

## Before you start

A delivery cannot start until the project has a verify command. Open the project's settings and
use **Factory**:

- **Verify command** runs in the delivery's worktree after each change, on the environment that
  owns the project. It decides whether the work passes, so use the command that runs your checks,
  such as your test script. It must leave the checkout as it found it: a run that commits or
  changes files is refused and the delivery blocks.
- **Setup command** is optional. It runs in the prepared delivery worktree before the first
  author turn of a single item or each child of a parent. Use it for what the author needs first,
  such as installing dependencies. It uses the verify timeout. A nonzero exit, signal, timeout or
  failure to start blocks the delivery before that turn; fix the problem and **Resume** to retry.
  It does not run for planning, review, repairs or pull request feedback rounds. Setup logs stay
  with the delivery's evidence under T3 home; setup does not produce a verify receipt.
- **Role models** pick the model for the **Planner**, the **Author** and the **Reviewer** from that
  environment's providers. **Default** uses the project's model, and the planner and the reviewer
  default to the author's. The planner plans an item delivered as a parent. Below each model are the
  options that model describes, such as reasoning effort and service tier, and none where it
  describes none. An option is a request: the provider decides what it runs and how it bills.
- **Limits** set how many **Fix rounds** and **Review rounds** a delivery may spend, and the
  **Verify timeout** in minutes. A delivery counts these as verification fixes and review
  follow-ups: repair turns that answer a failed verify or a blocking review.
- **Blocking severities** choose which review findings require a fix, even when the review's
  verdict passes. **High** is selected by default; select any combination of High, Medium and
  Low, including none. A changes-required verdict, an unverified acceptance criterion or missing
  evidence still requires changes regardless of that selection.
- **High-risk effort** is the effort value used for high-risk tasks and second or later repair
  and review rounds, when the model offers it. It defaults to `xhigh`; enter a nonblank value
  of at most 64 characters that your model supports. Escalation never lowers a higher effort
  you chose. Mechanical fix-commit turns use `medium` when offered; that temporary choice does
  not become the effort for later turns.

Each command is an executable plus its arguments, not a shell line. Enter `npm` as the executable
and `test` as an argument, each argument in its own field. Pipes, `&&`, variables and wildcards
are not interpreted, so put several steps in a script and run that.

Above each command, **From this project** lists the scripts in the `package.json` of the project's
checkout, run through the package manager its lockfile names, and tested presets such as a frozen
install. Choosing one fills in the executable and arguments for you to save. Any other command still
works: type it in, and **Custom command** brings back one a suggestion replaced. **Check command**
looks for the command where this environment would run it and says what is missing, such as an
executable not on its `PATH`, a runtime its script needs, or a Windows batch script, which has to be
replaced by the program itself. Neither runs anything or changes what is saved. A check that finds
the command does not say it passes; only a delivery runs it, in its own worktree.

If you pick another model for a role with saved options, nothing changes until you choose what
happens to them: keep them, remove them, or keep the old model. A saved value the model does not
offer stays listed and flagged until you change it. A delivery you reviewed will not start or go on
with one.

These settings are defaults for future deliveries. A delivery you
[reviewed and started](#review-and-start) keeps what you reviewed. Any other delivery keeps the round
limits it started with, and reads the rest as it goes: the verify and setup commands, the timeout and
the role models when each step runs, so a change applies to its next verify or thread, blocking
severities when a review is judged, and high-risk effort for each applicable turn. A role's thread
keeps the model and options it launched with.

Factory settings are stored on each environment for its own checkout of the project. Changing
them needs a live connection with the settings permission.

## Customize prompts

To replace a prompt's rules, put a Markdown file in
`.foredeck/factory/prompts/` in the project's checkout on its environment. Factory reads this
canonical checkout, even while a delivery works on its separate worktree. A file changed only
in the delivery worktree has no effect until it reaches the project's checkout.

The seven names are `plan.md`, `author.md`, `review.md`, `fix-verify.md`, `fix-review.md`,
`fix-commit.md` and `integrate.md`. `review.md` also supplies the rules for later review rounds;
`integrate.md` controls the whole-branch review of a parent independently. Factory reads the
applicable file again for each new launch or turn, including retries and replanning. A delivery you
reviewed and started keeps the files you reviewed: a change blocks it before the next step that
reads that file, until you restore the file or review the delivery again.

Only the rules change. Item, branch, commit, receipt, findings and failure facts, the required
plan and review fields, and submission and reply instructions stay fixed. The server's
validation, verification and approval checks still apply.

A missing file uses the built-in rules. An existing override must be a readable, nonblank UTF-8
file of at most 64 KiB, with any symlinks staying inside the canonical checkout. An unusable file
blocks the delivery with the prompt's name; fix or remove that file and **Resume**.

## Start a delivery

On web and desktop, start one from an item in Work:

- **Deliver** in the Factory section of the item's detail.
- **Deliver** in the **Start a thread** dialog, beside **Start thread**.
- **Deliver work item** in the command palette, for the item open in Work.

Deliver is offered only on a live connection allowed to run agents, and only while the item has
no delivery that is not done or cancelled. Starting fails when the project has no verify command,
and the message names the settings to change. The project's repository needs at least one commit.

Agents start deliveries with the `factory_deliver` tool, as a single item or a parent, or start
the project's next Ready item (see [Deliver on a schedule](#deliver-on-a-schedule)), and follow
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

## Migrate a Looper goal

Factory replaces Looper's goal delivery with a parent Work item:

1. Add a [Markdown source in Work](./work.md#open-work) to the project if it does not have one.
2. Create a parent item in that source and put the Looper goal text in its description, including
   its requirements, constraints and acceptance criteria. Set the project's Factory verify
   command, and its setup command if the authors need one.
3. Open the item on web or desktop and choose **Deliver as parent**. Factory starts a planner
   on the parent's new branch and worktree.
4. Review the proposed tasks, edit or replan as needed, then **Approve plan**. Factory creates
   the child items and delivers them in order on one branch, then verifies and reviews the whole
   branch and opens one pull request. You decide when to merge it.

This starts a new Factory delivery; it does not import Looper's runtime state or approvals.

## Deliver on a schedule

Factory can take your Ready items one at a time without you starting each one. Create a scheduled
task in the project in **Settings → Scheduled tasks**, with a prompt such as:

> Deliver this project's next Ready Work item: call `factory_deliver` with `next: true` and this
> project's id. Report the delivery it started, or that nothing was Ready.

Each run starts at most one delivery, as a single item: an item Work shows as **Ready**, an
unblocked `todo` item nobody is working on, that has no delivery in progress. Factory goes through
the project's Work sources in the order you added them, and through each source's items in the
order the source lists them, and starts the first such item. To deliver only some items, label
them and add the label to the prompt, as in "call `factory_deliver` with `next: true`, this
project's id and the label `autopilot`".

When nothing is Ready, nothing starts and the agent is told so; the next run looks again. If
Factory cannot read a Work source completely, or the source lists a task file Work cannot read,
it starts nothing listed after it and says the list was incomplete; check the source in Work.
Like any delivery, it needs the project's verify command, and its threads never run with broader
permissions than the task's agent.

## Review and start

On desktop and web, the project assistant's **Ideas** list offers **Review** on each idea. It shows
what starting would capture and run: the short title, goal, acceptance criteria, restrictions and
decisions, what changed since the last capture, where it goes, each role's model and options, the
limits and the project's prompt overrides. Conversation notes are listed apart, since neither the Work
item nor the agents receive them. You can edit the title, goal, criteria and restrictions there;
saving starts nothing, and an edit made after someone else changed the idea is refused rather than
overwriting theirs.

**Review and start** captures the idea in Work and queues exactly one delivery, in one step, so there
is no go-ahead to save first. It needs a connection allowed to write Work items and to run agents. If
anything you reviewed changes while it runs, nothing is authorized or started and you review it
again; whatever was already captured stays in Work.

Until you start, everything here is the project's current settings. Once you do, the delivery keeps
what you reviewed for good, across stops, resumes and restarts: the role models and options, the
verify and setup commands, the limits, blocking severities, high-risk effort, pipeline, repository,
runtime mode and prompt overrides. It keeps them as limits, not permissions: withdrawing your go-ahead,
narrowing the project's default mode or a provider dropping a model still stops the next step, with
nothing substituted. The fix, review and fix-commit rounds count for the whole delivery, so a resume
never adds any. The timeout applies to each command; there is no limit on total time.

To go past what a reviewed delivery was allowed, or past a blocked setting you have since changed on
purpose, review the idea again while the delivery is **Stopped** or **Blocked**: **Review and resume**
hands it the new values and it keeps counting what it used. It stays a single item or a parent, as it
started. If the idea itself changed, cancel the delivery first. After a reviewed delivery failed or was cancelled, only a new review starts another
attempt: **Retry** is not offered, and the assistant cannot queue the idea again. On mobile, you can
follow these deliveries but not start them, and agents cannot authorize one.

## Hand work over from the project assistant

On desktop and web, the [project assistant](./composer.md#project-assistant) can also deliver an idea
you agreed on through Factory, without a review of its settings. Discussing it starts nothing; each
step waits for you to ask:

1. **Capture.** Ask the assistant to record the idea in Work. With `assistant_capture_work` it
   writes the goal, acceptance criteria, constraints, decisions and open questions into one item.
   If the project has several Work sources, say which to use. An idea Factory should plan into
   tasks needs a Markdown source.
2. **Review.** Read the item in Work. If you edit it or the idea changes, ask for a new capture:
   a capture that changes the item withdraws your go-ahead, and an item edited since its capture
   is not queued until you have decided which version stands.
3. **Authorize.** Tell the assistant to go ahead. It saves your go-ahead with
   `assistant_revise_brief` and queues the delivery with `assistant_assign`. The project needs a
   verify command; open the project's settings and use **Factory**.

The assistant's **Assignments** list shows where each delivery is and why, with links to its Work
item, thread and pull request. The assistant can also stop, resume, retry or cancel it with
`assistant_control`, and answer a live question from Factory's own running agent with
`assistant_answer`. On mobile, a delivery's item and the Factory list show the same status and slot
wait, but handing work over happens on desktop and web.

### Slot waits

The assistant runs two assignments at a time on an environment, in priority order, and an
assignment that keeps being passed over goes first. A delivery holds its slot until it next rests:
waiting at the plan gate, stopped, blocked, or with its pull request open and nothing left to do.
When it has more to do and no slot is free, it shows **Waiting for a project assistant slot**. That
asks nothing of you, and it starts by itself once a slot frees up.

Stopping a delivery before Factory has started it frees its slot and keeps the delivery. **Resume**
waits for a slot and starts that same delivery; **Cancel** ends it. **Retry** is for an assignment
that failed or was cancelled without a review, and starts a new delivery.

### Follow-ups that wait

Pull request feedback, a usage-limit resume, a delegated agent's question or result, and background
work that finishes are follow-ups T3 starts on a delivery's threads by itself. A delivery's
follow-up also needs a slot, so it can wait, and the assignment says which ones do:

- **Unknown origin.** When T3 cannot tell whether a follow-up came from the delivery or from your
  own turn on the thread, the notice says so and it counts as the delivery's. Your own messages
  and their follow-ups never wait.
- **Blocked.** A follow-up waits without taking a turn while the Work item changed, is closed or
  cannot be read, or your go-ahead was withdrawn. It goes on once that is restored; cancelling the
  assignment drops it.
- **Lost background work.** Background work that finished while waiting does not survive a server
  restart. The notice names the thread; open it and ask the agent to check that work.

### When the delivery has ended

Automatic work that arrives after a delivery ended is not done. Nothing acts on it, and the
assignment's notice says what you can do: review the pull request yourself, answer a question in
its thread, read a delegated result there, or retry the assignment for a new delivery. Messages you
send on those threads still run.

### What stays with you

Agents on a delivery the assistant manages cannot message, start, schedule, hand off or watch other
work, or answer a question when the answer would start a new turn. They delegate a subtask with
`delegate_task`, which runs under the delivery's slot, or ask you to do it. Once the delivery has
ended they cannot delegate either.

Approving a parent's plan and merging the pull request stay yours: approve, edit or replan in the
item's Factory section, and merge on your pull request's host. The assignment completes only after
the merge and Factory's close-out, not when the agents finish, the review passes or the pull request
opens. A pull request closed without merging cancels it.

## Follow a delivery

The item's Factory section starts with what the delivery comes to now and what, if anything, it
needs from you. Once its pull request is open and nothing else is running, it says **Ready for your
review**, with **Open pull request**, **Review changes** and the verified commit, verify result and
independent review it was judged on. That is not done: only a merge you make finishes it. A message
in a thread from earlier in the delivery stays as it was written, so where it says Factory is still
running, this section and the assistant's **Assignments** list say what is true now.

**Pending actions** lists what the delivery waits on someone for, here and in the assistant's
**Assignments**: each says what kind of decision it is, why it is asked, who asks and where it is
decided, and listing it decides nothing. A question an agent asks never grants a permission, and a
permission is only ever decided in its thread. A delivery whose mode the provider's host refuses,
or whose thread's automatic turn that host refused, runs nothing and shows that here, with the modes
that host allows; see
[permission modes](./permission-modes.md#when-a-hosts-policy-refuses-a-mode). A parent also shows
this for the child it waits on, with a link to that child's item, where you resume it.

Four things are shown separately because they are separate: the item's **Work status** and **Human
assignee** from its source, the project assistant's **Queue priority**, and the **Factory delivery**
status. Factory never rewrites the item's fields to match; a To do item with an open pull request is
normal until the merge. The Factory page and the assistant's lists show them the same way, and say
**Not available** when a source could not be read in time. A change made in Work or to a queue
priority shows at once; one made directly in a tracker shows when you return to the Factory page, or
within a few minutes.

The section counts **verification fixes** and **review follow-ups**, the repair turns a failed verify
or a blocking review took, and **fix-commit turns**, with what each has left, beside how many verify
and review attempts ran. One repair after a blocking review shows one review follow-up and two
review attempts. A delivery you [reviewed and started](#review-and-start) counts what you approved
for the whole delivery; any other delivery counts since its last resume. The timeline lists each
step in order (author, verify, review, repair, record, pull request) with its attempt and outcome,
the verify receipt or review it produced, and the findings a review raised. **Open thread** opens the
thread a step ran on. On mobile, the item's screen in Work shows the same next action, timeline and
controls; start deliveries from web or desktop.

The section also says what each role runs on. **Reviewed** is the value your review holds it to, and
**Requested** is what its latest turn actually asked for, or what its launch would ask for before it
has one. They can differ: a high-risk task or a later round can raise the effort to the high-risk
effort you reviewed, and a fix-commit turn asks for `medium` for that turn alone. **Read now** marks a
delivery without a review, whose next step reads its values then. Beside each is what the provider
reported for that role's thread, or **Not reported** where it reported nothing, which says nothing
about whether your request was honored.

Factory's threads are linked to the item but do not offer **Mark done?** or **Back to todo?**.
Factory does not change the item's status until its pull request merges.

## When the pull request gets feedback

Factory watches the pull request on the thread it is linked to: the author's thread, or for a
parent the last child's author's. When a check fails, someone comments or the branch starts to
conflict, T3 Code wakes that thread, and Factory follows the agent's answer as a round of the
delivery: once the turn ends, the server verifies the branch again, a reviewer on a fresh thread
reviews it, and Factory records the approval and pushes the approved commit to the same pull
request. It does this even when the agent changed nothing, so the pull request only ever holds
verified, reviewed commits. Feedback that arrives during a round is followed too, once the agent
is done with the round or the pull request is open again. Checks that all pass start no round.
A single item's rounds count against the fix and review rounds the delivery has left, and a round
that fails or runs out of rounds blocks like any other; **Resume** verifies and reviews again
before pushing. Turns you send on the thread yourself are yours and start no round, and
cancelling the delivery leaves them running.

For a parent, each round is judged like its integration: the server verifies the whole branch, a
reviewer on a new thread checks every change since the branch started against every child's
acceptance criteria, and Factory pushes the approved commit to the parent's one pull request. The
children stay approved. A failed verify or a review that requires changes blocks the parent with
no repair round. Fix the branch if needed, then **Resume** to check the branch, verify it and
review it again with a new reviewer before pushing. If you delete the thread the pull request is
linked to, the parent blocks, and resuming it blocks again.

If T3 Code stops watching the pull request, because it cannot read it from the host or after too
many comment-only updates, or cannot start watching it, as on a thread you settled, the delivery
blocks: Factory no longer hears of its feedback. **Resume** watches it again; unsettle the thread
first if you settled it. Cancelling the delivery stops the watch Factory started and the
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
  limits it started with, unless you reviewed it, which keeps counting. If you deleted one of its threads, it blocks again; cancel it and
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
  already started finishes, but no longer changes the delivery. A pull request stays open on its
  host. Delivering the item again starts a new delivery on a branch of its own, named like the
  first with `-2`, `-3` and so on added.

A delivery that is done or cancelled does not reopen: deliver the item again instead. Where a control
is not offered, the section says why, such as a lost connection or a session without the permission.

## When a delivery needs you

A delivery needs you when it is **Blocked** or **Waiting for you**. The item's Factory section
highlights its status and shows the reason, such as verify still failing with no fix round left,
a review still requiring changes with no review round left, the same failure after a repair, or
code that changed during review. Fix what it names if needed, then **Resume**, or **Cancel
delivery**.

To see what needs you everywhere at once, open **Factory** from the sidebar or the command palette
on web and desktop, or on mobile tap **Factory** in the threads header (iOS) or toolbar (Android).
It lists the active deliveries of every connected server that offers Factory, across projects, with
those that need you first and the reason each one waits. A server that offers Factory but is not
connected is named instead, and its deliveries return once it reconnects. Opening one takes you to
its item in Work, where you resume or cancel it.

Factory also posts one comment on the Work item each time a delivery becomes blocked or starts
waiting, so the GitHub issue, Jira issue or task file shows it too. It posts again when a commit
is approved, when the pull request opens or a feedback round updates it, and when it is closed
without merging. Factory sends no notifications.

## What Factory will publish

A new delivery works on a branch named `feature/<item key>-<title>`, with any AI tool's name left out.
Its pull request gets a short Conventional title such as `feat(export): fd-7k3qa2 Add the export
button`: the type and scope come from its commits, the summary from the item's title, shortened
between words and never inside one. Its Work item stays as you wrote it.

Before every push and pull request, feedback rounds included, Factory checks the branch's prefix
(`feature/`, `bugfix/`, `chore/` or `docs/`), the name the push would give it on the remote, each
commit's message and identities, and the title and body. Git can push a branch under a shorter name:
with a remote called `feature`, or an upstream that renames it, `feature/x` lands as `x`. Factory
checks the name it lands on, and pushes only there, to the push URLs it checked, which takes Git 2.46
or later on the environment that runs the project: with an older Git it pushes nothing and the
delivery blocks. The check covers every
commit of the delivery, pushed or not, and any earlier commit the push would be the first to put on
the remote; history the remote already holds is left alone. It refuses
malformed subjects, AI tool names and generated attribution, including a trailer a commit hook added.
Human co-authors, sign-offs and task references are fine. If something fails, nothing is pushed and
the delivery blocks, saying what failed and what to do. Factory never rewrites a commit or renames a
branch:

- **A commit** that fails: correct it on the branch, or cancel and deliver the item again, then
  **Resume**.
- **A commit from before the delivery** that fails, which the branch it started from holds and the
  remote does not: correct it on that branch, or put the project's checkout on a commit the remote
  already holds, then cancel and deliver the item again.
- **The remote** that cannot be read: Factory cannot tell what a push would add. Check the branch's
  remote and your access to it, then **Resume**.
- **The name on the remote** that fails: rename the remote whose name starts the branch's, or remove
  the upstream that renames it, so a push keeps the branch's name, then **Resume**.
- **Where the push goes** changed after the check, such as the remote's push URL or a URL rewrite in
  your Git settings: Factory pushes nowhere it did not check, whatever your settings say by then, and
  stops before the pull request. Keep or restore where the branch should publish, then **Resume**,
  which checks that destination again before pushing.
- **Git** on the environment that runs the project cannot hold the push to the URLs Factory checked:
  update it there to 2.46 or later, then **Resume**.
- **The title or body** that fails: change the item or the verify command, then **Resume**. A title
  whose first word is too long to fit, such as a long address, needs a shorter opening.
- **A delivery from before this check**, on a `work/...` branch: it can no longer publish. Its branch,
  pull request and commits stay as they are; cancel it and deliver the item again.

Once a pull request is open, Factory reads what the host saved. If the title, body or branch is not
what it should be, or the host cannot be read, the delivery blocks with the pull request recorded.
Factory edits nothing there: correct it on the host, then **Resume**, which checks it again before
pushing anything else.

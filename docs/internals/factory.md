# Factory

The fork's Factory module (`fd` feature `factory`) takes a Work item through a pipeline of stages
on real threads. Server code is in `apps/server/src/fd/factory/`; contracts are only reachable
through `@t3tools/contracts/fd/factory`. Terms are defined in the [glossary](./glossary.md#factory).

## The engine is pure

[`advance`](../../apps/server/src/fd/factory/pipeline/engine.ts) folds one event into a delivery
and returns the effects to perform; [`FactoryWorker`](../../apps/server/src/fd/factory/FactoryWorker.ts)
performs them and feeds the results back as events. The engine takes no services, I/O or clock
and never mutates its input, so a delivery's events replay to the same state and every transition
is tested without threads or Git. An event that does not answer what the delivery awaits changes
nothing, so a late or repeated event is harmless. Keep decisions in the engine and I/O in the
worker.

## Own migration ledger

Factory owns its `fd_factory_*` tables and its own `fd_factory_migrations` ledger, migrated after
core, for the reason [Work keeps one](./work-management.md#migration-ledger). Effect's migrator
compares ids only and skips every id up to the highest recorded, so ids are only ever appended. A
ledger that recorded a different name under an id is refused rather than silently left on an older
schema (see [`FactoryMigrations.ts`](../../apps/server/src/fd/factory/persistence/FactoryMigrations.ts)).

## Evidence stays out of the repository

Verify logs and receipts go to `<T3 home>/userdata/fd-factory/<deliveryId>/`, the server's state
directory, through [`FactoryEvidence`](../../apps/server/src/fd/factory/verify/FactoryEvidence.ts).
In the worktree an agent could edit it, and writing it would dirty the tree a receipt must find
clean.

## One worktree per delivery

The first thread of a delivery launches on a new worktree and branch; every later thread reuses
that worktree, so one branch carries the delivery's commits and becomes its one PR. Settle checks
judge only commits after the task baseline, which is set once. For the first thread (a single
item's author, a parent's planner) it is the branch's creation entry in its reflog, because
preparation creates the worktree after the launch returns, from whatever the base ref names by
then: a commit resolved before the launch can be stale. Without a reflog, that commit stands only
while HEAD has not moved, and otherwise the launch fails rather than guessing. See
[`FactoryThreadEffects.ts`](../../apps/server/src/fd/factory/FactoryThreadEffects.ts) and
[`settle.ts`](../../apps/server/src/fd/factory/git/settle.ts).

A parent's children share its worktree and branch, and each child's baseline is assigned when its
parent starts it: where the parent's branch started for the first child, and the commit the task
before it was approved for (its `lastReviewedSha`) after that. Not the HEAD its author finds: a
commit made while the plan waits at the gate, or between two children, is then judged by the next
child's settle check and review instead of passing into the branch unreviewed. A parent stored
before planner launches recorded where its branch started has it read from its branch's reflog
at its next child start, and keeps it. A first child an earlier server already started counts only
if it started there: that server took HEAD, and the child's review then missed the commits before
it. A reflog that no longer holds the creation, or a first child started elsewhere, refuses the
start, and the parent blocks rather than record a later commit as its base. Such a parent takes no
child's approval before it has that commit either: the engine has it take the child's start again
first, so a one-child plan cannot leave its children with the base unknown.

## A delivery's launches stay under its starter's mode

A start can carry a runtime-mode ceiling, which the delivery keeps; an agent's start passes its own
mode, like Work's thread starts (see [agent grants](./work-management.md#agent-grants)). Nothing
downstream checks a launch against its caller, so Factory applies the ceiling itself, at every
launch, a resume's replay included: the narrower of it and the project's default at that moment.
Storing the mode resolved at start instead would let a later launch outrun a default the owner has
narrowed since. The thread's mode alone is not enough: the server runs a mode a provider does not
offer as one it does, and without approval-required that can be broader
([`RuntimePolicy.ts`](../../apps/server/src/orchestration-v2/RuntimePolicy.ts)). So a capped launch
asks only for a mode its provider advertises, read from the instance registry as that policy reads
it, stepping down to the broadest within the bound, and fails before anything runs when none is.
The ceiling bounds launches only; a turn on an existing thread runs in the mode the thread has,
which its owner may change.

## Agents start deliveries with Work's grant

`factory_deliver` starts threads, so it takes the grant Work gives an agent for starting threads
([agent grants](./work-management.md#agent-grants), `actorFromCaller`): a read-only client or a
plan-mode thread only reads, and a thread caller acts only while its run is live. With a rule of
its own, a thread that `work_start_thread` refuses could start threads for the same item through
Factory. The caller's runtime mode becomes the delivery's ceiling. `factory_submit_review` and
`factory_submit_plan` are the exceptions: reviewers and planners work in plan mode by design, and
each tool records only the calling thread's own review or plan, so it checks instead that the
caller is the delivery's registered reviewer or planner
([`mcp/handlers.ts`](../../apps/server/src/fd/factory/mcp/handlers.ts)).

## Work never imports Factory

Work decides what to build and Factory decides how, so Work stays complete without Factory: the
dependency runs one way. Factory reaches Work only through Work's entries,
[`work-management/index.ts`](../../apps/server/src/fd/work-management/index.ts) and
`@t3tools/contracts/fd/work-management`, and the [boundary check](../../scripts/fd/check-boundaries.ts)
rejects imports of Work's private files. How Work treats Factory-origin links is in
[Work management](./work-management.md#links-live-in-work-not-on-the-thread).

## Contracts never import orchestration

Core's `environment.ts` imports the Factory contracts entry for its capability, as it imports
Work's, which Factory contracts import too. A Factory contract that imported `orchestrationV2.ts`,
`project.ts`, `environment.ts` or the root barrel would close the module-load cycle described in
[Work's contracts](./work-management.md#contracts-never-import-orchestration). Factory declares its
own literals and the server maps them;
[`imports.test.ts`](../../packages/contracts/src/fd/factory/imports.test.ts) locks this, and loads
the root barrel, `environment.ts` and the entry first in fresh Node processes for the reason below.

## Vitest hides native ESM cycles

Vitest's module runner tolerates import cycles that native ESM rejects while initializing a module.
Tests, typecheck and lint all passed while the server failed to load Factory's entry.
[`entry.test.ts`](../../apps/server/src/fd/factory/entry.test.ts) loads each Factory module that
another entry might import first, alone, in a fresh Node process. Core's runtime layer cannot be
the first module of its cycle to load, which is why
[`index.ts`](../../apps/server/src/fd/factory/index.ts) imports it last. Add a module to that test
when another entry starts importing it.

## Clients refetch on a change epoch

Clients follow `factory.deliveries.subscribe`, an epoch like Work's refresh epoch, and refetch the
deliveries and settings they show on each value; the stream itself carries no data. Every Factory
write therefore runs through `FactoryChanges.transact`
([`FactoryChanges.ts`](../../apps/server/src/fd/factory/FactoryChanges.ts)), which moves the epoch
only once the write has committed, so a refetch on the new value reads it. Today the writers are
the start's insert, the worker's step (stop, resume, cancel, plan and review submissions and the
plan gate's actions are steps), the child deliveries a parent's approval stores and the settings
write; a new writer that bypasses `transact` leaves every client stale until something else moves
the epoch.

`transact` opens the transaction itself rather than wrap a caller's. `withTransaction` commits
inside its own uninterruptible mask and raises an interrupt that arrived meanwhile as the mask
ends, so an effect wrapped around it sees an interrupted exit for a write that committed, and
would skip the move. Inside `transact`'s mask the write is restored to interruptible, and the
commit and the move run before any held-off interrupt.

## The reactor tail starts at the sweep's position

[`FactoryReactor`](../../apps/server/src/fd/factory/FactoryReactor.ts) reads the event log's latest
sequence before its boot sweep and tails the log after that sequence. A live domain-event stream
takes its position only when first pulled, so a sweep that ran before the subscription could miss
a run that ended in between, leaving its delivery waiting forever.

## Receipts are refused when verify changes the checkout

A receipt records one commit and tree. When the verify command moves HEAD or leaves the tree dirty,
the result no longer describes the recorded commit, so
[`FactoryVerifyRunner`](../../apps/server/src/fd/factory/verify/FactoryVerifyRunner.ts) refuses it,
keeps the log for diagnosis, and the delivery blocks. A tree that is dirty before the run is
refused without running.

## At most one active delivery per item

An item may have only one delivery that is not done or cancelled; a new one is allowed once the
previous delivery is terminal (operator decision). Two active deliveries of one item would race
each other on the item's status. A partial unique index enforces it in the insert's transaction,
so of two concurrent starts only one is stored (see
[`FactoryDeliveryStore.ts`](../../apps/server/src/fd/factory/persistence/FactoryDeliveryStore.ts)).
Item ids must be in Work's canonical spelling, or one item could hold two active deliveries. A new
terminal status needs a new index migration.

A new delivery starts over on a branch and worktree of its own (owner decision): the branch Work's
thread starts would name, or the first of `-2`, `-3`, … after it that no earlier delivery of the
item recorded and no ref in the repository holds
([`freshBranch.ts`](../../apps/server/src/fd/factory/git/freshBranch.ts)). The recorded names
matter as much as the refs: a delivery cancelled while its launch was preparing creates its branch
after the next start has looked. A cancelled or finished delivery keeps its branch, worktree and
commits; continuing that work is a resume of that delivery, never a new one. A repository Git
cannot read is left to the launch to report, as `checkWorktreeBase` leaves a base it cannot
resolve. A repository with no commit yet is refused at start, though: core launches a thread there
without a worktree and its base check lets `HEAD` through, so Factory reads HEAD itself
([`headCommit.ts`](../../apps/server/src/fd/factory/git/headCommit.ts)). Starts of one item are
serialized in-process from reading its earlier deliveries to storing the new one, as Work's thread
starts are: a delivery stored and cancelled in between would free the active-item index and leave
both deliveries on one name.

## A review judges the verified commit

A passing receipt starts the review stage, and every review is judged against the commit and tree
that receipt recorded. A submission made after HEAD moved, or with a dirty worktree, is refused and
the delivery blocks rather than retrying: the reviewer works read-only in plan mode, so a changed
commit means the review describes code no receipt covers. The reviewer's launch leaves the task
baseline alone; settle checks keep judging the author's commits after it. See
[`FactoryReview.ts`](../../apps/server/src/fd/factory/FactoryReview.ts).

Deliveries a Phase 1 server stopped at their verified checkpoint load without review fields or a
recorded checkpoint and stay `stopped` at `verify`; nothing moves them on its own, and a resume
verifies them again.

## One accepted review per round, acted on when the run ends

A `factory_submit_review` call arrives while the reviewer's turn is still running. It is judged and
recorded under the delivery's step lock
([`FactoryWorker.stepWith`](../../apps/server/src/fd/factory/FactoryWorker.ts)), so the run's end
cannot land between the checks that admit it and the record. The accepted review waits for the run
to complete: a run that fails after submitting still blocks as a failed run, and the reviewer's turn
is never cut short. A run that completes without one has the fenced JSON of its last assistant
message judged the same way, for providers without t3 tools. The first invalid submission in a
round, on either path, is answered once (by the tool's failure in the same turn, or a retry turn on
the reviewer thread); the second blocks. A planner's plan follows the same rules in each plan round.
It is taken only while the planner thread is live in the very run the delivery awaits, read under
the lock: a tool call names its thread, not its run, and a turn queued behind the planner's run can
start before that run's end reaches the delivery; that turn's plan must not stand as the earlier
run's ([`FactoryService.submitPlan`](../../apps/server/src/fd/factory/FactoryService.ts)).

## The owner's plan edit lives in the state, not the evidence

At the plan gate the owner edits, rejects or replans the plan, each decided under the delivery's
step lock on the plan stored then, and refused anywhere but the gate
([`FactoryService.ts`](../../apps/server/src/fd/factory/FactoryService.ts)). By owner decision an
edit may change only the tasks' titles, summaries, criteria and test plans, their order and which
stay, and must pass the planner's validator; ids, kinds, likely paths, risk and the note stay the
planner's ([`plan/edit.ts`](../../apps/server/src/fd/factory/plan/edit.ts)). The RPC payloads carry
the edited plan as any value and the replan note as any string: the RPC server turns a payload
that fails decoding into a defect before any handler runs, so the server judges both itself and a
malformed one is refused as `invalid_request` with Factory's fixed text. Its `fields` name where
the problems are, as a recorded task's id and the client draft's field, never what they say: the
validator's descriptions quote the owner's text, so the client words each field itself. The edit
replaces the tasks in the delivery's state while `plan.json` keeps what the planner submitted, so
approval freezes the state's tasks, stored as the delivery's task rows in the step that approves. A
replan is a new plan round opened by a turn carrying the owner's note; the gate's attempt it leaves
ends failed, and the next accepted plan replaces the old.

## Child items are found again before they are created

Approval runs child creation as a worker effect
([`FactoryChildren`](../../apps/server/src/fd/factory/FactoryChildren.ts)): one item per task in
the parent's Markdown source, under the parent, then a field-only update making it blocked by the
previous task's child, since Work's create takes no dependency. Neither write is idempotent across
a restart: Work replays a `clientRequestId` only from memory. So each child is recorded on its task
before the next is created, and each task is claimed before its create, as Work comments are. Only
a claimed task without a record can have a child from a run that stopped between the create and
the record. Its body opens with a reference naming the delivery and task
([`plan/childItem.ts`](../../apps/server/src/fd/factory/plan/childItem.ts)); the next run searches
the source for it and takes only an item under the parent whose body holds it exactly. It opens
the body because Markdown's search indexes a bounded prefix that starts with the title.

A miss proves nothing by itself. Work's lists are paged and can be stale, and a file Markdown
cannot read or decode is listed as invalid with no body for a search to match, so it could be the
child. The run takes a miss as absence only when it read every page of the source and none lists
an invalid item; otherwise, or when two items carry the reference, the effect fails instead of
creating one or picking one, since either guess could duplicate a child or chain the wrong
dependency. An unclaimed task never looks, so a broken file elsewhere holds back only a recovery.

Nothing of a task is cut or changed to fit its source. Markdown refuses a file with a line that
reads as a merge conflict marker, so such a line of the task's text gets a backslash first, which
Markdown renders as the same text. Whether the source can store a child as written is judged at
the gate, while the owner can still edit the plan, by the source's own render through Work's
`canWriteMarkdownItem`, not by a copy of its rules in Factory: a copy misses cases, such as half a
surrogate pair, which plan validation accepts and JSON storage keeps, and a plan frozen with one
blocks every resume. A body past Work's bound is refused there too.

The children's deliveries are stored only once every child exists, under ids derived from the
parent and task, in one transaction that first checks the parent still awaits the effect, so a
parent cancelled meanwhile queues none. The Work items an effect wrote after a cancel stay, as the
server's other effects do.

## A parent runs one child at a time

Children of one parent share its branch and worktree, so they run in plan order, one at a time
(owner decision). The parent waits on one child and starts the next only once that child reports
its approval. It records each child that reported one (`approvedChildren`), so a resume starts
the next child rather than one that is done. A child runs a single item's stages with its
own limits and fingerprints but ends `approved` at record: the parent's one pull request carries
its work. Plan approval stored children as single items before the `child` kind existed, and a
single item opens its own pull request, so the store reads any delivery with a parent as a child
([`FactoryDeliveryStore.ts`](../../apps/server/src/fd/factory/persistence/FactoryDeliveryStore.ts)).
A child's record approves its task in the parent, where the next child, integrate and the pull
request read the approved commit. A child that blocks blocks alone: the parent keeps waiting for
it, and the owner resumes the child.

The worker starts a child under the parent's lock, and only while the parent still awaits that
start, so a cancelled parent starts none. The child's start commits before the parent stores the
result, so the child can run, even to its approval, before its parent waits for it: the parent
takes an approval stored by then as it takes the start, and the boot sweep takes a start a
restart kept from the parent, with that approval, rather than block on the lost effect.

A parent's cancel cancels its children that are not approved, and by owner decision a child's own
cancel cancels its parent, so its unfinished siblings too; each stops what its threads run, and
approved children keep their approvals. Each delivery's cancel is its own commit, so the boot
sweep completes a cancellation a restart cut short between a parent and its children before
anything else moves them.

A cancel's interrupts are sent after it commits, and a server that stops in between leaves its
agent working until core's restart recovery cuts the turn. With continue-after-restart on, core
then carries the turn on in a new run on the same thread
([`RestartContinuation.ts`](../../apps/server/src/orchestration-v2/RestartContinuation.ts)), which
the cancelled delivery never takes. Core skips only runs whose interrupt it recorded, and once
recovery has ended the run, an interrupt no longer records one. So Factory stops the
continuation itself: a run going live on a thread a Factory launch made (its id names the
delivery) is interrupted when that delivery is cancelled and the run carries on a turn Factory
sent, judged by the message that began the chain of continuations. The reactor checks as runs go
live, and the boot sweep checks the runs already live. The owner's own turns on such a thread
are theirs, and a launch still preparing its workspace is left to the late-launch interrupt, so a
cancelled launch still makes its branch and worktree. The worker takes a parent's lock before a child's, never the other way:
a child's approval or cancel reaches its parent only once the child's step has released its lock
([`FactoryWorker.ts`](../../apps/server/src/fd/factory/FactoryWorker.ts)). An approval stored
while no server handed it on is handed on by the boot sweep, once, since the parent then waits for
its next child.

## Integrate verifies and reviews the whole branch afresh

After its last child's approval a parent verifies its worktree's HEAD into a receipt of its own,
never taking a child's: each child's receipt is for its own commit, and nothing else judges the
tasks together. A passing receipt launches a new reviewer thread on the shared worktree, never a
turn on a child's reviewer or an earlier integrate's, so the review starts from none of their
accounts. It reviews the branch from where it started (the parent's baseline) by every approved
task's criteria, numbered across the tasks in plan order, and its acceptance list has room for each
criterion of the largest plan (`FactoryIntegrateReview`), which a task's review does not. Its
submissions are judged like a review's, and taken only from the run the parent awaits, as a plan
is (see [one accepted review per round](#one-accepted-review-per-round-acted-on-when-the-run-ends)).

Integrate has no repair round (owner decision): a parent has no author thread of its own and its
children are approved, so a failed verify or a blocking review blocks the parent for its owner. A
passing review enters [record](#record-checks-the-worktree-again), as a task's does. A resume
verifies and reviews again, with a new reviewer, so whatever was committed meanwhile is judged
with the rest.

## Clients see a review's details as it was accepted

Snapshots are built on every read and never read evidence, so what clients see of a review's
findings, unverified criteria and missing evidence is projected once, when the review is accepted
([`review/details.ts`](../../apps/server/src/fd/factory/review/details.ts)), and stored beside its
summary: capped lists and truncated text, the rest counted. Blocks, the submit tool's reply and
the evidence file keep the summary without it. Reviews accepted before details existed have none,
and nothing backfills them. Stored state decodes with the contract's bounds, so they never shrink;
raising them makes older clients leave out the reviews that use the room.

## Repair rounds stop on limits and repeated failures

A failed verify or a blocking review becomes a repair turn on the author thread, then the branch is
settled and verified again. Each kind counts against its own limit, and a delivery keeps the limits
it started with, so changing the settings never moves a loop already running. A failure's
fingerprint hashes the stage, the log tail or the findings to fix, and the tree: a repair that left
the tree as it was, or changed it without changing the failure, stops the loop as a repeated
failure even with rounds left, because another round would face the same thing (see
[`fingerprint.ts`](../../apps/server/src/fd/factory/pipeline/fingerprint.ts)).

Only the first review round runs on a fresh thread that never sees the author's account. After a
fix-review, the next round is a turn on the same reviewer thread with its previous findings and the
author's reply, labelled as claims to check against the code. Turns of later rounds and of
high-risk tasks raise the effort of the model the thread runs with, only to a value its options
offer and never below what was chosen
([`effort.ts`](../../apps/server/src/fd/factory/pipeline/effort.ts)).

## Record checks the worktree again

Record is the gate the server passes on its own. It reads the worktree again instead of trusting
the review's check: a review is accepted while the reviewer's run is still going, and nothing
stops a commit or an edit in the shared worktree before that run ends. HEAD and its tree must be
the ones the last receipt recorded, HEAD must be the commit the accepted review judged, and the
worktree must be clean. Otherwise nothing is written and the delivery blocks, naming both commits.
Numbered verify and review evidence is never overwritten, but a task has one current approval: a
later approval of the task replaces its `approval-<taskId>.json` and `lastReviewedSha`. A single
item is its delivery's one task, written in the transaction that inserts the delivery; a child's
task is its parent's task it was created for, and its approval goes to the child's evidence. A
parent's tasks hold its children's approvals, so after integrate it approves its whole branch
with no task of its own: `approval.json` in its evidence, which its pull request reads for the
commit to publish. See [`FactoryRecord.ts`](../../apps/server/src/fd/factory/FactoryRecord.ts).

## Stop waits for a stage boundary; cancel does not

Stop after step is a status, not an interruption. A `stopping` delivery takes every event a running
one does, so the turn or effect under way finishes, and it becomes `stopped` only where the engine
would begin verify, a review round, a repair round, record, the PR stage, the plan gate, a parent's
next child or the stage after its children, with that stage as its checkpoint
([`engine.ts`](../../apps/server/src/fd/factory/pipeline/engine.ts)).
Work inside a stage is not a boundary: the settle check and its fix-commit turn, the fallback plan
and review reads, a plan or review submission and its retry. A failure found first still blocks,
because a stopped delivery would hide it, and so does an empty plan. Stopped where a repair round
would begin, the failure's fingerprint is recorded but no round is spent, and the stage's attempt
is recorded as failed. Only a running delivery can stop; an approved one is already in the last
stage it runs, and a stopping child approved at record has no stage left to stop before.

Cancel ends a delivery whatever it awaits, and by owner decision interrupts what its agents are
working on, through the thread's own interrupt. Every thread the delivery records is asked, not
only the one whose run it awaits: a review blocked by its submissions awaits nothing while the
reviewer's turn goes on. So is every thread its stage attempts name that no role records any more:
a resume after such a block in integrate launches a new reviewer, and the blocked one's turn may
still run. A run on such a retired thread is interrupted only while it carries on a turn Factory
sent, judged as for a [restart's continuation](#a-parent-runs-one-child-at-a-time): the owner may
have taken the thread over. A launch or turn being started when the cancel lands reports a run the
cancelled delivery never takes, so the worker interrupts that run as well
([`FactoryWorker.ts`](../../apps/server/src/fd/factory/FactoryWorker.ts)). The verify command and
the PR action belong to the server and are not stopped; their results change nothing. The worktree,
branch and commits stay, and a new delivery of the item works on a branch of its own (see
[one active delivery per item](#at-most-one-active-delivery-per-item)).

Both actions check the status and step under the delivery's lock, like a review submission. The
boot sweep keys on what a delivery awaits, not on its status: a stopping delivery whose run ended
while no server ran stops where the run's end leads it, as the live tail would have taken it there.

## Resume trusts only what it reads again

Resume is Looper's `--finish`. A `stopping` delivery just runs on. A stopped or blocked one is
judged under its step lock from what the resume reads at that moment: whether its threads still
exist, the settle check of its branch, HEAD and its tree, and its task's approval. A settled branch
is verified again even when the last receipt names the same commit, because a stop or block can
last any time and the command, settings or machine may have changed since; review follows by the
usual round rules, and the author gets no new turn. Only a delivery resuming the PR stage on
exactly its approved commit (the task's `lastReviewedSha`, with the last receipt's tree, on a
settled branch) opens its pull request without that. Any other unsettled branch gets one
fix-commit turn naming the checkpoint, an unrepairable one blocks, and a deleted thread of the
delivery blocks it again: a resume never launches a replacement for a thread the delivery recorded.
A resume that blocks keeps the checkpoint, so the next one still knows it stopped before `pr`.

A delivery with no author recorded is not proof that no author ran. A launch can go through and its
result still be lost, to a failed run read or a restart, leaving a thread at work on the branch the
launch created. So the engine records the author launch when it issues it (`authorLaunch`), not
when its result arrives, and a resume issues that same launch again: the launch derives its
command, thread and message ids from the effect, and replaying them returns that thread, run and
worktree instead of starting a second author whose `worktree add -b` would collide with the branch.
The record cannot live in the block, which the next block replaces: a resume that blocked on the
deleted thread of that launch would otherwise forget it, and the one after would launch anew.

What the resume found decides what the replay does. If the launch's run had already ended, however
it ended, no end is coming to await, so once the thread is recorded its branch is settled and
verified as a resume settles a recorded author's. A run still going is awaited like any other, and
its failure after the resume blocks. A thread that launch made and the owner deleted since blocks
every resume, like any deleted thread of the delivery.

A parent that stopped or blocked while planning resumes into planning, never into authoring.
Stopped before the plan gate, it waits there again on the same plan. Its planner launch is recorded
and replayed like an author's (`plannerLaunch`). A recorded planner gets one retry turn in a new
plan round, because a plan accepted before the block, from a run that failed after submitting,
must not stand in for what the resumed planner submits.
Once its plan is approved, a parent launches no thread until its children run, so its planner's
deletion does not hold it: a resume creates the children it lacks, keeping those recorded, or once
they exist starts the first that has not reported its approval, never creating one again. Past its
last child it integrates afresh (see [integrate](#integrate-verifies-and-reviews-the-whole-branch-afresh)).

By owner decision an explicit resume grants a fresh retry allowance: repair rounds, the fix-commit
turn and failure fingerprints start over, while the limits the delivery started with stay, and so
do its receipts, reviews, stage attempts and approval. The resumed stage gets a new attempt even
when its name has not changed: the reactor routes a run's end only to a thread's active attempt,
and the attempt the delivery stopped or blocked in has ended (see `recordAttempts` in
[`FactoryWorker.ts`](../../apps/server/src/fd/factory/FactoryWorker.ts)).

## The PR stage opens only the approved commit

An approved delivery other than a child is not at rest: it enters `pr` still `approved` and
becomes `pr_open` once the pull request is recorded. The engine takes only that result or the
effect's failure while approved, and the boot sweep blocks an approved delivery whose PR effect a
restart lost, as it does a running one; the action is never re-run on its own.

Factory passes the approved commit to `create_pr` as its expected commit. The stacked action then
refuses to start unless HEAD is that commit, and the push publishes that commit by its id rather
than HEAD: a commit made while the action runs stays local, and a remote branch the push would
rewind is refused. Without one, as for every other caller, the push publishes HEAD as it is when it
runs. [`FactoryPullRequest`](../../apps/server/src/fd/factory/FactoryPullRequest.ts) reads the
worktree again as its last step before the action, after the item read, and runs it only on the
approved commit with a clean tree. Afterwards it reads back the commit the branch's upstream holds,
so a pull request on any other commit is linked but never recorded as the delivery's.

The template names no AI agent, model or provider, but the item's title, link and the verify
command appear as written. Rendered text that breaks the name or attribution rules settle applies
to commits ([`publishedText.ts`](../../apps/server/src/fd/factory/git/publishedText.ts)) is never
published: the effect fails before anything is pushed, and the owner changes the item or the
command. The rules are Looper's, widened to every provider T3 runs, the well-known assistants and
model families, and co-authorship credited to an assistant. A name that is also an everyday
programming word counts only where it can only mean the product: its product forms, its domains,
a co-author line, or the capitalized name after a word of tool use. So a database cursor is not
the Cursor editor, and "Co-authored-by: Cursor" is refused.
No list names every tool; both checks read that one file, so extend it there.

Passing `threadId` to `GitWorkflowService.runStackedAction` does not link the pull request to the
thread; the stacked action's RPC handler in `ws.ts` does that afterwards. Factory calls the same
`linkCreatedPullRequest` itself, so the author thread shows the pull request as one it created.
A pull request step that reports no number and URL blocks rather than recording a pull request
Factory cannot name.

A parent opens the one pull request of its branch, for the commit its `approval.json` names, and
only while each child is approved for the commit its own task records. The body lists the whole
branch's verify and integrate review, then each child item in plan order with its key, title,
verified commit and review, read from Work as the parent's title is. A parent has no author thread,
so the pull request is linked to its last child's author. A child never reaches the PR stage, and
the PR stage refuses one.

Deliveries approved before the PR stage existed load without a pull request and stay `approved` at
`record`, awaiting nothing; nothing opens their pull request on its own.

## Follow-through reads the link core's sync stores

Factory never merges, and it never asks the host about its pull request. It learns of a merge or
close from the snapshot core's
[pull request sync](../../apps/server/src/orchestration-v2/PullRequestSyncReactor.ts) commits as
`thread.pull-request-link-updated`, on the thread the PR stage linked the pull request to: the
author's, or a parent's last child's author's. Merge notifications are not enough, since they
cover only merges run through the app, while the snapshot covers those and a merge on the host
alike. The event must name the delivery's pull request by number and URL; the same pull request
linked to another thread, or another on the author's, changes nothing. The boot sweep reads that
link from the projection for each `pr_open` delivery, for the reason the tail starts where it does
(see [the reactor tail](#the-reactor-tail-starts-at-the-sweeps-position)).

The trap is settlement. Core's sync stops reading the links of settled threads. Auto-settlement
leaves a thread with an open link alone, but its owner can settle it by hand, and a pull request
merged on the host after that reaches Factory only once the thread is unsettled, or a merge
through the app requests a sync. Factory does not keep its threads from being settled; that would
be a policy over the owner's threads.

A merge is closed out as a worker effect, while the delivery stays `pr_open`
([`FactoryPullRequest.ts`](../../apps/server/src/fd/factory/FactoryPullRequest.ts)): each child
item done in plan order, then the delivery's own, through Work under a Factory actor, then the
worktree removed through `GitWorkflowService.removeWorktree` from the project's checkout. The
branch stays. A failed close-out, or one a restart lost, blocks the delivery rather than end it
done with its items unchanged, and a resume runs all of it again. So each item is read first and
one already done is left alone: a retry must not set done twice, which Jira refuses when no
transition leads from Done to Done, and a Markdown write would restamp. Work's own writes move its
read cache on, so the retry reads what the earlier attempt set.

Removing the worktree is the one step that destroys anything, and a cancel keeps the checkout
(owner decision). The item writes can take long and run outside the delivery's lock, so a cancel
can be accepted meanwhile; the removal therefore runs under the lock, only while the delivery still
awaits that very close-out, and the result is stored in the same hold
([`FactoryWorker.ts`](../../apps/server/src/fd/factory/FactoryWorker.ts)). Items a close-out set
before the cancel stay set, as other effects' writes do. The worktree stays when it has changes,
when it is the project's checkout, and when a thread works in it: a run, run activity or
background tasks in it, the rule core's checkout coordination applies, which covers only shared
checkouts and branch changes. Git's own refusal covers only uncommitted changes, not an owner's
turn that has written nothing yet. A turn starting between that check and the removal is not
excluded; nothing in core leases a delivery's worktree.

The delivery records how its pull request left `open` (`pullRequest.outcome`), so a report of
either arriving later is inert, and a close's cancel is told apart from the owner's: only the close
announces itself on the item. A closed parent cancels as an owner's cancel does, so its approved
children keep their approvals; a merged parent's approved children are done once it is.

## Each transition posts one Work comment, from the step that stored it

A delivery's move into blocked, waiting, approved or pr_open, or into cancelled because its pull
request closed without merging, posts one comment on its item through
`WorkService.addComment`, so GitHub, Jira and Markdown sources show what needs the owner
([`comments.ts`](../../apps/server/src/fd/factory/pipeline/comments.ts) decides which and renders
it). The comment is recorded in the transaction that stores the transition, then queued, and
posting never changes the delivery: a failed post is logged, and the next transition comments
again. The poster is a Factory actor, not an agent's, so Work adds no attribution trailer. The text
is a fixed template; a fact that would name an AI tool, carry attribution or mention someone is
dropped, and the block reason's fixed text stays.

The trap is idempotence. Work replays a `clientRequestId` from memory, for a day, so the id cannot
stop a second post after a restart, and no source drops a repeated comment by itself. Factory
therefore never derives a comment from a status it reads back, only from the step that stored the
transition: a boot sweep that caught up on blocked deliveries would post again after every restart.
Each comment is claimed before its post and finished when the post returns, with nothing
interrupting the two, so a stopping server finishes a post it began. The boot sweep posts the
comments nobody claimed, which a process that stopped with them still queued leaves behind. A
comment claimed and never finished belongs to a process that died mid-post, so it may or may not
have reached the source. Every posted comment therefore ends with a reference naming its delivery
and number, and the sweep looks for that reference through the item's whole comment history with
`WorkService.findComment`: found, the comment is finished; missing, it is posted. The item's
ordinary read cannot answer this, since Work bounds it to 50 comments (Markdown keeps the oldest).
A lookup that fails leaves the comment unfinished for the next boot, never posted on a guess. The
reference also tells a later block apart from an earlier one with the same text
([`FactoryWorkComments.ts`](../../apps/server/src/fd/factory/FactoryWorkComments.ts)).

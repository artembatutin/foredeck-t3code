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
judge only commits after the task baseline. For the first thread the baseline is the branch's
creation entry in its reflog, because preparation creates the worktree after the launch returns,
from whatever the base ref names by then: a commit resolved before the launch can be stale.
Without a reflog, that commit stands only while HEAD has not moved, and otherwise the launch fails
rather than guessing. A later thread's baseline is the worktree's HEAD before its first turn. See
[`FactoryThreadEffects.ts`](../../apps/server/src/fd/factory/FactoryThreadEffects.ts) and
[`settle.ts`](../../apps/server/src/fd/factory/git/settle.ts).

## Work never imports Factory

Work decides what to build and Factory decides how, so Work stays complete without Factory: the
dependency runs one way. Factory reaches Work only through Work's entries,
[`work-management/index.ts`](../../apps/server/src/fd/work-management/index.ts) and
`@t3tools/contracts/fd/work-management`, and the [boundary check](../../scripts/fd/check-boundaries.ts)
rejects imports of Work's private files. How Work treats Factory-origin links is in
[Work management](./work-management.md#links-live-in-work-not-on-the-thread).

## Contracts never import orchestration

Factory contracts import Work's contracts entry, which core's `environment.ts` also imports. A
Factory contract that imported `orchestrationV2.ts`, `project.ts`, `environment.ts` or the root
barrel would close the module-load cycle described in
[Work's contracts](./work-management.md#contracts-never-import-orchestration). Factory declares its
own literals and the server maps them;
[`imports.test.ts`](../../packages/contracts/src/fd/factory/imports.test.ts) locks this.

## Vitest hides native ESM cycles

Vitest's module runner tolerates import cycles that native ESM rejects while initializing a module.
Tests, typecheck and lint all passed while the server failed to load Factory's entry.
[`entry.test.ts`](../../apps/server/src/fd/factory/entry.test.ts) loads each Factory module that
another entry might import first, alone, in a fresh Node process. Core's runtime layer cannot be
the first module of its cycle to load, which is why
[`index.ts`](../../apps/server/src/fd/factory/index.ts) imports it last. Add a module to that test
when another entry starts importing it.

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
previous delivery is terminal (operator decision). Two deliveries of one item would ask for the
same branch, which is named after the item, and race each other on the item's status. A partial unique index enforces it in the
insert's transaction, so of two concurrent starts only one is stored (see
[`FactoryDeliveryStore.ts`](../../apps/server/src/fd/factory/persistence/FactoryDeliveryStore.ts)).
Item ids must be in Work's canonical spelling, or one item could hold two active deliveries. A new
terminal status needs a new index migration.

## A review judges the verified commit

A passing receipt starts the review stage, and every review is judged against the commit and tree
that receipt recorded. A submission made after HEAD moved, or with a dirty worktree, is refused and
the delivery blocks rather than retrying: the reviewer works read-only in plan mode, so a changed
commit means the review describes code no receipt covers. The reviewer's launch leaves the task
baseline alone; settle checks keep judging the author's commits after it. See
[`FactoryReview.ts`](../../apps/server/src/fd/factory/FactoryReview.ts).

Deliveries a Phase 1 server stopped at their verified checkpoint load without review fields or a
recorded checkpoint and stay `stopped` at `verify`; nothing moves them on its own.

## One accepted review per round, acted on when the run ends

A `factory_submit_review` call arrives while the reviewer's turn is still running. It is judged and
recorded under the delivery's step lock
([`FactoryWorker.stepWith`](../../apps/server/src/fd/factory/FactoryWorker.ts)), so the run's end
cannot land between the checks that admit it and the record. The accepted review waits for the run
to complete: a run that fails after submitting still blocks as a failed run, and the reviewer's turn
is never cut short. A run that completes without one has the fenced JSON of its last assistant
message judged the same way, for providers without t3 tools. The first invalid submission in a
round, on either path, is answered once (by the tool's failure in the same turn, or a retry turn on
the reviewer thread); the second blocks.

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
item is its delivery's one task, written in the transaction that inserts the delivery. See
[`FactoryRecord.ts`](../../apps/server/src/fd/factory/FactoryRecord.ts).

## Stop waits for a stage boundary; cancel does not

Stop after step is a status, not an interruption. A `stopping` delivery takes every event a running
one does, so the turn or effect under way finishes, and it becomes `stopped` only where the engine
would begin verify, a review round, a repair round, record or the PR stage, with that stage as its
checkpoint ([`engine.ts`](../../apps/server/src/fd/factory/pipeline/engine.ts)). Work inside a
stage is not a boundary: the settle check and its fix-commit turn, the fallback review read, a
review submission and its retry. A failure found first still blocks, because a stopped delivery
would hide it. Stopped where a repair round would begin, the failure's fingerprint is recorded but
no round is spent, and the stage's attempt is recorded as failed. Only a running delivery can stop;
an approved one is already in the last stage it runs.

Cancel ends a delivery whatever it awaits, and by owner decision interrupts the run its agent is
working on, through the thread's own interrupt. A launch or turn being started when the cancel
lands reports a run the cancelled delivery never takes, so the worker interrupts that run as well
([`FactoryWorker.ts`](../../apps/server/src/fd/factory/FactoryWorker.ts)). The verify command and
the PR action belong to the server and are not stopped; their results change nothing. The worktree,
branch and commits stay. A new delivery of the item may start, but its author asks for a new
worktree on the item's branch, which the cancelled delivery's worktree still has checked out, so
the launch fails and the new delivery blocks. What a re-delivery should do with the kept worktree
is not decided yet.

Both actions check the status and step under the delivery's lock, like a review submission. The
boot sweep keys on what a delivery awaits, not on its status: a stopping delivery whose run ended
while no server ran stops where the run's end leads it, as the live tail would have taken it there.

## The PR stage opens only the approved commit

An approved delivery is not at rest: it enters `pr` still `approved` and becomes `pr_open` once
the pull request is recorded. The engine takes only that result or the effect's failure while
approved, and the boot sweep blocks an approved delivery whose PR effect a restart lost, as it does
a running one; the action is never re-run on its own.

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

Deliveries approved before the PR stage existed load without a pull request and stay `approved` at
`record`, awaiting nothing; nothing opens their pull request on its own.

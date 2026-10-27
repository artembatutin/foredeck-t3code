# Glossary

Terms whose meaning matters across T3 Code. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent cycle, a V2 run. Provider work can end before checkpoint and diff work settles. |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished.              |
| Event                   | A persisted fact produced by a command.                                                                   |
| Orchestrator            | The service that serializes commands and decides their events from current state, without I/O.            |
| Projection / read model | A persisted view of current state, committed in the same transaction as the events that change it.        |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                                  |
| Outbox effect           | Side-effect intent committed with the events, such as starting a provider turn or capturing a checkpoint. |
| Effect worker           | The worker that runs outbox effects after commit and feeds their results back as commands.                |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime T3 Code controls, such as Codex or Claude Code.                                            |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into T3 Code operations and events.                    |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

## Pull requests

| Term                 | Meaning                                                                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull request link    | A persisted thread association identified by host, repository, and number. Links can cross projects within an environment and carry a server-maintained snapshot.                        |
| Pull request sync    | The worker that refreshes each distinct linked review once per cadence and discovers native stack layers. Explicit refreshes and failed stack reads trigger another read.                |
| Current pull request | The link used by single-review controls and older clients. Open work takes precedence; a completed single chain points at its top layer. Unrelated terminal links use the latest update. |

## Work

| Term        | Meaning                                                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Work source | A configured place Work items come from in one project: a Markdown task folder, a GitHub repository or a Jira project.        |
| Work item   | One task, issue or ticket from a Work source, identified by its source and the source's own key.                              |
| Work link   | A Work-owned association between a Work item and a thread, with a snapshot of the item at link time and the last run outcome. |
| Revision    | An item's opaque version token. Title and body writes carry the revision they were based on and fail as stale otherwise.      |

## Factory

| Term                 | Meaning                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery             | One Factory run of one Work item through a pipeline. A parent delivery owns one child delivery per approved planned task.                                                              |
| Parent delivery      | A delivery that plans a Markdown Work item into tasks, runs their child deliveries in order on one branch, then integrates them for one pull request.                                  |
| Child delivery       | The delivery of one approved task of a parent. It shares the parent's worktree and branch and ends approved without publishing its own pull request.                                   |
| Planned task         | One unit of an approved plan, with a stable id, acceptance criteria, a test plan and risk. Its `lastReviewedSha` records the commit approved for it.                                   |
| Pipeline             | Ordered stages with their gates and limits, defined as data.                                                                                                                           |
| Stage                | A named step of a delivery, such as `author`, `verify`, `review` or `record`. A stage can have several attempts.                                                                       |
| Stage kind           | What a stage does: run a role's thread (`agent`), run a server command (`command`), wait at a `gate`, verify and review the whole branch afresh (`integrate`) or handle the PR (`pr`). |
| Stage attempt        | One recorded execution of a stage, with its thread or run when applicable, outcome and evidence reference. Resume preserves earlier attempts.                                          |
| Role / role profile  | A thread's part (`planner`, `author` or `reviewer`) and the model selection used for that part: provider instance, model and options.                                                  |
| Plan gate            | The `approve_plan` stage where the owner may edit, approve, reject or request a new plan. Approval freezes the tasks before their child items are created.                             |
| Canonical checkout   | The project's `workspaceRoot`, where Work reads Markdown sources and Factory reads prompt overrides; separate from a delivery's worktree.                                              |
| Prompt override      | A project file that replaces one prompt's rules while leaving its server-owned facts, structured fields and submission instructions fixed.                                             |
| Task baseline        | The commit from which settle checks and task reviews judge new work. Initially the branch creation commit; later children start from the previous child's approved commit.             |
| Settle check         | The branch check after an author or repair turn and on resume: expected branch, clean worktree, baseline ancestry, new commits and commit message and identity policy.                 |
| Fix-commit turn      | The single mechanical author turn allowed to repair a settle check before blocking; it uses medium effort when supported.                                                              |
| Receipt              | The server's record of one verification command run against one commit and tree.                                                                                                       |
| Approval             | The record that one commit and tree passed verification and review.                                                                                                                    |
| Blocking severity    | A finding severity in the project's `blockingSeverities`, requiring changes even with a passing verdict. High is the default; other review blockers apply independently.               |
| High-risk effort     | The project's `highRiskEffort` target for high-risk tasks and later repair or review rounds, applied only when offered and never to lower an existing effort.                          |
| Review round         | One review of a verified commit. The first uses a fresh reviewer thread; later rounds on that thread check the prior findings and the author's repair claims.                          |
| Repair round         | A turn on the author thread that answers a failed verify (`fix-verify`) or a blocking review (`fix-review`), counted against the delivery's saved limits.                              |
| Failure fingerprint  | A hash of a failed stage, its log tail or findings to fix, and the tree. Repeating a fingerprint stops repairs; explicit resume from stopped or blocked clears that tracking.          |
| Follow-through round | A pull request feedback wake on the linked author thread that Factory adopts, followed by settle, fresh verify, review, record and a push to the same pull request.                    |
| Stage checkpoint     | The stage a stopped delivery would have begun when it stopped, where a resume continues. Unrelated to a turn's Git checkpoint.                                                         |

## Composer context

| Term                 | Meaning                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Context record       | The typed payload behind a composer chip, keyed by `contextId` in `message.context.records`. It never holds bytes.                  |
| Context reference    | One occurrence of a record in message text: `[label](t3-context://v1/<kind>/<contextId>)`. Several references can share one record. |
| Attachment binding   | The link from an image or file record to its server-owned attachment. Its attachment ID can change without changing `contextId`.    |
| Attachment inventory | The ordered image records shown as thumbnails above the prose, including images with no inline references.                          |

See [composer context references](./composer-context-references.md) for the contract and lifecycle.

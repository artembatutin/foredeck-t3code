# Work management

The fork's Work module (`fd` feature `work-management`) lists items from Work
sources, lets every surface and agent act on them, and links them to threads.
Server code is in `apps/server/src/fd/work-management/`; contracts are only
reachable through `@t3tools/contracts/fd/work-management`.

## Contracts never import orchestration

`environment.ts` imports the Work contracts index for the capability,
`project.ts` imports `environment.ts`, and `orchestrationV2.ts` imports
`project.ts`. A Work contract that imported `orchestrationV2.ts`, `project.ts` or
`environment.ts` would close an ESM cycle that fails at module load. Work
therefore declares its own creation-source and workspace-strategy literals and
the server maps them. `imports.test.ts` locks this.

## Migration ledger

Work owns `fd_work_*` tables and its own `fd_work_migrations` ledger, migrated
after core. Core migration ids belong to upstream; a fork entry in the core
manifest would collide with upstream's next migration. Effect's migrator compares
ids only, so ledger entries are only ever appended. A ledger that recorded a
different name under an id is refused instead of skipped (see
`persistence/WorkMigrations.ts`).

## Links live in Work, not on the thread

Thread links are rows in `fd_work_thread_links`, never fields on the thread
shell, so core projections and upstream merges stay untouched. A link is written
before a thread launch so a concurrent start of the same item sees it, and starts
of one item are serialized in-process (one server owns a T3 home). A link whose
thread does not exist after `LAUNCH_GRACE_MS` is a crashed launch and is dropped.

The sync reactor drops links when their thread is deleted or settled and records
each linked run's terminal status, which is how a client knows to offer "Back to
todo?". Settling is the owner saying the thread is finished, so unsettling does
not bring the link back. A five-minute sweep reconciles what the live event tail
missed and refreshes link snapshots; nothing polls item lists.

## Canonical checkout

Markdown sources read and write only the project's primary checkout. A thread's
worktree has its own copy of the task files; edits there reach Work after the
branch merges. That is why started threads are told to change status and notes
through the `work_*` tools (which write the canonical copy) and to leave task
frontmatter alone in their worktree.

## Agent grants

MCP callers get Work grants from what they may change, in `mcp/actor.ts`: a
read-only client or a plan-mode thread reads; any other caller may also write
items and start threads. Thread starts from MCP pass the caller-ceilinged modes
from `McpToolAccess.startsThreads` through unchanged, because thread creation is
not re-checked against the caller downstream. Agent comments carry an
attribution trailer and disarm bot mentions, since they post under the owner's
credentials.

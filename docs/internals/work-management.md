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
shell, so core projections and upstream merges stay untouched. A link's thread
and item need not share a project: linking does not compare them, and the project
assistant's thread lives in the scratch project. An item's project is its source's,
so read it from the source, never from the thread. Item ids are
canonicalized per source kind (`model/itemId.ts`) before they key locks, caches
or link rows, because trackers accept several spellings of one item. A link is
written before a thread launch so a concurrent start of the same item sees it,
and starts of one item are serialized in-process (one server owns a T3 home).
While the launch runs, an in-memory reservation (`WorkService.reserveLaunch`)
marks the link live however long the launch takes; a launch that ends without a
thread removes its link. A link without a thread or a reservation is a launch
that died with the process and is dropped.

The sync reactor drops links when their thread is deleted, and on settlement the
links that existed when the thread settled, and records each linked run's
terminal status, which is how a client knows to offer "Mark done?" or "Back to
todo?". Factory-origin links (`origin: "factory"`) offer no reverse prompts,
because a Factory thread's run is one stage of a delivery, and the delivery, not
the thread, decides the item's status; Work stores the origin but never imports
Factory. Factory launches through `WorkService.linkLaunch`, which writes and
reserves the link before the launch like Work's own starts. A link written after
the launch would miss a run that ended first (preparation runs in the background):
the run tail finds no row, and the sweep ignores outcomes older than the link.
Settling is the owner saying the thread is finished, so
unsettling does not bring the link back. The thread event tail is live only: a
sweep at boot and every five minutes recovers outcomes committed while the
reactor was not listening, drops links the tail missed and refreshes the
displayed snapshot fields. Nothing polls item lists.

"Changed since the thread started" compares scope fingerprints, never revisions:
a revision moves for every comment, Markdown note, status and assignee, which is
what guards a write but says nothing of what the item asks for, so Factory's own
progress comments would otherwise read as changed requirements. A link stores its
fingerprint once when it is written, and the display refresh leaves it alone. A
link stored before fingerprints existed has none and never claims a change, since
nothing says what its thread saw. Each source takes the fingerprint from the whole
body, before cutting that for the wire: a bounded body cannot see an edit past the
cut, and a comment growing a Markdown task across the cap would flip its truncation
and read as a change. Everything that judges an item reads this one value, so a
capture and a delivery's opening see what a link does.

## Canonical checkout

Markdown sources read and write only the project's primary checkout. A thread's
worktree has its own copy of the task files; edits there reach Work after the
branch merges. That is why started threads are told to change status and notes
through the `work_*` tools (which write the canonical copy) and to leave task
frontmatter alone in their worktree.

## Comment lookups read the whole history

An item read returns a bounded list of the newest comments, so a comment missing from it may still
be there. `WorkService.findComment` pages through every comment instead, for a server module that must
tell whether a comment it may have posted landed, as Factory does after a crash. No transport
exposes it, so a full history never crosses the wire.

Its none must mean the comment is not there, since a caller posts on it. A lookup that cannot read
every comment fails instead: a Markdown file that does not decode as an item, or a Jira walk whose
offsets moved under it. Jira pages by offset, and a comment deleted between pages would hide one,
so each page after the first starts at the last comment read, and a walk that loses it starts over.

## Agent grants

MCP callers get Work grants from what they may change, in `mcp/actor.ts`: a
read-only client or a plan-mode thread reads; any other caller may also write
items and start threads. Thread starts from MCP pass the caller-ceilinged modes
from `McpToolAccess.startsThreads` through unchanged, because thread creation is
not re-checked against the caller downstream. Agent comments carry an
attribution trailer and disarm bot mentions, since they post under the owner's
credentials.

---
name: test-t3-app
description: Test T3 Code's web and desktop UI against isolated development state using the browser tools available in the current agent session. Use for browser verification, browser pairing recovery, and test fixtures. Use test-t3-mobile for native mobile verification.
---

# Test T3 web and desktop

Prefer T3's built-in Browser panel when its `preview_*` tools are available.
These tools require a live T3-hosted agent conversation; they are not standalone
packages that an external agent can install to obtain a T3 thread identity.
When they are absent or unavailable, use the current session's existing browser
or computer-use tools against the isolated app. Follow that tool's documented
interface. Do not treat missing T3 tools alone as a verification blocker.
If no usable browser tool is available, report that concrete limitation; do not
install a second automation stack unless the user requests it.

Browser or computer-use verification still needs user authorization under the
repository instructions. Existing authorization covers this fallback. For native
mobile testing, use [test-t3-mobile](../test-t3-mobile/SKILL.md).

## Start the app

Reuse this task's healthy dev server. Otherwise run `vp run dev` from the
repository root and retain its terminal session. Use the worktree's ignored
`.t3` state and read the actual ports and pairing URL from the dev-runner output.
Never run against `~/.t3/userdata` or set `VITE_HTTP_URL` or `VITE_WS_URL`.

Test with meaningful project and thread data. Read
[references/sqlite-fixtures.md](references/sqlite-fixtures.md) only when
inspecting or seeding SQLite. Stop the test server before direct fixture writes.

## Connect the browser

With T3 tools, call `preview_status`, then `preview_open` if the Browser panel is
closed. Navigate to the complete startup pairing URL once with
`preview_navigate`, then use `preview_snapshot` and T3's interaction tools.
If the token was consumed or expired, run `node apps/server/src/bin.ts pair`
for a fresh one, with the isolated server's explicit `--base-dir`. Keep using the same tab.

With another available browser tool, open the same isolated app and complete
its normal pairing flow. Use that tool's snapshots, interactions and screenshots.
Verify the current source is served; a production server may be serving an older
web build. If file watching prevents development startup, a scoped web build and
non-watching server are a valid fallback. A web pass does not verify desktop-only
IPC or physical microphone/audio behavior; state those limits explicitly.

## Verify and retain

Exercise the affected flow and capture the state that proves it works. Keep
the server, state, and panel available while the user inspects or iterates.
An assistant turn ending is not teardown. Stop only processes you started,
using retained terminal sessions or captured PIDs.

When sharing is requested, start with `vp run dev --share` and give the user
a fresh complete pairing URL that you have not consumed. Keep other credentials
out of screenshots, commits, and replies.

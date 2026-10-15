# foredeck-t3 development

The project is named **foredeck-t3**. This runbook governs development in
`artembatutin/foredeck-t3code`, tracking
`pingdotgg/t3code`. [AGENTS.md](../../AGENTS.md#foredeck-t3-fork-ownership) owns the
fork's contribution and attribution policy; `CLAUDE.md` delegates to it. Upstream's
contribution approval process applies when submitting work to upstream. Keep its
architecture, performance, compatibility, and verification guidance for fork work too.

## Branch roles

- `main`: our product and GitHub default branch, including all foredeck-t3 changes.
  Start task branches here and target fork pull requests here.
- `upstream/main`: remote-tracking reference for `pingdotgg/t3code`. Fetching updates
  this reference without changing our files or branches. No local mirror is needed.
- `origin/main`: the published main branch of our fork, `artembatutin/foredeck-t3code`.
- `feature/*`, `bugfix/*`, `chore/*`, `docs/*`: short-lived task branches. Rebase
  private work; preserve published history. Keep each change independently reviewable.

From a clean checkout, start an ordinary task with:

```sh
git fetch --no-tags origin
git switch main
git merge --ff-only origin/main
git switch -c feature/my-change
```

Use focused local checks and review their results before integration. Fork pull
requests target `main` in our repository. Hosted CI is disabled; upstream submissions
are a separate choice.
Use a merge commit for upstream update pull requests so upstream ancestry survives;
squashing or rebasing those updates loses the ancestry needed by later merges.

The foundation was based on `c814e51af2ba962c9291c9459ee64b4f57e0b5ce`.
The upstream commit audited during setup was
`e536bfd33bc3c351997141d93790df75eeded7b9`, two commits beyond that base.
These record the initial audit, not the current upstream tip or an application-wide
verification result. No ticket was assigned to the foundation work.

## Reproducible setup

Use the versions in [package.json](../../package.json) and
[pnpm-workspace.yaml](../../pnpm-workspace.yaml): Node `^24.13.1`, pnpm `11.10.0`,
and Vite+ `1.0.0` at the foundation base. The server package's broader runtime
engine range is not the contributor toolchain. Use Node 24 and a Vite+ installation
available on `PATH` (the [upstream installation instructions](../../README.md#install-vp)
describe installation). Check `node --version` and `vp --version` before installing.
No shell-profile modification or repository-local tool binary is required by the app.
If using an existing nonstandard tool installation, add its `bin` directory to
`PATH` in the current shell before changing directories. A directory-specific shell
function named `vp` is insufficient for setup's subprocesses or another checkout.

From a fresh clone:

```sh
git clone --branch main https://github.com/artembatutin/foredeck-t3code.git foredeck-t3
cd foredeck-t3
git remote add upstream https://github.com/pingdotgg/t3code.git
git config remote.pushDefault origin
vp i --frozen-lockfile
T3CODE_TELEMETRY_ENABLED=false vp run dev --home-dir "$PWD/.t3" --host 127.0.0.1
```

Do not substitute upstream installation commands (`npx t3`, install scripts,
Homebrew) for running this source tree: they install upstream binaries.

For a linked worktree, run from the primary checkout and choose an unused task name:

```sh
foredeck_primary=$(git rev-parse --show-toplevel)
git worktree add -b feature/my-change ../foredeck-my-change main
cd ../foredeck-my-change
T3CODE_PROJECT_ROOT="$foredeck_primary" node scripts/setup-worktree.ts
T3CODE_TELEMETRY_ENABLED=false vp run dev --home-dir "$PWD/.t3" --host 127.0.0.1
```

[t3.json](../../t3.json) runs the same setup action automatically when T3 creates
a worktree and supplies `T3CODE_PROJECT_ROOT`. The script installs with a frozen
lockfile, preserves existing real env files, links the primary checkout's `.env`
and `infra/relay/.env` if present, and warms the web dependency cache. A lockfile
mismatch must fail; deliberately regenerate the lockfile only for a dependency change.

The ignored `dev.command` and `.git/local-tools` in the original checkout are
machine-local conveniences, absent from clones. That launcher assumes `.git` is a
directory; linked worktrees have a `.git` file. Use the commands above. If inspecting
shared Git metadata, resolve it with `git rev-parse --path-format=absolute --git-common-dir`.
Do not copy tools or credentials into version control.

Start without env files for the ordinary cloud-disabled path. **Do not copy
`.env.example` wholesale**: it enables upstream production Clerk and relay services.
Root `.env.local` overrides `.env`, and inherited process values override both;
the setup action does not share `.env.local`. Inspect which settings are present
without printing secrets. A linked env file shares edits with the primary checkout;
use a real worktree env file for different settings. `T3CODE_DEV_AUTH_TOKEN` is an
optional reusable administrative credential, not required for startup. Follow the
[development runbook](development.md#reusable-dev-credential) before enabling it.

Always use the explicit `.t3` home above, including in the primary clone. Never
start against live `~/.t3/userdata`, symlink live data, or set `VITE_HTTP_URL` or
`VITE_WS_URL`. Copy realistic stopped-thread data only when a behavior test needs it,
using `vp run migrate-dev-db` with the dev server stopped. See
[test data](../../AGENTS.md#test-data). Startup prints a secret pairing URL; keep it
out of logs shared with others. No browser opens unless requested. Stop a foreground
run with Ctrl-C, or retain and stop only the process/session you started.

## Updating upstream

Published `main` contains our customizations. Merge upstream on a separate update
branch, test the result, and integrate it without rewriting history. Fetching alone
never replaces our changes. Do not reset `main` to upstream or use GitHub's discard
changes operation to synchronize this fork.

Run these steps in one shell, stopping on any failure. Substitute unique backup
and worktree names when resuming an existing attempt. Do not automatically stash,
reset, overwrite tags, or use a mirror push. Stop if a merge/rebase is already in
progress or any worktree involved has uncommitted work; preserve that work first.

### Inspect and save the old base

```sh
git status --short --branch
git worktree list
git branch -vv
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git remote get-url --all origin
git remote get-url --push --all origin
git remote get-url --all upstream
git remote get-url --push --all upstream
```

Verify that origin's fetch/push URLs identify `artembatutin/foredeck-t3code` and
upstream identifies `pingdotgg/t3code` (HTTPS and SSH forms are equivalent).
Inspect every URL; stop on an unexpected identity. Never push to upstream here.
Synchronize our local main with the fork, then record the old upstream base before
fetching upstream so a moving remote-tracking ref cannot change the old range:

```sh
git fetch --no-tags origin
git switch main
git merge --ff-only origin/main
git log --left-right --oneline main...origin/main
test "$(git rev-parse main)" = "$(git rev-parse origin/main)"
foredeck_old_tip=$(git rev-parse main)
foredeck_old_base=$(git merge-base main upstream/main)
foredeck_stamp=$(date -u +%Y%m%dT%H%M%SZ)
git branch --no-track "backup/main-$foredeck_stamp" "$foredeck_old_tip"
git branch --no-track "backup/upstream-base-$foredeck_stamp" "$foredeck_old_base"
git fetch --no-tags upstream refs/heads/main:refs/remotes/upstream/main
foredeck_new_base=$(git rev-parse upstream/main)
git merge-base --is-ancestor "$foredeck_old_base" "$foredeck_new_base"
git log --oneline "$foredeck_old_base..$foredeck_new_base"
git diff --stat "$foredeck_old_base" "$foredeck_new_base"
git diff "$foredeck_old_base" "$foredeck_new_base" -- AGENTS.md CLAUDE.md CONTRIBUTING.md \
  .agents .github docs packages/contracts apps/server/src/persistence \
  apps/server/src/orchestration-v2 package.json pnpm-workspace.yaml pnpm-lock.yaml \
  patches apps/mobile/deps apps/mobile/app.config.ts apps/mobile/eas.json \
  scripts t3.json native
```

Stop and reconcile if local main has unpublished or divergent work. Follow changed
contracts to their server and client consumers. Review replay and migration changes,
provider SDKs, native archives, build tools, hooks, and new publishing workflows.
Re-read applicable nested instructions. If upstream rewrote history or the chosen
base does not bound the intended changes, investigate; do not force the fetch.
If `upstream/main` is already an ancestor of `main`, there is nothing to integrate.

### Rehearse the merge in an isolated worktree

```sh
foredeck_update="chore/upstream-update-$foredeck_stamp"
foredeck_worktree="../foredeck-update-$foredeck_stamp"
git worktree add -b "$foredeck_update" "$foredeck_worktree" "$foredeck_old_tip"
git -C "$foredeck_worktree" merge --no-commit --no-ff "$foredeck_new_base"
```

Read both sides of conflicts and preserve intended behavior, owner policy, and
compatibility. Stage only resolved files; never use blanket `--ours`/`--theirs`.
Inspect the result before committing:

```sh
git -C "$foredeck_worktree" diff --name-only --diff-filter=U
git -C "$foredeck_worktree" diff --cached --check
git -C "$foredeck_worktree" diff --cached "$foredeck_new_base"
git -C "$foredeck_worktree" diff --cached "$foredeck_old_tip"
```

The first command must list no unresolved conflicts. Review the remaining fork diff
against upstream for lost customizations and duplicated patches, and the change from
our old main for unintended behavior. Install using the linked-worktree setup above.
Run focused tests, lint, and package typechecks for the affected areas. Use copied
data for migrations/replay; never test a downgrade on the only database copy.

`git -C "$foredeck_worktree" merge --abort` abandons a failed rehearsal; main and the
backup refs remain untouched. To resume, inspect status and continue resolving the
existing merge, or abort and start a new attempt from the backups. Do not recreate
backup refs over existing names.

### Publish and integrate the tested update

When checks pass and committing/publishing are authorized:

```sh
git -C "$foredeck_worktree" commit -m "chore(upstream): merge upstream changes"
git -C "$foredeck_worktree" log -1 --format=fuller
git branch --no-track "backup/update-verified-$foredeck_stamp" "$foredeck_update"
git -C "$foredeck_worktree" push --set-upstream origin "$foredeck_update"
```

Before pushing, verify repository-level workflow safeguards and guard any new
publisher as described below. Record the tested SHA, upstream base, commands, and
limits in the owning task/PR. Open an update PR targeting our `main` only when
requested, include local verification results, and use **Create a merge commit**. Do
not squash or rebase an upstream update. If main advances, merge it into the update
branch and recheck the changed result. Fix relevant local failures before integration;
record platform checks that were not run.
After integration, update the local checkout:

```sh
git fetch --no-tags origin
git switch main
git merge --ff-only origin/main
git merge-base --is-ancestor "$foredeck_new_base" main
```

The final command verifies that the upstream commit remains in our history. Remove
only clean disposable worktrees and fully merged task branches; retain backup refs
until the update is accepted. Recover old work on a new branch from its backup.
Undo a published change with a reviewed revert, not a reset or force push.

### Rebase private task branches

Rebase a private task onto the updated fork main, including its customizations.
Do not rebase a task directly onto upstream if it depends on fork behavior. Save its
tip and rehearse on a disposable branch before changing the original:

```sh
git fetch --no-tags origin
foredeck_task=feature/my-change
foredeck_task_tip=$(git rev-parse "$foredeck_task")
foredeck_task_base=$(git merge-base "$foredeck_task" origin/main)
foredeck_task_target=$(git rev-parse origin/main)
foredeck_stamp=$(date -u +%Y%m%dT%H%M%SZ)
git branch --no-track "backup/task-$foredeck_stamp" "$foredeck_task_tip"
foredeck_rehearsal="chore/rebase-rehearsal-$foredeck_stamp"
foredeck_worktree="../foredeck-rebase-$foredeck_stamp"
git worktree add -b "$foredeck_rehearsal" "$foredeck_worktree" "$foredeck_task_tip"
git -C "$foredeck_worktree" -c rebase.autoStash=false rebase \
  --onto "$foredeck_task_target" "$foredeck_task_base"
foredeck_old_count=$(git rev-list --count "$foredeck_task_base..$foredeck_task_tip")
foredeck_new_count=$(git rev-list --count "$foredeck_task_target..$foredeck_rehearsal")
if test "$foredeck_old_count" -gt 0 && test "$foredeck_new_count" -gt 0; then
  git range-diff "$foredeck_task_base..$foredeck_task_tip" \
    "$foredeck_task_target..$foredeck_rehearsal"
elif test "$foredeck_old_count" -eq 0 && test "$foredeck_new_count" -eq 0; then
  git diff --exit-code "$foredeck_task_target" "$foredeck_rehearsal"
else
  echo "One patch series is empty; investigate before proceeding."
  false
fi
```

Review changed, dropped, and duplicated patches; a dropped patch may already exist
on main but is not automatically correct. Resolve conflicts by behavior, stage the
resolved files, and use `git rebase --continue`. `git rebase --abort` in the rehearsal
restores it. Re-test the result and either retain the tested branch or repeat the
verified rebase on the clean private task. Merge-heavy history usually calls for a
merge instead; a successful rebase rehearsal does not verify a different merge result.

Never rewrite shared history automatically. If a published task rebase is explicitly
authorized later, fetch and save its exact remote tip before rebasing, coordinate
with collaborators, and use an explicit lease expectation:

```sh
git fetch --no-tags origin
foredeck_expected=$(git rev-parse "refs/remotes/origin/$foredeck_task")
git branch --no-track "backup/published-$foredeck_stamp" "$foredeck_expected"
# Only after the rebase is reviewed/tested and the rewrite is authorized:
git push --force-with-lease="refs/heads/$foredeck_task:$foredeck_expected" \
  origin "$foredeck_rehearsal:refs/heads/$foredeck_task"
```

A lease rejection means someone advanced the branch: stop and reconcile rather
than refreshing the expectation to overwrite them. A future shared-main rewrite
would also need explicit authorization and coordination; current protection forbids
it. Merging upstream is the routine update procedure.

## Where customizations belong

Keep fork policy, identity, and branding distinct from runtime behavior. Use existing
settings, public build configuration, service layers, provider registries, and platform
composition first. Keep each behavior cohesive enough to review, rebase, revert, or
submit upstream independently. Core changes are appropriate when correctness requires
them; explain the constraint instead of building a wrapper or duplicate subsystem.
There is no empty foredeck-t3 package or new plugin framework.

### Keeping customizations easy to update

Upstream compatibility and the cost of future merges or rebases are acceptance
criteria for all Foredeck development: features, fixes, architecture, dependencies,
and visual changes. Build our product by expanding the existing system while keeping
upstream improvements practical to integrate. This permits new capabilities, UI,
and modules; the implementation should have a clear purpose and ownership boundary.

- **Define the intended change.** Identify the requested outcome, the existing
  integration points, and affected contracts, persisted state, and clients before
  implementation. Reference products and designs inform the work; they do not
  automatically expand its scope. Keep task-specific restrictions in the task.
- **Extend the existing system.** Prefer established services, adapters, contracts,
  shared components, and composition points. Keep new behavior in cohesive modules
  with small, explicit connections to upstream code. Avoid parallel implementations
  of subsystems upstream already owns. Core edits are appropriate when they are the
  smallest correct solution; explain their purpose rather than forcing wrappers
  around everything or introducing a framework without a concrete need.
- **Keep patches cohesive.** Separate visual identity from behavior changes and
  unrelated refactoring. Avoid unnecessary upstream file moves, symbol renames,
  formatting churn, duplicated subsystems, and competing sources for theme values.
  Keep changes independently reviewable, reversible, and suitable for upstreaming
  where useful; small line counts alone do not establish maintainability.
- **Review the integration cost.** Before finishing, inspect the diff for accidental
  scope growth, identify the upstream components it touches, and explain any necessary
  structural deviation. Verify existing behavior and saved preferences still work;
  test the ordinary unconfigured path when adding optional behavior. Record focused
  local checks and relevant untested surfaces in the task or PR, not an audit diary.

The published-main merge workflow above preserves shared history. Private rebases
and their range comparisons remain useful for evaluating changes without rewriting
the published fork automatically.

### Enforced fd boundary

Use **`fd`** as the code namespace. The product remains Foredeck / foredeck-t3.
Put new fork implementation in the owning workspace's `src/fd/<feature>/`:
server behavior in `apps/server`, shared client behavior in `packages/client-runtime`,
presentation in `apps/web` or `apps/mobile`, shell behavior in `apps/desktop`, and
relay behavior in `infra/relay`. Keep provider-specific work in its existing adapter
package. Expose each feature through its own `index.ts` or `index.tsx`; imports within
that feature can use private files. Do not create a global fd barrel or move existing
upstream code into fd. Tests live with the feature.

Use `packages/fd-<capability>` only for actual shared functionality, with a public
package entry and no imports from applications. App-local fd code can reuse its
own upstream services and components; shared code is reached through package exports.
Features must not import another application's internals or another fd feature's
private files. Keep assets under `assets/fd/<feature>/` or `public/fd/<feature>/`
where those directories already belong to the workspace. Native additions can live
under `native/fd/`; fork contributor tooling belongs under `scripts/fd/`.
Create these directories only with real implementation, not empty scaffolding.

Necessary upstream edits remain legitimate: compose services, register routes,
extend contracts, add migrations, fix shared correctness, or configure a build.
Keep the implementation in fd when practical. Declare each necessary integration
file as an **exact repository path with a reason** in
[`scripts/fd/integration-files.json`](../../scripts/fd/integration-files.json).
Explain the behavior it connects and why that edit must stay in core. No wildcards
or directory exemptions. Remove entries when their integration is removed. An entry
permits edits to that file; it does not justify unrelated changes or waive feature
privacy. Review changes to this small exception list and to the guard itself.

The local [boundary check](../../scripts/fd/check-boundaries.ts) runs before commit
formatting and before automatic merge commits. It checks an immutable snapshot of
the Git index, including partially staged files, and works when `.git` is a worktree
file. It rejects additions, edits, renames, or deletions in `apps/`, `packages/`,
`infra/`, and `native/` outside the allowed fd locations unless declared above.
Files copied unchanged from the verified `upstream/main` tree, and deletions already
made upstream since the merge base, pass without creating customization exceptions.
Conflicts resolved differently from upstream still require a reason.

For changed JavaScript and TypeScript, it also checks relative imports, the existing
web `~/` alias, and `@t3tools/*` package paths. It covers static imports, reexports,
type imports, literal dynamic imports and `require`; fd modules cannot use computed
module specifiers. Inbound fd imports require a declared integration file and must
use a feature entry point. Relative imports across workspaces and fd imports into
other apps are rejected. Keep shared package exports aligned with these entry points;
adding aliases, custom package-export mappings or loaders requires extending the check
and its tests. CSS/native imports and runtime registration are not module-graph checked.

The normal frozen install runs `prepare`, which configures `.vite-hooks/_` as
Git's hook directory. Verify with `git config --get core.hooksPath`, then run:

```sh
# Inspect what will be committed; this reads the staged policy too.
node scripts/fd/check-boundaries.ts --staged
# Before integrating a task branch, check all its committed changes from our main.
node scripts/fd/check-boundaries.ts --base main
vp test run scripts/fd/check-boundaries.test.ts
```

The branch check reads committed HEAD, not uncommitted work. Use both checks when
both exist. Before an upstream merge, verify remotes and fetch as described above;
the check trusts the local upstream tracking ref and never fetches itself. Git
fast-forwards and rebases do not consistently invoke commit hooks: run the branch
check against the saved pre-update main after a rehearsal and before integration.
These checks need no hosted CI. They constrain file placement and dependency paths;
they cannot prove correctness, minimal scope, or prevent someone with repository
write access from disabling them. Do not disable hooks or broaden exceptions just
to pass a check. Keep focused behavior tests and the integration-cost review above.

| Concern                                        | Integration boundary                                                                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution, authorization, files, durable state | Server services; thin HTTP/RPC/MCP handlers. The pure orchestrator decides events, EventSink commits, EffectWorker performs I/O.                                     |
| Shared client behavior                         | `packages/client-runtime` connection, state, and operation services; platform composition supplies credentials, storage, and lifecycle.                              |
| Wire compatibility                             | `packages/contracts`; advertise capabilities and handle absent fields/capabilities on old clients and servers.                                                       |
| Provider behavior                              | Provider packages and `apps/server/src/orchestration-v2/Adapters`; capability decisions per provider, not scattered UI conditions.                                   |
| Presentation                                   | Web features and existing UI variants; Electron shell/IPC for desktop-only work; React Native navigation and native modules for mobile.                              |
| Remote access                                  | Shared connection runtime for direct/SSH/tunnel routes; `infra/relay` for identity/link/tunnel brokerage. Relay credentials never replace environment authorization. |

Read [architecture](../internals/overview.md), [Effect services](../internals/effect-services.md),
[connection runtime](../internals/connection-runtime.md), [provider guidance](../internals/providers.md),
[environment auth](../internals/environment-auth.md), and [T3 Connect](../internals/t3-connect.md)
at the relevant boundary. Follow the existing guarded RPC command pattern and server
permission checks. A UI preference must not become authority over another environment.

For every behavioral change, decide which entry points, web/desktop/mobile clients,
providers, MCP tools, and scheduled tasks apply; include the reverse action. Keep
remote and mixed-version behavior explicit. Preserve old persisted-event decoding,
database migration order, and replay semantics; an additive wire field alone does
not establish downgrade safety. Rebase migration numbering deliberately after upstream
adds migrations. Add focused behavior tests, including the ordinary unconfigured path,
permissions, and reconnect/replay when affected. Drain asynchronous workers in tests.
UI automation and repository-wide checks require explicit authorization. Focused
local verification is the default for this fork.

## Dependencies beyond package installation

The lockfile, workspace catalog/overrides, `allowBuilds`, and registered patches are
one unit. Preserve their hashes together. Files in `patches/` that are not registered
are not automatically applied (for example the older Expo notification/core patches).
Do not infer an active fix from a stale document or patch filename alone.

- `.repos/` contains tracked, read-only Effect and Alchemy references, not runtime
  dependencies or submodules. [sync-reference-repos.ts](../../scripts/sync-reference-repos.ts)
  uses Git subtrees and package-version tags. Use `vp run sync:repos --dry-run` to
  inspect the plan before an intentional dependency/reference update; actual sync
  can create commits. The foundation's Effect reference is still 4.0.1 while the
  runtime catalog is 4.0.4; Alchemy is beta.80. Do not edit/import vendored references.
- Mobile's two committed archives include compiled JS, types, native source, and
  `t3-fork.json`. Source history and pack tooling live in separately maintained forks;
  archive bytes alone are not their source repositories. Inspect provenance with
  `tar -xOf apps/mobile/deps/<archive>.tgz package/t3-fork.json`.

| Archive at foundation base                       | Recorded source commit                     | Recorded upstream base                     |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| `react-native-screens-5.0.0-t3.27.tgz`           | `176ff64880ddd0a6122a1f18eda826479c8e73c7` | `72f38a66c188bdebee7a7798c9b72a121b7a8451` |
| `react-native-enriched-markdown-1.2.0-t3.11.tgz` | `3824d119a1ed6206f51ba3ec8ddf9ff93b8852f9` | `9684fdf425d3aa86825b69c8f65a5dedb03630bf` |

Screens' embedded repository names `juliusmarminge/react-native-screens`, while
[its runbook](mobile-screens-fork.md) names `pingdotgg/react-native-screens`.
The latter's `t3-v5.0.0-t3.27` tag and `t3/main` resolved to the recorded commit during
this audit. Enriched Markdown's manifest also names `juliusmarminge`, but its
`t3-fork.json` names `pingdotgg/enriched-markdown`; that repository's `fork/t3-mobile`
resolved to its recorded commit. These are metadata discrepancies, not missing
commit IDs. Reproduction instructions exist in the Screens runbook (Node 24, Yarn
4.1.1, `pack:t3`) and [deps README](../../apps/mobile/deps/README.md) (immutable Yarn
install, workspace `prepare`, `scripts/pack-t3.mjs`). Check out the recorded commits,
not moving branch tips. Archive reproduction has not been verified byte-for-byte.
Retain licenses and provenance when replacing an archive; rebuild native clients.
Create another dependency fork only when our changes require owning its source.

- The [mobile terminal](../../apps/mobile/modules/t3-terminal/README.md) includes
  GhosttyKit native binaries from Yash-Singh1's Ghostty commit
  `cf8edc23f3a6a87a96e41a90013e89e987d34980` (Zig 0.16.0, Xcode Metal toolchain).
  Android libraries/headers and the web WASM use upstream Ghostty commit
  `9f62873bf195e4d8a762d768a1405a5f2f7b1697`, pinned in `native/libghostty-vt/VERSION`.
  Android rebuild scripts use Zig 0.15.2, the NDK, and local patches. Preserve matching
  ABI artifacts and third-party notices; a JS install does not rebuild these binaries.
- Local Expo modules under `apps/mobile/modules` are maintained here. Their `file:`
  dependencies are copied into pnpm's store; rerun installation after JS edits, and
  rebuild/reinstall native clients for native changes. Expo Go is insufficient.
- Electron, node-pty, keyring, sharp, accessibility/passkey helpers, platform tools,
  and Rust crates need platform binaries/toolchains. `ensure:electron` repairs the
  Electron runtime. See [desktop prerequisites](development.md#desktop-artifacts)
  and [mobile setup](../../apps/mobile/README.md). Rust crates have Cargo lockfiles;
  use `--locked`. Native builds are distinct from TypeScript checks.
- Brand assets and license notices have existing generators (`icons:export`,
  `icons:check`, `licenses:sync`); mobile web assets and native fingerprints also have
  build steps. Update sources and regenerate their outputs, rather than editing only
  generated files. Do not regenerate unrelated assets as part of an upstream sync.

## CI and distribution boundaries

GitHub Actions is disabled at repository level by owner choice, so development does
not depend on hosted runner billing. No hosted status is required to merge into
`main`. This also prevents labeling and other inherited workflows from starting.

Before integration, review the diff and run the smallest meaningful local proof:
focused tests for changed behavior, lint for changed source files, and package
typechecks when types or contracts change. For example, use `vp test run <files>`,
`vp lint <files>`, and the affected package's existing typecheck script. For docs or
workflow-only changes, check formatting, links/shell examples, or workflow syntax as
appropriate. Record the exact commands, results, and untested platforms in the task
or PR. A local pass is not evidence of untested native, provider, migration, or
release paths. Repository-wide checks still require an explicit request.

The workflow definitions are retained for future use and upstream compatibility.
They cover pull requests and main pushes, with GitHub-hosted fallback runners for
this fork. The full CI jobs and final `Check` job remain in YAML, but do not run.
Re-enabling hosted validation requires an owner decision and a successful run before
restoring required status checks. Keep publishing workflows disabled separately.

The PR template follows the owner attribution policy. The mobile version-bump workflow
also omits its former automatic AI co-author trailer. Installation runs the existing
`prepare` step, which configures `.vite-hooks`; its tracked commit hooks check the
[fd boundary](#enforced-fd-boundary), and pre-commit also formats staged files.
They do not add message trailers. Reinspect generated hooks and any
machine-local hook initialization before committing.

Publishing/deployment entry jobs, the upstream hygiene webhook, and upstream vouch
automation require `github.repository == 'pingdotgg/t3code'`. This covers release/npm,
desktop previews/signing, Vercel previews, relay deployment, AUR, EAS build/submit/OTA,
Play APK mirroring, and store screenshot jobs. Guarded entry jobs block their dependent
jobs. CI, fingerprint checks, diff-size labels, and transfer report definitions are retained.
Re-audit new upstream workflows during every update.

**Repository settings:** Actions is disabled for the fork. Inherited distribution,
hygiene, and vouch workflows also remain individually disabled, so re-enabling
validation later does not enable publishing. `main` is the default development
branch with no required hosted status checks. Force pushes and branch deletion are
blocked, including for administrators. Merge commits remain allowed for upstream
updates. During every upstream update, inspect new/changed workflows and retain
fork guards. Repository settings are external to Git and must be reapplied when
creating another fork; the YAML guards are a second layer.

Source development is ready to isolate; distributable foredeck-t3 app identity is not
defined. Before installing or shipping a fork artifact, resolve these boundaries:

| Boundary               | Current behavior and required decision                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop identity/state | Packaging hardcodes `com.t3tools.t3code`, T3 product names, `t3code`/`t3code-dev` schemes and Linux identifiers. Normal state lives under `.t3`; a fork can collide with upstream. Choose coherent app, protocol, keychain, installer, and data identities. `--home-dir` isolates development, not an installed product.                                                                                            |
| Desktop updates        | Packaging uses `T3CODE_DESKTOP_UPDATE_REPOSITORY`, then `GITHUB_REPOSITORY`; without either there is no feed. Preview versions also omit feeds. Inspect `app-update.yml`; development disables updates. `--publish never` prevents an upload, not identity collisions or a configured updater.                                                                                                                      |
| CLI/services/SSH       | `t3` and `@t3code/t3-*` are upstream package names. `packages/shared/src/cliRelease.ts` discovers upstream GitHub releases; `T3CODE_RELEASE_BASE_URL` overrides asset downloads but does not replace release discovery. Service and SSH provisioning/update paths need a coordinated fork release design.                                                                                                           |
| Mobile identity/OTA    | `app.config.ts` uses upstream bundle IDs, URL schemes, Clerk relying party, owner and EAS project; `eas.json` includes store submission IDs/channels. OTA is enabled against upstream by default. Use `T3CODE_MOBILE_UPDATES_ENABLED=0` for local experiments, and do not distribute until app IDs, EAS project, signing, push, and channels are ours. Personal Team overrides alone do not replace all identities. |
| Cloud/hosted web       | Empty config disables Connect. `.env.example` opts into upstream Clerk and `relay.t3.codes`; hosted auth defaults to `app.t3.codes`. Decide whether cloud services are needed, then configure owned origins, OAuth/passkeys, relay/tunnel domains and infrastructure together. Direct pairing remains server-owned.                                                                                                 |
| Analytics/diagnostics  | Server PostHog collection defaults on; use `T3CODE_TELEMETRY_ENABLED=false` for fork development. Mobile/relay tracing has separate public OTLP configuration. Decide consent and receivers before distribution; do not embed private service credentials.                                                                                                                                                          |

See [release operations](release.md) and [Connect setup](connect-setup.md) for mechanisms,
not authorization to publish upstream identities. No production secrets, replacement
domains, speculative product features, or empty customization packages are needed for
this foundation. The next product decision is which foredeck-t3 behavior to add and
which clients it must support; it does not block source development.

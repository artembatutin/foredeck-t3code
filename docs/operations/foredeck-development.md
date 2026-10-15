# foredeck-t3 development

The project is named **foredeck-t3**. This runbook governs development in
`artembatutin/foredeck-t3code`, tracking
`pingdotgg/t3code`. [AGENTS.md](../../AGENTS.md#foredeck-t3-fork-ownership) owns the
fork's contribution and attribution policy; `CLAUDE.md` delegates to it. Upstream's
contribution approval process applies when submitting work to upstream. Keep its
architecture, performance, compatibility, and verification guidance for fork work too.

## Branch roles

- `main`: GitHub default branch and upstream mirror, advanced only by fast-forward;
  no fork commits.
- `chore/foredeck-t3`: fork integration branch. Start focused task branches here and
  integrate reviewed work here. Once published, treat this as shared history.
- `feature/*`, `bugfix/*`, `chore/*`, `docs/*`: short-lived task branches. Rebase
  private work; do not rewrite a published branch without explicit authorization.

The initial checkout and `origin/main` were both
`c814e51af2ba962c9291c9459ee64b4f57e0b5ce`, with **zero customization commits**.
The upstream tip fetched for this foundation was
`e536bfd33bc3c351997141d93790df75eeded7b9` (two commits ahead). The foundation starts
at the checkout commit; it does not silently integrate those two changes. An empty
series rebase rehearsal reached the fetched tip with an identical tree. This proves
the branch procedure, not the correctness of those upstream changes.

The integration branch contains the foundation on that checkout base. `main` remains
the GitHub default; explicitly choose `chore/foredeck-t3` for development and as the
base of fork pull requests. No ticket was assigned to the foundation work.

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
git clone --branch chore/foredeck-t3 https://github.com/artembatutin/foredeck-t3code.git foredeck-t3
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
git worktree add -b feature/my-change ../foredeck-my-change chore/foredeck-t3
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

Run these steps in one shell, stopping on any failure. Substitute unique backup
and rehearsal names when resuming an existing attempt. Do not automatically stash,
reset, overwrite tags, or use a mirror push. Stop if a merge/rebase is already in
progress or any worktree involved has uncommitted work; preserve that work first.

### Inspect and save the old base

```sh
git status --short --branch
git worktree list
git branch -vv
git remote -v
test -z "$(git status --porcelain=v1 --untracked-files=all)"
git remote get-url --all origin
git remote get-url --push --all origin
git remote get-url --all upstream
git remote get-url --push --all upstream
```

Verify that origin's fetch/push URLs identify `artembatutin/foredeck-t3code` and
upstream identifies `pingdotgg/t3code` (HTTPS and SSH forms are equivalent).
Inspect every URL; stop on an unexpected identity. Never push to upstream here.
Then record the old base **before fetching**, so a moving remote-tracking ref
cannot change the meaning of the old customization range:

```sh
foredeck_old_tip=$(git rev-parse chore/foredeck-t3)
foredeck_old_base=$(git merge-base chore/foredeck-t3 upstream/main)
foredeck_stamp=$(date -u +%Y%m%dT%H%M%SZ)
git log --oneline "$foredeck_old_base..$foredeck_old_tip"
git branch --no-track "backup/foredeck-$foredeck_stamp" "$foredeck_old_tip"
git branch --no-track "backup/upstream-base-$foredeck_stamp" "$foredeck_old_base"
git branch --no-track "backup/main-$foredeck_stamp" main
git fetch --no-tags upstream refs/heads/main:refs/remotes/upstream/main
git fetch --no-tags origin
foredeck_new_base=$(git rev-parse upstream/main)
git branch -vv
git merge-base --is-ancestor "$foredeck_old_base" "$foredeck_new_base"
git log --oneline "$foredeck_old_base..$foredeck_new_base"
git diff --stat "$foredeck_old_base" "$foredeck_new_base"
git diff "$foredeck_old_base" "$foredeck_new_base" -- AGENTS.md CLAUDE.md CONTRIBUTING.md \
  .agents .github docs packages/contracts apps/server/src/persistence \
  apps/server/src/orchestration-v2 package.json pnpm-workspace.yaml pnpm-lock.yaml \
  patches apps/mobile/deps apps/mobile/app.config.ts apps/mobile/eas.json \
  scripts t3.json native
```

Follow changed contracts to their server and client consumers. Review replay and
migration changes, provider SDKs, native archives, build tools, hooks, and newly added
publishers. Re-read applicable nested instructions. If upstream rewrote history or
the chosen base does not bound the intended series, stop and select a verified base;
do not force the fetch or mechanically transplant a mixed merge history. If
`origin/chore/foredeck-t3` exists, inspect
`git log --left-right --oneline chore/foredeck-t3...origin/chore/foredeck-t3`; reconcile
unincorporated collaborator work before updating the integration branch.

### Rehearse independently

```sh
foredeck_rehearsal="chore/upstream-rehearsal-$foredeck_stamp"
foredeck_worktree="../foredeck-rehearsal-$foredeck_stamp"
git worktree add -b "$foredeck_rehearsal" "$foredeck_worktree" "$foredeck_old_tip"
git -C "$foredeck_worktree" -c rebase.autoStash=false rebase \
  --onto "$foredeck_new_base" "$foredeck_old_base"
foredeck_old_count=$(git rev-list --count "$foredeck_old_base..$foredeck_old_tip")
foredeck_new_count=$(git rev-list --count "$foredeck_new_base..$foredeck_rehearsal")
if test "$foredeck_old_count" -gt 0 && test "$foredeck_new_count" -gt 0; then
  git range-diff "$foredeck_old_base..$foredeck_old_tip" \
    "$foredeck_new_base..$foredeck_rehearsal"
elif test "$foredeck_old_count" -eq 0 && test "$foredeck_new_count" -eq 0; then
  git diff --exit-code "$foredeck_new_base" "$foredeck_rehearsal"
else
  echo "One customization series is empty; investigate before proceeding."
  false
fi
git log --oneline "$foredeck_new_base..$foredeck_rehearsal"
git diff --check "$foredeck_new_base" "$foredeck_rehearsal"
git diff "$foredeck_new_base" "$foredeck_rehearsal"
```

`range-diff` requires nonempty ranges. If both series are empty, skip it and require
`git diff --exit-code "$foredeck_new_base" "$foredeck_rehearsal"`. If only one is
empty, investigate every dropped or newly introduced patch. For nonempty series,
review every `!`, `<`, and `>` entry: upstream may already contain a customization,
but a dropped patch is not automatically correct. Look for duplicates and changed
intent. A merge-heavy integration history generally calls for a merge, not a plain
linear rebase; preserve meaningful merges if explicitly choosing a rebase later.

Resolve conflicts in the rehearsal by reading both behaviors, retaining owner policy
and compatibility, then stage only resolved files and `git rebase --continue` there.
Never choose an entire side with blanket `--ours`/`--theirs`. Inspect generated commit
messages and trailers. `git -C "$foredeck_worktree" rebase --abort` restores the
rehearsal; the integration branch and backup refs remain untouched. To resume, inspect
`git status` there and continue the existing operation, or abort and start a new
rehearsal from the saved refs. Do not recreate backups over existing names.

Install and check the rehearsal using the setup above. Run focused tests, lint, and
package typechecks for upstream changes and fork integration points. Use copied data
for migrations/replay; never test a downgrade on the only database copy. Record the
tested SHA, base, commands, and limits in the owning task/PR. Only after those checks
pass, run `git branch --no-track "backup/foredeck-verified-$foredeck_stamp" "$foredeck_rehearsal"`
to save that exact SHA; the
initial audit refs are not claims of a fully tested application.

### Integrate without rewriting shared history

For a **private** task branch, the same rehearsal/rebase procedure is suitable.
For a private integration branch, explicitly choose a local fast-forward where
possible or an authorized branch replacement after review; do not use a destructive
reset to promote a rehearsal. Keeping the tested branch under its own name is safe.

For **published** `chore/foredeck-t3`, prefer merging upstream: it retains collaborator
bases and review history. Rehearse that merge separately:

```sh
foredeck_merge_branch="chore/upstream-merge-$foredeck_stamp"
foredeck_merge_tree="../foredeck-merge-$foredeck_stamp"
git worktree add -b "$foredeck_merge_branch" "$foredeck_merge_tree" "$foredeck_old_tip"
git -C "$foredeck_merge_tree" merge --no-commit --no-ff "$foredeck_new_base"
```

Resolve and test the actual merge result; `git -C "$foredeck_merge_tree" merge --abort`
abandons it. Commit there only when authorized, with a compliant Conventional Commit
message. Once the tested merge is committed, use a clean integration checkout:

```sh
git switch chore/foredeck-t3
git merge --ff-only "$foredeck_merge_branch"
# Only when publishing is authorized:
git push origin chore/foredeck-t3:chore/foredeck-t3
```

A successful rebase rehearsal does not verify a different merge result. Re-check
the remote tip before publishing; a rejected normal push is a reason to reconcile.

Advance the mirror only if `git merge-base --is-ancestor main upstream/main` succeeds:
switch to a clean `main` checkout and run `git merge --ff-only "$foredeck_new_base"`.
Push `main:main` normally only with authorization **and the remote workflow safeguards
below in place**. Leave mirror divergence for investigation; never reset it blindly.

If a published integration rebase is explicitly authorized later, first re-fetch
origin, verify collaborators have coordinated, and save its exact tip:

```sh
git fetch --no-tags origin refs/heads/chore/foredeck-t3:refs/remotes/origin/chore/foredeck-t3
foredeck_expected=$(git rev-parse refs/remotes/origin/chore/foredeck-t3)
git branch --no-track "backup/published-$foredeck_stamp" "$foredeck_expected"
# After review/testing, with foredeck_rehearsal naming the approved result:
git push --force-with-lease="refs/heads/chore/foredeck-t3:$foredeck_expected" \
  origin "$foredeck_rehearsal:refs/heads/chore/foredeck-t3"
```

A lease rejection means someone advanced the branch: stop and reconcile; do not
refresh the expectation merely to overwrite them. Backups remain recovery anchors:
create `chore/recovery-<stamp>` from the saved tip to inspect/recover work. Undoing a
published merge uses a reviewed revert; restoring a published pre-rebase tip is
another shared rewrite requiring separate authorization. Remove only clean disposable
worktrees after review; keep backup refs until the update is accepted.

## Where customizations belong

Keep fork policy, identity, and branding distinct from runtime behavior. Use existing
settings, public build configuration, service layers, provider registries, and platform
composition first. Keep each behavior cohesive enough to review, rebase, revert, or
submit upstream independently. Core changes are appropriate when correctness requires
them; explain the constraint instead of building a wrapper or duplicate subsystem.
There is no empty foredeck-t3 package or new plugin framework.

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
UI automation requires explicit authorization. CI owns repository-wide checks.

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

CI validates pull requests and pushes to `main`/`chore/foredeck-t3`. Fork validation uses
GitHub-hosted Ubuntu, macOS, and manual Windows runners; upstream retains Blacksmith.
The selected labels are listed in [GitHub's runner images](https://github.com/actions/runner-images#available-images).
The full existing CI jobs and final `Check` gate remain. Fork jobs get more time on
smaller runners; actual hosted performance and runner availability need a first run.
Mobile fingerprint comparison remains available without an Expo token. Review
service installation and branch protection are repository settings, not proven by YAML.

The PR template follows the owner attribution policy. The mobile version-bump workflow
also omits its former automatic AI co-author trailer. Installation runs the existing
`prepare` step, which configures `.vite-hooks`; its tracked pre-commit action formats
staged files and does not add message trailers. Reinspect generated hooks and any
machine-local hook initialization before committing.

Publishing/deployment entry jobs, the upstream hygiene webhook, and upstream vouch
automation require `github.repository == 'pingdotgg/t3code'`. This covers release/npm,
desktop previews/signing, Vercel previews, relay deployment, AUR, EAS build/submit/OTA,
Play APK mirroring, and store screenshot jobs. Guarded entry jobs block their dependent
jobs. Useful CI, fingerprint checks, diff-size labels, and transfer reports are retained.
Re-audit new upstream workflows during every update.

**Repository settings:** inherited distribution/hygiene/vouch workflows are disabled
at repository level. Keep them disabled until their identities and destinations are
configured for this fork. `main` remains the default branch. Require the final
`Check` status before integration into `chore/foredeck-t3`, with force pushes and
branch deletion blocked. Protect the mirror against force pushes and deletion too;
do not require the fork CI gate on the untouched upstream mirror.
Keep validation enabled. A pure upstream `main` mirror cannot carry fork guards:
default-branch selection alone does not disable push/tag workflows on the mirror.
Before every mirror update, verify workflow states in GitHub and disable any newly
inherited publisher. Repository settings are external to Git and must be reapplied
when creating another fork; the YAML guards are a second layer.

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

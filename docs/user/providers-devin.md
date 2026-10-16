# Devin

Foredeck offers **Devin CLI** for work on your environment and **Devin Cloud**
for work in Devin's hosted environment. Add either from **Settings → Providers →
Add provider** in web or desktop, then select it in a thread's model picker.
Both are available to mobile clients connected to that environment.

## Devin CLI

Install [Devin CLI](https://docs.devin.ai/work-with-devin/devin-cli) on the machine hosting
your environment. Sign in with `devin auth login`, or use the account section
in Foredeck's provider settings. Set **Devin CLI executable** if `devin` is not
on that machine's `PATH`. Refresh provider status to discover models and native
session options after setup.

For an instance-specific API credential, set its sensitive `WINDSURF_API_KEY`
environment field. Otherwise the instance uses the CLI's saved login. Instances
using the same CLI home share that login; a separate display name does not
create a separate account. An inherited host API key is not used automatically.

The CLI works in the thread's workspace on the selected environment, including
remote WSL hosts. Models are discovered for that instance's account. Each reasoning
or speed variant is a separate selection using the exact native ID; refresh after
changing accounts or updating the CLI. The native default and custom model IDs
remain available when discovery fails. An empty account catalog removes previously
discovered variants rather than keeping another account's list.

The model picker shows the CLI's **estimated credits per message** separately from
the model name, with context/output limits when reported. These are estimates,
not actual charges or API dollar prices. The context meter uses native token
measurements and explicitly labelled credit metrics; a last-turn cost and a
resumed session's total have different labels. Raw internal credit counters are
not converted to display credits or dollars.

The **Usage** page reads historical token activity from the CLI’s local session
database, including work outside Foredeck. It groups activity by date and model
and separates input, output and cached tokens. Dollar amounts use the page’s
model price estimates or your overrides; they are not Devin credit charges.
Models without a known price still contribute token activity. Each connected
environment reads its own history, including an instance’s `XDG_DATA_HOME` store
on macOS/Linux or `LOCALAPPDATA` store on Windows. A missing, unreadable or
unsupported database appears in source coverage. Account allowances and reset
times remain unavailable.

Refresh workspace skills after installing or editing them. Native skills appear
in the `$` picker and, when enabled in settings, the `/` skill picker. Foredeck
sends the chosen skill as its native slash invocation and preserves its arguments.
Only one native skill is guaranteed to expand per message; other mentions remain
context for the agent. Native built-in commands win naming collisions (for example,
a skill called `plan` cannot replace `/plan`). Rules and AGENTS.md remain native
workspace instructions. Ordinary requests also receive Foredeck's orchestration
instructions; native commands do not acquire those instructions as arguments.

Use Foredeck's Plan mode when the installed session advertises native planning.
Returning to Default restores its previous native mode. Ask, Code, Smart and Bypass
are offered only when advertised by that session. Plan mode does not promise a
proposed-plan approval card: no verified native approval transition is exposed by
the installed interface. Unsupported approval controls remain unavailable.

Use **Compact** or `/compact` for native compaction. Foredeck waits for Devin's
completion notification, reports failures, and preserves the native summary. A
successful compaction invalidates the previous context measurement; a new size is
shown only when the CLI reports it. A CLI that does not advertise compaction cannot
silently substitute an ordinary model request.

Foredeck's permission mode answers ACP approval requests and guards client
terminals. Devin's native mode also controls its own tools. **Foredeck Auto is not
Devin Smart**: Smart uses Devin's own safety classifier and is available only when
advertised; Bypass does not bypass Foredeck's terminal checks. Native file operations
may be approved by Devin without an ACP callback. Neither this integration nor a
permission selector promises an operating-system sandbox. The standalone CLI's
research-preview `--sandbox` flag is not an ACP sandbox capability.

When the CLI advertises session listing and loading, provider settings let you
import an existing session. Creation, loading, reconnecting and interruption reuse
the shared ACP lifecycle. An empty session on older builds may not appear in native
history until it has a turn. A workspace reached through a symlink may need its
canonical path when listing sessions.

Checkpoint rollback restores local files and starts a fresh native conversation;
it cannot rewind Devin's hidden conversation. Portable handoff carries the selected
conversation context/summary through Foredeck and keeps local checkpoint behavior,
but does not copy hidden native state, pending approvals, caches or running native
subagents. Native fork/rewind controls remain unavailable unless a future negotiated
interface supports them.

Native subagents stream into Foredeck's child-task presentation, including their
lifecycle, tools, output and result. A root turn stays open while known native
children finish, so background completions remain attached to their parent. Native
Devin children and Foredeck-owned delegated tasks are different runtimes. Independent
native child stop/resume/fork controls are unavailable because the installed ACP
interface has no verified child-targeted operation; Foredeck delegated tasks retain
their normal controls. Account policy may disable native subagents.

Automatic titles, branch names, commit messages and PR descriptions use the
installed CLI's tool-free `acp --agent-type summarizer` agent. Foredeck probes its
help before offering these instances as writers, runs outside the project checkout,
passes no MCP servers or client tools, and validates the structured reply. Errors,
cancellation and incomplete output are not reported as success. Attachment-based
text generation and checkout-investigating review guides remain unavailable.
The general-purpose standalone `--print` agent is not used for these operations.

### Integration comparison

This compares Foredeck's integrations, not every feature in the standalone products.
“Native” depends on the installed runtime and account. Web/desktop and connected
mobile clients share server behavior; picker layouts differ.

| Capability                                     | Devin CLI                                                     | Claude                         | Codex                          |
| ---------------------------------------------- | ------------------------------------------------------------- | ------------------------------ | ------------------------------ |
| Account-specific models, custom IDs, refresh   | Native ACP plus read-only CLI catalog                         | Supported                      | Supported                      |
| Thinking/speed choices                         | Exact native variant IDs; no inferred combinations            | Native options                 | Native options                 |
| Model limits and billing                       | Native limits and credit estimates when supplied              | Available model/usage metadata | Available model/usage metadata |
| Streaming text, reasoning and tool output      | Shared ACP plus native message IDs                            | Supported                      | Supported                      |
| Terminals and approvals                        | Client terminals and ACP callbacks; native mode also applies  | Supported                      | Supported                      |
| MCP tools and structured questions             | Shared ACP bridge and elicitation; runtime-dependent          | Supported                      | Supported                      |
| Images and file attachment context             | Negotiated images, per-model image flags, shared file paths   | Supported                      | Supported                      |
| Native planning mode                           | Advertised modes map to Plan/Default                          | Supported                      | Supported                      |
| Proposed-plan cards and approval transition    | No verified native transition; unavailable                    | Supported                      | Supported                      |
| Manual context compaction                      | Advertised command plus native async lifecycle                | Supported                      | Supported                      |
| Live context and reported usage                | Native token updates and labelled credit metrics              | Supported                      | Supported                      |
| Global usage-history page                      | Local session database; historical tokens and price estimates | Transcript ingestion           | Transcript ingestion           |
| Subscription windows/reset times/reset credits | No verified CLI/ACP source; unavailable                       | Account-dependent support      | Account-dependent support      |
| Automatic titles and source-control writing    | Tool-free summarizer when installed                           | Supported                      | Supported                      |
| Session import and restart/reconnect           | Negotiated listing/loading; native replay                     | Supported                      | Supported                      |
| Checkpoints and portable provider handoff      | Shared Foredeck workflow                                      | Supported                      | Supported                      |
| Native conversation fork/rewind                | Not advertised by the checked CLIs; portable fallback         | Supported                      | Supported                      |
| Native child lifecycle/output                  | Native metadata; no independent child controls                | Native integration             | Native integration             |
| Foredeck-owned delegation                      | Shared MCP orchestration                                      | Shared MCP orchestration       | Shared MCP orchestration       |
| Live steering                                  | Interrupt/restart or queued messages                          | Native support                 | Native support                 |
| OS sandbox and interactive MCP Apps            | Not advertised as supported by this integration               | Runtime-dependent              | Runtime-dependent              |

### Interface boundaries

| Category                    | Boundary                                                                                                                                                                    | Available path                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Protocol restriction        | No negotiated native fork or conversation truncation                                                                                                                        | Checkpoints plus portable handoff/fresh native session                                                       |
| CLI-version restriction     | Mac `3000.6.14` advertises stdio MCP; WSL `3000.11.92` additionally advertises HTTP/SSE and session close                                                                   | Shared MCP bridge works across both; optional behavior follows negotiation                                   |
| CLI-version restriction     | Empty sessions are not necessarily persisted on creation                                                                                                                    | Import after a native turn; newer builds advertise persist-on-create                                         |
| Deliberate fallback         | No verified live-steering operation on the older interface                                                                                                                  | Queue or interrupt/restart                                                                                   |
| Deliberate fallback         | No verified subscription reset command or credit-to-dollar conversion                                                                                                       | Read-only local token history and live/replayed session metrics; manage account limits in Devin              |
| Unverified vendor schema    | Workspace roots, document/editor updates, editable commands, user configuration, chains/megaplan and newer mid-turn prompts are advertised without a verified host contract | Existing workspace, files, native rules/config and commands remain usable; no speculative extension requests |
| Unverified native semantics | Plan mode and todo events do not establish proposed-plan approval; child IDs do not establish child cancellation                                                            | Corresponding independent controls stay unavailable                                                          |

Session metadata updates already use shared ACP handling. Native configuration and
command advertisements refresh existing model/mode controls. Audio prompts are not
negotiated by the checked CLIs. Native session sharing, interactive MCP Apps, and
standalone cloud/desktop/SSH management commands are not local ACP features.

See the official [command reference](https://docs.devin.ai/cli/reference/commands),
[ACP host guidance](https://docs.devin.ai/cli/acp/zed),
[models](https://docs.devin.ai/cli/models), and
[skills](https://docs.devin.ai/cli/extensibility/skills/overview).

## Devin Cloud

Cloud needs a [Devin API credential](https://docs.devin.ai/api-reference/authentication)
with access to the chosen organization. Enter the **Organization ID** from Devin's
API settings and save the credential in the sensitive **Devin API key** field
(`DEVIN_API_KEY`). Cloud credentials are separate from CLI sign-in.

Set **Cloud repositories** to repositories the organization can access. Local
workspace files and uncommitted changes are not uploaded. Describe the repository
and branch you want in your prompt. Choose the normal or fast cloud mode and a
**Session ACU limit** before starting; the default limit is 10 ACUs per session.
Cloud work consumes your Devin account's usage.

Cloud runs with **Full access** in its hosted environment. Foredeck cannot enforce
local file permissions or approval policies there. It does not offer local
checkpoints, conversation rewind, attachments, or Foredeck MCP tools for Cloud.
Use repository branches and pull requests to bring Cloud changes back locally.

Messages and completion status appear in the thread. Follow-up messages reuse
the same Cloud session, including after reconnecting. **Stop** terminates the
remote session while preserving resumability. Disconnecting a client or stopping
the Foredeck server detaches from the session; remote work may continue. Manage
that work through Devin if Foredeck is offline.

If Foredeck cannot confirm session creation or message delivery, check the Cloud
session in Devin before retrying to avoid starting duplicate work.

Devin Cloud does not supply Foredeck's automatic titles or source-control text.
Choose Devin CLI with its tool-free summarizer, or another supported writer, for
those settings. Disabling or removing a provider keeps thread history;
stop active Cloud work before removing its connection.

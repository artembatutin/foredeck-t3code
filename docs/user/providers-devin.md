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

The CLI works in the thread's local workspace. Commands run through Foredeck's
terminals and follow the thread's permission mode. Models and native options
come from the CLI. Its native mode picker includes the modes it advertises;
Foredeck's proposed-plan toggle is unavailable.

When the CLI advertises session listing and loading, its provider settings let
you import an existing session. Checkpoint rollback restores local files, but
cannot rewind the native conversation; the next turn starts a fresh session.
Install and update the CLI on the environment's host.

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

Neither Devin provider supplies Foredeck's automatic thread titles, commit
messages, or pull request descriptions. Choose another provider for those
text-generation settings. Disabling or removing a provider keeps thread history;
stop active Cloud work before removing its connection.

# Claude Code → Agent Observatory

Claude Code hooks post each lifecycle event to the hub. The hub keeps the event
type, tool name, IDs and in-project file paths, then throws the rest away.
Nothing here calls an AI model, and the hub always answers with an empty 204,
so it can never change what Claude Code does.

Checked against Claude Code 2.1.310 and <https://code.claude.com/docs/en/hooks>.

## What you need

- The hub's address. Deployed on Vercel it is `https://<your-app>.vercel.app`
  (see [docs/deploy-vercel.md](../../docs/deploy-vercel.md)). Running on one
  machine with `pnpm dev` it is `http://127.0.0.1:4318`, or that machine's
  private address for other devices on your network.
- The `INGEST_TOKEN` you gave the hub.
- `curl` and `node` on the machine (curl for the session-start and stop events,
  node for the installer).

Nothing else runs on your laptops: Claude Code itself sends each event to the
hub, from any network.

## Install on each machine

Do this on every machine where you use Claude Code (work laptop, home laptop,
a remote box). Each one needs the same token and its own device name.

1. Set two environment variables in your shell profile (`~/.zshrc` or similar),
   then open a new terminal:

   ```bash
   export AO_INGEST_TOKEN="paste the hub's INGEST_TOKEN here"
   export AO_DEVICE="work-laptop"   # letters, digits, dot, dash, underscore
   ```

2. Run the installer with your hub address. It checks that the hub is reachable
   and accepts your token (without storing anything), then merges the hooks into
   `~/.claude/settings.json`. Your existing hooks are kept, the file is backed
   up first, and you see the diff:

   ```bash
   ./install.sh https://your-app.vercel.app
   ```

   Add `--dry-run` to only show the diff. Add
   `--settings <project>/.claude/settings.local.json` to install for one
   project instead of every project on the machine.

3. Start a new `claude` session and use a tool. The agent should appear on the
   dashboard within a second, labelled with your `AO_DEVICE` name.

To remove it again: `./install.sh --uninstall` (only the Observatory entries
are removed). Running the installer again with a new address switches hubs.

### Doing it by hand

To try it for one session without touching any settings file, or to merge it
yourself:

```bash
sed 's|HUB_URL|https://your-app.vercel.app|g' hooks.example.json > hooks.mine.json
claude --settings ./hooks.mine.json
```

Then merge the `"hooks"` block into `~/.claude/settings.json` or
`<project>/.claude/settings.local.json`, next to any hooks you already have,
and run `/hooks` inside Claude Code to confirm they are listed.

## Why the hub address is not an environment variable

Claude Code only substitutes environment variables in HTTP hook **headers**
(and only those listed in `allowedEnvVars`). Substitution in `url` is not
documented, so the installer writes the address into your settings. The token
and device name do come from the environment and are never written to disk by
these steps.

## Why SessionStart uses curl

`SessionStart` does not accept `type: "http"` hooks, so that one event uses a
small background `curl` command. Its output is discarded, so it adds nothing to
Claude's context. If you leave it out, everything still works: the session and
agent are created from their first other event, and the session's start time
shows as unknown.

## How the model is found

Claude Code 2.1.325 does not put the model in any hook payload (checked for
`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop` and
`SessionEnd` in a headless run). So the `SessionStart` and `Stop` hooks are
`curl` commands that read the last model id from the tail of the session's own
transcript file on the laptop and send only that id in an `X-Model` header.
The transcript itself is not sent.

The model therefore shows as unknown until the first turn of a new session
ends. It is the main agent's model: subagents show unknown.

## If the hub is unreachable

Each event waits up to the 2-second hook timeout, then Claude Code carries on.
Tools still run, but each one can feel up to a few seconds slower until the hub
is back (offline laptop, Vercel outage). A hub that is up but asleep adds a
fraction of a second to the first event only. If the hub is up but its database
is down, it still answers 204 immediately and the event is lost.

Events sent while the hub cannot be reached are lost. That is by design.

## What leaves the laptop

Claude Code sends its full hook payload, which includes prompts, tool input and
tool output, to the hub. The hub reads only an allow-list of fields and never
writes the rest to the database or logs.

What the hub keeps depends on `CAPTURE_DETAIL` in its `.env`:

- `true` (default): your prompt text, shell commands, search patterns, URLs and
  subagent tasks are stored, trimmed (prompts to 1000 characters, tool input to
  500) with likely secrets (API keys, tokens, passwords) replaced by
  `[redacted]`. This is what the Live activity log shows.
- `false`: only fixed summaries such as "Bash tool started" are stored.

In both modes tool output, the AI's replies, file contents and transcript
paths are never stored. Stored text is deleted with its event after
`EVENT_RETENTION_DAYS`.

On Vercel the traffic is HTTPS and the stored text lives in your Turso
database, so set `CAPTURE_DETAIL=false` on the hub if you do not want prompts
and commands in the cloud. Plain `http://` is not encrypted: use it only for
`127.0.0.1`, or over Tailscale. The installer warns if you give it one.

## How a subagent is linked to its parent

Tested with one real `Explore` subagent run on Claude Code 2.1.310. Observed
payload keys:

| Event | Fired in | Relevant fields |
| --- | --- | --- |
| `PreToolUse` / `PostToolUse` for the `Agent` tool | parent | `session_id`, `tool_use_id`; no `agent_id` |
| `SubagentStart` | subagent | `session_id`, `agent_id`, `agent_type` |
| `PreToolUse` / `PostToolUse` inside the subagent | subagent | `session_id`, `agent_id`, `agent_type`, `tool_use_id` |
| `SubagentStop` | subagent | `session_id`, `agent_id`, `agent_type` |

What this proves and what it does not:

- **`session_id` is the link.** Subagent events carry the parent session's own
  `session_id`. `agent_id` identifies the subagent and `agent_type` names it.
  Main-agent events have no `agent_id`.
- There is **no parent agent ID field** and nothing that ties `SubagentStart`
  to the `Agent` tool call that caused it.
- So the hub links a subagent to the **main agent of the same session**. That
  is proven when the main agent started it. If a subagent ever starts another
  subagent, the payload cannot show it, and the hub would still show the main
  agent as the parent.
- `SubagentStop` can also fire for internal helper agents that never sent a
  `SubagentStart`. The hub ignores a stop for an agent it has never seen.

Not observed in this test: `PermissionRequest`, `PostToolUseFailure`,
`TaskCreated`, `TaskCompleted`, `Notification` and `Stop`. Their handling
follows the documentation and is covered by unit tests only.

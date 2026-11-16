# Claude Code → Agent Observatory

Claude Code hooks post each lifecycle event to the hub. The hub keeps the event
type, tool name, IDs and in-project file paths, then throws the rest away.
Nothing here calls an AI model, and the hub always answers with an empty 204,
so it can never change what Claude Code does.

Checked against Claude Code 2.1.310 and <https://code.claude.com/docs/en/hooks>.

## What you need

- The hub running (`pnpm dev` or `pnpm build && pnpm start` in the repo).
- The hub's private address: its Tailscale address (100.x.y.z) or home Wi-Fi
  address. Use `127.0.0.1` when Claude Code runs on the hub itself.
- The `INGEST_TOKEN` from the hub's `.env`.
- `curl` on the laptop (used only for the session-start event).

## Install on each laptop

1. Set two environment variables in your shell profile (`~/.zshrc` or similar),
   then open a new terminal:

   ```bash
   export AO_INGEST_TOKEN="paste the hub's INGEST_TOKEN here"
   export AO_DEVICE="work-laptop"   # letters, digits, dot, dash, underscore
   ```

2. Make a copy of the example with your hub address filled in. This writes a
   new file and changes nothing else:

   ```bash
   sed 's/HUB_ADDRESS/100.64.0.10/g' hooks.example.json > hooks.mine.json
   ```

3. Try it for one session first, without touching any settings file:

   ```bash
   claude --settings ./hooks.mine.json
   ```

   Use a tool, and the agent should appear on the dashboard within a second.

4. When you are happy, merge the `"hooks"` block from `hooks.mine.json` into
   one of these yourself. Keep any hooks you already have: add these entries
   next to them.

   - `~/.claude/settings.json` for every project on this laptop
   - `<project>/.claude/settings.local.json` for one project only

   Then run `/hooks` inside Claude Code to confirm they are listed.

To remove it, delete those entries again.

## Why the hub address is not an environment variable

Claude Code only substitutes environment variables in HTTP hook **headers**
(and only those listed in `allowedEnvVars`). Substitution in `url` is not
documented, so the address is written into your copy of the file in step 2.
The token and device name do come from the environment and are never written
to disk by these steps.

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

## If the hub is off

- Hub program stopped, machine still on: the connection is refused at once.
  Claude Code logs a non-blocking hook error and carries on. No delay.
- Hub machine off or unreachable: each event waits up to the 2-second timeout,
  then Claude Code carries on. Tools still run, but each one can feel up to a
  few seconds slower until the hub is back. Remove the hooks or bring the hub
  back if that bothers you.

Events sent while the hub is off are lost. That is by design.

## What leaves the laptop

Claude Code sends its full hook payload, which includes prompts, tool input and
tool output, to the hub over your private network. The hub reads only an
allow-list of fields and never writes the rest to disk or logs.

What the hub keeps depends on `CAPTURE_DETAIL` in its `.env`:

- `true` (default): your prompt text, shell commands, search patterns, URLs and
  subagent tasks are stored, trimmed (prompts to 1000 characters, tool input to
  500) with likely secrets (API keys, tokens, passwords) replaced by
  `[redacted]`. This is what the Live activity log shows.
- `false`: only fixed summaries such as "Bash tool started" are stored.

In both modes tool output, the AI's replies, file contents and transcript
paths are never stored. Stored text is deleted with its event after
`EVENT_RETENTION_DAYS`.

Plain HTTP is not encrypted, so only use a network you trust: Tailscale
encrypts the traffic; on home Wi-Fi anyone on the network could read it.

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

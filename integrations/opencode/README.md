# OpenCode → Agent Observatory

A single-file OpenCode plugin posts lifecycle events to the hub at
`/ingest/opencode`. It builds its own small payload: event name, session ID,
project folder, tool name, call ID, file path and model. Tool output and
prompts are never put in it. A tool start also carries a short description of what
the tool was asked to do (command, search pattern), which the hub keeps only
when `CAPTURE_DETAIL` is on. Every post is fire-and-forget with a
2-second limit, so the hub being off does not slow OpenCode down.

Written for and tested on OpenCode 2.2.1. OpenCode 1 is not supported.

## Install on each laptop

1. Copy the plugin into OpenCode's global plugin folder:

   ```bash
   cp agent-observatory.js ~/.config/opencode/plugins/
   ```

2. Tell it where the hub is. Either set environment variables:

   ```bash
   export AO_INGEST_TOKEN="paste the hub's INGEST_TOKEN here"
   export AO_DEVICE="work-laptop"
   export AO_HUB_URL="https://your-app.vercel.app"   # default http://127.0.0.1:4318
   ```

   or write `~/.config/agent-observatory/config.json` and make it readable by
   you only (`chmod 600`):

   ```json
   { "hubUrl": "https://your-app.vercel.app", "token": "…", "device": "work-laptop" }
   ```

   Environment variables win. Prefer the file: OpenCode runs a background
   service that may have been started without your shell's variables.

With no token or device name the plugin does nothing.

To remove it, delete `~/.config/opencode/plugins/agent-observatory.js`.

## What is reported

| OpenCode source | Hub event |
| --- | --- |
| `session.hook("prompt")` | prompt submitted |
| `tool.hook("execute.before")` | tool started |
| `tool.hook("execute.after")` | tool finished, or tool failed when `status` is `error` |
| `session.execution.succeeded` / `failed` / `interrupted` | turn ended |
| `permission.asked` | permission requested |
| `session.created` / `session.deleted` | session started / ended |

The model is shown as `providerID/modelID`, for example `opencode/big-pickle`.
It comes from `session.get` and from `session.step.started`.

Checked with real `opencode run` sessions: prompt, tool start and finish, turn
end, model and project. Not seen in those runs, so handled from the event
names only: `permission.asked`, `session.created`, `session.deleted`, failed
and interrupted turns.

## Limits

- A child session (a subagent) shows as its own separate agent. It is not
  linked to its parent.
- A session is only marked ended when OpenCode deletes it. Otherwise it stays
  idle and is flagged stale after 5 minutes without events.

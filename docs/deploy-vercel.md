# Deploy to Vercel

One Vercel project serves the dashboard **and** receives events from your
agents, so you can watch from anywhere without `pnpm dev` or a machine left on.
Events are stored in a [Turso](https://turso.tech) database (SQLite in the
cloud), because a Vercel function forgets everything between requests.

```
laptop hooks ──HTTPS──▶ https://<app>.vercel.app/ingest/claude ─┐
                                                                 ├─▶ Turso
browser ──▶ https://<app>.vercel.app  (pages, /api/*, stream) ───┘
```

`pnpm dev` still works exactly as before, using a local SQLite file.

## 1. Create the database

With the [Turso CLI](https://docs.turso.tech/cli/installation) (or the Turso
integration in the Vercel Marketplace, which sets the two variables for you):

```bash
turso auth login
turso db create observatory           # choose a location near your Vercel region
turso db show observatory --url       # -> DATABASE_URL, starts with libsql://
turso db tokens create observatory    # -> DATABASE_AUTH_TOKEN
```

## 2. Create the Vercel project

1. Import the GitHub repository at <https://vercel.com/new>.
2. Set **Root Directory** to `apps/web`. Leave "Include source files outside of
   the Root Directory" on (the default), since the app uses `packages/core` and
   `packages/shared`.
3. Leave the framework as Next.js. The project's `vercel-build` script applies
   database migrations, then builds, so schema changes ship with a deploy.

## 3. Set environment variables

Project Settings → Environment Variables. Use the **Production** scope.

| Name | Value |
| --- | --- |
| `DATABASE_URL` | `libsql://…` from step 1 |
| `DATABASE_AUTH_TOKEN` | token from step 1 |
| `INGEST_TOKEN` | `openssl rand -hex 32`. Every agent machine uses this. |
| `VIEWER_PASSWORD` | your dashboard password, 8+ characters. Make it strong: the site is public. |
| `CRON_SECRET` | `openssl rand -hex 32`. Lets the daily cleanup job run. |
| `SESSION_SECRET` | optional, `openssl rand -hex 32`. Change it to log everyone out. |
| `CAPTURE_DETAIL` | optional, `false` keeps your prompts and shell commands out of the cloud. |
| `EVENT_RETENTION_DAYS` | optional, default 30 |

Do not give Preview deployments the production `DATABASE_URL`: every build runs
migrations, and a preview would then write into your real data. Give previews
their own Turso database, or leave the variables unset (the preview builds but
cannot serve data).

## 4. Deploy and check

Deploy, then, with your own address and token:

```bash
curl -i -X POST https://<app>.vercel.app/ingest/claude -d '{}'                # 401
curl -i -X POST https://<app>.vercel.app/ingest/claude -d '{}' \
  -H "Authorization: Bearer $AO_INGEST_TOKEN" -H "X-Device: check"            # 400 = token accepted
```

Open `https://<app>.vercel.app`, log in, and run a demo from your own machine:

```bash
AO_HUB_URL=https://<app>.vercel.app INGEST_TOKEN=… pnpm simulate
```

Choose **Demo** on the dashboard to see it.

## 5. Connect your agents

On every machine where you use Claude Code, follow
[integrations/claude-code/README.md](../integrations/claude-code/README.md):
set `AO_INGEST_TOKEN` and `AO_DEVICE`, then run
`integrations/claude-code/install.sh https://<app>.vercel.app`.
For OpenCode, see [integrations/opencode/README.md](../integrations/opencode/README.md)
and set `AO_HUB_URL` to the same address.

## Things to know

- **Live updates** use a stream that checks Turso about once a second and
  reconnects by itself every ~4.5 minutes (the function time limit). A tab you
  leave open keeps one function running, so close dashboards you are not
  watching if you are on the Hobby plan's usage limits.
- **Cleanup** runs daily at 03:00 UTC through Vercel Cron
  (`apps/web/vercel.json`) and deletes events older than `EVENT_RETENTION_DAYS`.
  It needs `CRON_SECRET`.
- **Cold starts**: after a quiet period the first hook call takes a little
  longer. Hooks time out after 2 seconds and never block Claude Code.
- **Login rate limit** is counted per running instance, so it is a speed bump,
  not a hard lock. That is why the password should be strong.
- **Plain `http://`** is only for `127.0.0.1`; Vercel serves HTTPS.
- **Rotating the token**: change `INGEST_TOKEN` on Vercel, redeploy, then update
  `AO_INGEST_TOKEN` on each machine.

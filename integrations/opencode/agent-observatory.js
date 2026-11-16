// Agent Observatory sender for OpenCode 2.
//
// Copy this file to ~/.config/opencode/plugins/ (see README.md next to it).
// It posts a small, fixed set of fields to the hub. Tool output and prompts are
// never read into the payload. For a tool start it also sends a short
// description of what the tool was asked to do (a command, a search pattern),
// which the hub keeps only when it runs with CAPTURE_DETAIL on and always
// masks and trims. Every call is fire-and-forget
// with a 2 second limit, so the hub being off cannot slow OpenCode down.
//
// Event and hook shapes were observed on OpenCode 2.2.1.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const CONFIG_FILE = join(homedir(), ".config", "agent-observatory", "config.json");
const POST_TIMEOUT_MS = 2000;
const MAX_SESSIONS = 256;

/** Environment variables win. The file is for OpenCode's background service, which may not see them. */
function readSettings() {
  let file = {};
  try {
    file = JSON.parse(readFileSync(CONFIG_FILE, "utf8")) || {};
  } catch {
    // No file is normal when the environment variables are used.
  }
  const hubUrl = process.env.AO_HUB_URL || file.hubUrl || "http://127.0.0.1:4318";
  const token = process.env.AO_INGEST_TOKEN || file.token || "";
  const device = process.env.AO_DEVICE || file.device || "";
  return token && device ? { url: `${String(hubUrl).replace(/\/+$/, "")}/ingest/opencode`, token, device } : null;
}

const modelLabel = (model) =>
  model && typeof model.id === "string" ? (model.providerID ? `${model.providerID}/${model.id}` : model.id) : undefined;

export default {
  id: "agent-observatory",
  async setup(ctx) {
    const noop = () => {};
    const settings = readSettings();
    if (!settings) return noop;
    if (!ctx || typeof ctx.event?.subscribe !== "function") return noop;

    /** sessionID -> { cwd, model } */
    const sessions = new Map();
    const remember = (sessionID, patch) => {
      if (!sessions.has(sessionID) && sessions.size >= MAX_SESSIONS) {
        sessions.delete(sessions.keys().next().value);
      }
      const next = { ...sessions.get(sessionID), ...patch };
      sessions.set(sessionID, next);
      return next;
    };
    const lookup = async (sessionID) => {
      const known = sessions.get(sessionID);
      if (known?.cwd) return known;
      let patch = { cwd: ctx.location?.directory };
      try {
        const info = await ctx.session.get({ sessionID });
        patch = {
          cwd: info?.location?.directory || patch.cwd,
          model: known?.model || modelLabel(info?.model),
        };
      } catch {
        // Fall back to this plugin instance's own folder.
      }
      return remember(sessionID, patch);
    };

    const send = async (event, sessionID, fields = {}) => {
      if (typeof sessionID !== "string" || !sessionID) return;
      try {
        const session = await lookup(sessionID);
        const body = { event, session_id: sessionID, cwd: session.cwd, model: session.model, ...fields };
        await fetch(settings.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.token}`,
            "X-Device": settings.device,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
      } catch {
        // The hub is optional. Never let it affect OpenCode.
      }
    };

    const filePathOf = async (sessionID, input) => {
      const raw = input?.path ?? input?.filePath ?? input?.file_path;
      if (typeof raw !== "string" || !raw || raw.length > 1024) return undefined;
      if (isAbsolute(raw)) return raw;
      const { cwd } = await lookup(sessionID);
      return cwd ? resolve(cwd, raw) : undefined;
    };

    /** A short description of what a tool was asked to do. File tools send none: their path is sent already. */
    const inputTextOf = (input) => {
      for (const key of ["command", "pattern", "query", "url", "description"]) {
        const value = input?.[key];
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 500);
      }
      return undefined;
    };

    const registrations = [];
    const hook = async (target, name, callback) => {
      try {
        // Hooks get an editable draft. Nothing here changes it or waits on the hub.
        registrations.push(await target.hook(name, (event) => void callback(event).catch(noop)));
      } catch {
        // An OpenCode version without this hook still reports the other events.
      }
    };

    if (typeof ctx.session?.hook === "function") {
      await hook(ctx.session, "prompt", async (e) => send("prompt", e?.sessionID, { message_id: e?.messageID }));
    }
    if (typeof ctx.tool?.hook === "function") {
      await hook(ctx.tool, "execute.before", async (e) =>
        send("tool_start", e?.sessionID, {
          tool: e?.tool,
          call_id: e?.id,
          file_path: await filePathOf(e?.sessionID, e?.input),
          input_text: inputTextOf(e?.input),
        }),
      );
      await hook(ctx.tool, "execute.after", async (e) =>
        send("tool_end", e?.sessionID, {
          tool: e?.tool,
          call_id: e?.id,
          status: e?.status === "error" ? "error" : "completed",
          file_path: await filePathOf(e?.sessionID, e?.input),
        }),
      );
    }

    const TURN_END = {
      "session.execution.succeeded": "succeeded",
      "session.execution.failed": "failed",
      "session.execution.interrupted": "interrupted",
    };
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const e of ctx.event.subscribe({ signal: controller.signal })) {
          const data = e?.data || {};
          const sessionID = data.sessionID;
          if (e.type === "session.step.started") {
            const model = modelLabel(data.model);
            if (sessionID && model) remember(sessionID, { model });
          } else if (TURN_END[e.type]) {
            void send("turn_end", sessionID, { status: TURN_END[e.type], event_id: e.id });
          } else if (e.type === "permission.asked") {
            void send("permission", sessionID, { tool: data.action, event_id: e.id });
          } else if (e.type === "session.created") {
            void send("session_start", sessionID, { event_id: e.id });
          } else if (e.type === "session.deleted") {
            void send("session_end", sessionID, { event_id: e.id });
            sessions.delete(sessionID);
          }
        }
      } catch {
        // The stream ends when the plugin is unloaded.
      }
    })();

    return () => {
      controller.abort();
      for (const r of registrations) {
        try {
          if (typeof r === "function") r();
          else if (typeof r?.dispose === "function") r.dispose();
        } catch {
          // Nothing to clean up.
        }
      }
    };
  },
};

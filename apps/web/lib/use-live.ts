"use client";

import { useEffect, useRef, useState } from "react";
import {
  StreamMessageSchema,
  type Agent,
  type Device,
  type Overview,
  type StoredEvent,
} from "@ao/shared";
import { hardNavigate } from "@/lib/nav";

export type Connection = "loading" | "live" | "reconnecting" | "error";

export interface LiveState {
  agents: Agent[];
  events: StoredEvent[];
  devices: Device[];
  connection: Connection;
  /** Hub clock minus this browser's clock, so "stale" uses the hub's time. */
  clockOffsetMs: number;
}

const MAX_EVENTS = 300;
const RETRY_MS = 2000;

function toLogin(): void {
  hardNavigate("/login");
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (res.status === 401) {
    toLogin();
    throw new Error("unauthorized");
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * First load over REST, then live updates over SSE.
 * Reconnects by itself and asks the hub to replay what was missed.
 */
export function useLive(demo: boolean): LiveState {
  const [state, setState] = useState<LiveState>({
    agents: [],
    events: [],
    devices: [],
    connection: "loading",
    clockOffsetMs: 0,
  });
  const lastId = useRef<number | null>(null);

  useEffect(() => {
    const q = demo ? "demo=1&" : "";
    const abort = new AbortController();
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const retry = (fn: () => void) => {
      if (closed) return;
      setState((s) => ({ ...s, connection: s.connection === "loading" ? "error" : "reconnecting" }));
      timer = setTimeout(fn, RETRY_MS);
    };

    const openStream = () => {
      if (closed) return;
      const from = lastId.current ?? 0;
      source = new EventSource(`/api/stream?${q}lastEventId=${from}`);
      source.onopen = () => setState((s) => ({ ...s, connection: "live" }));
      source.addEventListener("activity", (raw) => {
        const parsed = StreamMessageSchema.safeParse(JSON.parse((raw as MessageEvent<string>).data));
        if (!parsed.success) return;
        const { event, agents } = parsed.data;
        if (lastId.current !== null && event.id <= lastId.current) return;
        lastId.current = event.id;
        setState((s) => {
          const byId = new Map(s.agents.map((a) => [a.id, a]));
          for (const a of agents) byId.set(a.id, a);
          const devices = s.devices.some((d) => d.id === event.deviceId)
            ? s.devices
            : [
                ...s.devices,
                {
                  id: event.deviceId,
                  name: event.deviceName,
                  isDemo: event.isDemo,
                  firstSeenAt: event.receivedAt,
                  lastEventAt: event.receivedAt,
                },
              ];
          return {
            ...s,
            agents: [...byId.values()],
            events: [event, ...s.events].slice(0, MAX_EVENTS),
            devices,
          };
        });
      });
      // The server ends each stream a little before its hosting time limit.
      // Reopen at once from where we stopped, without showing "reconnecting".
      source.addEventListener("reconnect", () => {
        source?.close();
        source = null;
        openStream();
      });
      source.onerror = () => {
        // Close and reopen ourselves so the replay point is always our own lastId.
        source?.close();
        source = null;
        retry(() => {
          fetch("/api/auth/me", { cache: "no-store" })
            .then((res) => (res.status === 401 ? toLogin() : openStream()))
            .catch(() => retry(openStream));
        });
      };
    };

    const load = async () => {
      try {
        const [overview, agents, events] = await Promise.all([
          getJson<Overview>(`/api/overview?${q}`, abort.signal),
          getJson<Agent[]>(`/api/agents?${q}limit=500`, abort.signal),
          getJson<StoredEvent[]>(`/api/events?${q}limit=100`, abort.signal),
        ]);
        if (closed) return;
        lastId.current = Math.max(overview.latestEventId ?? 0, events[0]?.id ?? 0);
        setState({
          agents,
          events,
          devices: overview.devices,
          connection: "loading",
          clockOffsetMs: overview.serverTime - Date.now(),
        });
        openStream();
      } catch {
        if (!abort.signal.aborted) retry(() => void load());
      }
    };
    void load();

    return () => {
      closed = true;
      abort.abort();
      source?.close();
      if (timer) clearTimeout(timer);
    };
  }, [demo]);

  return state;
}

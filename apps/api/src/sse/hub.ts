import type { Response } from 'express';
import { SSE_HEARTBEAT_MS, type StreamMessage } from '@ao/shared';

interface Client {
  res: Response;
  demo: boolean;
}

export function formatSse(message: StreamMessage): string {
  return `id: ${message.event.id}\nevent: activity\ndata: ${JSON.stringify(message)}\n\n`;
}

/** Fans stored events out to every open dashboard. Holds no history itself. */
export class SseHub {
  private readonly clients = new Set<Client>();
  private timer: NodeJS.Timeout | null = null;

  get size(): number {
    return this.clients.size;
  }

  add(res: Response, demo: boolean): () => void {
    const client: Client = { res, demo };
    this.clients.add(client);
    const remove = () => {
      this.clients.delete(client);
    };
    res.on('close', remove);
    res.on('error', remove);
    return remove;
  }

  /** Demo events only reach demo viewers, and real events only real viewers. */
  broadcast(message: StreamMessage): void {
    const frame = formatSse(message);
    for (const client of this.clients) {
      if (client.demo !== message.event.isDemo) continue;
      this.write(client, frame);
    }
  }

  startHeartbeat(intervalMs = SSE_HEARTBEAT_MS): void {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      for (const client of this.clients) this.write(client, ': heartbeat\n\n');
    }, intervalMs);
    this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  closeAll(): void {
    this.stopHeartbeat();
    for (const client of this.clients) client.res.end();
    this.clients.clear();
  }

  private write(client: Client, frame: string): void {
    if (client.res.writableEnded || client.res.destroyed) {
      this.clients.delete(client);
      return;
    }
    try {
      client.res.write(frame);
    } catch {
      this.clients.delete(client);
    }
  }
}

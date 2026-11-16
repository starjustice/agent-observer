import type { StreamMessage } from '@ao/shared';

export function formatSse(message: StreamMessage): string {
  return `id: ${message.event.id}\nevent: activity\ndata: ${JSON.stringify(message)}\n\n`;
}

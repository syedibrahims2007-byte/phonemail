// src/lib/events.ts
//
// In-process pub/sub used to push live updates to connected browsers over SSE.
// Deliberately not Redis pub/sub: there is a single server process today, and a
// broker would only add a failure mode. If this is ever scaled horizontally the
// Map has to be replaced with a shared channel - the subscribe/publish surface
// is small enough that swapping the transport will not touch any caller.
import type { Response } from 'express';

const channels = new Map<string, Set<Response>>();

export function subscribe(accountId: string, res: Response): () => void {
  let set = channels.get(accountId);
  if (!set) {
    set = new Set();
    channels.set(accountId, set);
  }
  set.add(res);

  return () => {
    const current = channels.get(accountId);
    if (!current) return;
    current.delete(res);
    if (!current.size) channels.delete(accountId);
  };
}

export function publish(accountId: string, event: string, data: unknown): void {
  const subs = channels.get(accountId);
  if (!subs || !subs.size) return;

  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of subs) {
    try {
      res.write(frame);
    } catch {
      // The socket died between the liveness check and the write. The close
      // handler will clean it up; there is nothing useful to do here.
    }
  }
}

export function subscriberCount(accountId: string): number {
  const set = channels.get(accountId);
  return set ? set.size : 0;
}

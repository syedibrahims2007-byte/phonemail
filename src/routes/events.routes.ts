// src/routes/events.routes.ts
import { Router } from 'express';
import { authMiddleware } from './auth.routes';
import { subscribe } from '../lib/events';

const router = Router();

// The stream is per-account, so it needs a session just like every other route.
router.use(authMiddleware);

/**
 * Server-sent events feed.
 *
 * Consuming this with EventSource() is not possible here because EventSource
 * cannot send an Authorization header, and putting a bearer token in the query
 * string would leak it into access logs and referrers. The UI therefore reads
 * the stream with fetch() and parses the frames itself.
 */
router.get('/', (req: any, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    // Tell nginx not to buffer, which would otherwise hold frames indefinitely.
    'X-Accel-Buffering': 'no',
  });
  if (typeof (res as any).flushHeaders === 'function') (res as any).flushHeaders();

  // Client-side reconnect delay.
  res.write('retry: 3000\n\n');
  res.write(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

  const unsubscribe = subscribe(req.account.id, res);

  // Comment frames keep intermediaries from reaping an idle connection.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* closed */ }
  }, 25000);

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };

  req.on('close', cleanup);
  res.on('close', cleanup);
});

export default router;

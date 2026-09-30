// src/routes/messages.routes.ts
import { Router } from 'express';
import { authMiddleware } from './auth.routes';
import {
  listThreads,
  listMessages,
  sendText,
  sendToThread,
  updateThread,
  deleteThread,
  markThreadRead,
  simulateInbound,
  isDevMode,
  SMS_MAX_BODY,
} from '../services/messages';

const router = Router();

// Every route requires a session.
router.use(authMiddleware);

const ERRORS: Record<string, { status: number; error: string }> = {
  INVALID_PHONE_NUMBER: { status: 400, error: 'INVALID_PHONE_NUMBER' },
  MESSAGE_EMPTY: { status: 400, error: 'MESSAGE_EMPTY' },
  MESSAGE_TOO_LONG: { status: 400, error: 'MESSAGE_TOO_LONG' },
  THREAD_NOT_FOUND: { status: 404, error: 'THREAD_NOT_FOUND' },
  RATE_LIMITED: { status: 429, error: 'RATE_LIMITED' },
  SEND_FAILED: { status: 502, error: 'SEND_FAILED' },
  DEV_MODE_ONLY: { status: 403, error: 'DEV_MODE_ONLY' },
};

function fail(res: any, error: any) {
  const mapped = ERRORS[error?.message];
  if (mapped) return res.status(mapped.status).json({ error: mapped.error });
  console.error('Messages route error:', error);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}

// List conversations
router.get('/threads', async (req: any, res) => {
  try {
    const threads = await listThreads(req.account.id, {
      includeArchived: req.query.includeArchived === 'true',
    });
    res.json({ threads, limits: { maxBodyLength: SMS_MAX_BODY }, devMode: isDevMode() });
  } catch (error: any) {
    fail(res, error);
  }
});

// Send a text. Creates the conversation on first use.
router.post('/send', async (req: any, res) => {
  try {
    const { to, body } = req.body;
    if (!to) return res.status(400).json({ error: 'TO_REQUIRED' });
    if (!body) return res.status(400).json({ error: 'MESSAGE_EMPTY' });

    const message = await sendText(req.account.id, to, body);
    res.status(201).json({ message });
  } catch (error: any) {
    fail(res, error);
  }
});

// Send into an existing conversation
router.post('/threads/:id/send', async (req: any, res) => {
  try {
    const { body } = req.body;
    if (!body) return res.status(400).json({ error: 'MESSAGE_EMPTY' });

    const message = await sendToThread(req.account.id, req.params.id, body);
    res.status(201).json({ message });
  } catch (error: any) {
    fail(res, error);
  }
});

// Read one conversation
router.get('/threads/:id', async (req: any, res) => {
  try {
    const result = await listMessages(req.account.id, req.params.id, {
      before: req.query.before,
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
    });
    res.json(result);
  } catch (error: any) {
    fail(res, error);
  }
});

// Rename / archive / unarchive
router.patch('/threads/:id', async (req: any, res) => {
  try {
    const { label, archived } = req.body;
    const thread = await updateThread(req.account.id, req.params.id, { label, archived });
    res.json({ thread });
  } catch (error: any) {
    fail(res, error);
  }
});

// Delete a conversation and all of its messages
router.delete('/threads/:id', async (req: any, res) => {
  try {
    await deleteThread(req.account.id, req.params.id);
    res.json({ success: true });
  } catch (error: any) {
    fail(res, error);
  }
});

// Clear the unread badge
router.post('/threads/:id/read', async (req: any, res) => {
  try {
    const cleared = await markThreadRead(req.account.id, req.params.id);
    res.json({ success: true, cleared });
  } catch (error: any) {
    fail(res, error);
  }
});

// Dev-only: pretend the carrier delivered a reply, so the conversation can be
// exercised end to end without a real inbound number. Rejected in production.
router.post('/threads/:id/simulate-inbound', async (req: any, res) => {
  try {
    if (!isDevMode()) return res.status(403).json({ error: 'DEV_MODE_ONLY' });
    const message = await simulateInbound(req.account.id, req.params.id, req.body?.body);
    res.status(201).json({ message });
  } catch (error: any) {
    fail(res, error);
  }
});

export default router;
